// ============================================================================
// C 盘全盘变化分析模块
//
// 全盘变化只负责定位空间增减来源，不提供删除能力，避免把“变化目录”误当成“可清理目录”。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  HardDrive,
  Loader2,
  Minus,
  Search,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { EmptyState } from '../EmptyState';
import { useDashboard } from '../../contexts/DashboardContext';
import { useSettings } from '../../contexts';
import {
  checkAdminPrivilege,
  openInFolder,
  scanDiskGrowth,
  type DiskGrowthAnalyzeEntry,
  type DiskGrowthEntry,
  type DiskGrowthPhaseDuration,
  type DiskGrowthReport,
  type DiskGrowthScanProgress,
  type DiskGrowthScanResponse,
} from '../../api/commands';
import { formatSize } from '../../utils/format';

function simplifyPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `.../${parts.slice(-3).join('/')}`;
}

function formatDiff(diff: number): string {
  const sign = diff >= 0 ? '+' : '-';
  return `${sign}${formatSize(Math.abs(diff))}`;
}

function formatProgressCount(progress: DiskGrowthScanProgress | null): string {
  if (!progress) return '';
  const processed = progress.processed.toLocaleString();
  if (typeof progress.total === 'number' && progress.total > 0) {
    return `${processed} / ${progress.total.toLocaleString()}`;
  }
  return processed;
}

function getPhaseLabel(stage: string): string {
  switch (stage) {
    case 'mft':
      return '枚举 MFT';
    case 'path':
      return '重建路径';
    case 'metadata':
      return '读取大小';
    case 'aggregate':
      return '聚合目录';
    default:
      return '扫描中';
  }
}

function formatPhaseDurations(phases: DiskGrowthPhaseDuration[]): string {
  if (!phases.length) return '';
  return phases
    .map((phase) => `${getPhaseLabel(phase.stage)} ${(phase.duration_ms / 1000).toFixed(1)}s`)
    .join(' · ');
}

function formatPreviousScanTime(scanSummary: DiskGrowthScanResponse): string {
  return scanSummary.previous_scan_time || '暂无历史快照';
}

function getGrowthStyle(level: DiskGrowthEntry['level']) {
  switch (level) {
    case 'significant':
      return { icon: TrendingUp, color: 'text-red-500', label: '显著增长' };
    case 'fast':
      return { icon: TrendingUp, color: 'text-orange-500', label: '快速增长' };
    case 'minor':
      return { icon: TrendingUp, color: 'text-amber-500', label: '轻微增长' };
    case 'decreased':
      return { icon: TrendingDown, color: 'text-green-500', label: '已减少' };
    case 'new':
      return { icon: Sparkles, color: 'text-blue-500', label: '新增目录' };
    default:
      return { icon: Minus, color: 'text-[var(--text-faint)]', label: '稳定' };
  }
}

function SummaryCards({
  scanSummary,
  growthReport,
}: {
  scanSummary: DiskGrowthScanResponse;
  growthReport: DiskGrowthReport;
}) {
  const totalGrowth = growthReport.total_growth;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div className="bg-[var(--bg-main)] rounded-xl px-4 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1">C 盘已索引占用</p>
        <p className="text-lg font-bold text-[var(--text-primary)] tabular-nums">
          {formatSize(scanSummary.total_size)}
        </p>
      </div>
      <div className="bg-[var(--bg-main)] rounded-xl px-4 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1">与上次净变化</p>
        <p
          className={`text-lg font-bold tabular-nums ${
            totalGrowth > 0
              ? 'text-red-500'
              : totalGrowth < 0
                ? 'text-green-500'
                : 'text-[var(--text-muted)]'
          }`}
        >
          {totalGrowth === 0 ? '暂无变化' : formatDiff(totalGrowth)}
        </p>
      </div>
      <div className="bg-[var(--bg-main)] rounded-xl px-4 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1">上次扫描</p>
        <p className="text-sm font-semibold text-[var(--text-primary)] tabular-nums truncate">
          {formatPreviousScanTime(scanSummary)}
        </p>
      </div>
      <div className="bg-[var(--bg-main)] rounded-xl px-4 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1">扫描文件数</p>
        <p className="text-lg font-bold text-[var(--brand-green)] tabular-nums">
          {scanSummary.total_files_scanned.toLocaleString()}
        </p>
      </div>
      {growthReport.entries.length > 0 && (
        <div className="col-span-4 flex items-center gap-3 text-[12px] text-[var(--text-muted)]">
          <span className="text-red-500">新增 {formatSize(scanSummary.analyze.increased_size ?? 0)}</span>
          <span className="text-green-500">减少 {formatSize(scanSummary.analyze.decreased_size ?? 0)}</span>
          <span>按变化量排序，最多展示 300 个目录</span>
        </div>
      )}
    </div>
  );
}

function DiagnosticBanner({ report }: { report: DiskGrowthReport }) {
  const hasGrowth = report.significant_count > 0 || report.fast_count > 0;

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-xl text-[13px] ${
        hasGrowth
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-[var(--brand-green-10)] text-[var(--brand-green)]'
      }`}
    >
      {hasGrowth ? (
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      ) : (
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
      )}
      <span>{report.summary}</span>
    </div>
  );
}

function entryFromGrowth(growth: DiskGrowthEntry): DiskGrowthAnalyzeEntry {
  return {
    path: growth.path,
    size: growth.new_size,
    category: '变化目录',
    risk: 'safe',
    action: 'ignore',
    reason: growth.explanation,
    suggestion: growth.suggestion,
    matched_rule_id: null,
    tags: [],
  };
}

function ChangeRow({
  entry,
  growth,
  onOpenFolder,
  onSearchPath,
}: {
  entry: DiskGrowthAnalyzeEntry;
  growth: DiskGrowthEntry | null;
  onOpenFolder: (path: string) => void;
  onSearchPath: (path: string) => void;
}) {
  const style = growth ? getGrowthStyle(growth.level) : getGrowthStyle('stable');
  const Icon = style.icon;
  const diff = growth?.diff ?? 0;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-hover)] transition-colors group">
      <div
        className={`w-1.5 h-8 rounded-full shrink-0 ${
          diff > 0 ? 'bg-red-400' : diff < 0 ? 'bg-green-400' : 'bg-gray-300'
        }`}
      />

      <div className="flex-1 min-w-0">
        <p
          className="text-[13px] text-[var(--text-primary)] truncate cursor-pointer hover:text-[var(--brand-green)] transition-colors"
          title={entry.path}
          onClick={() => onOpenFolder(entry.path)}
        >
          {simplifyPath(entry.path)}
        </p>
        <p className="text-[11px] text-[var(--text-faint)] mt-0.5 truncate">
          {growth?.explanation ?? entry.reason}
        </p>
      </div>

      <span className="px-2 py-0.5 rounded text-[11px] bg-[var(--bg-hover)] text-[var(--text-muted)] shrink-0">
        {entry.category}
      </span>

      <span className={`flex items-center gap-1 w-24 justify-end text-[12px] shrink-0 ${style.color}`}>
        <Icon className="w-3.5 h-3.5" />
        {style.label}
      </span>

      <span className="text-[13px] font-medium text-[var(--text-primary)] tabular-nums w-20 text-right shrink-0">
        {formatSize(entry.size)}
      </span>

      <span className={`text-[13px] font-medium tabular-nums w-24 text-right shrink-0 ${style.color}`}>
        {diff === 0 ? '-' : formatDiff(diff)}
      </span>

      <div className="flex w-16 shrink-0 justify-end gap-0.5 opacity-0 transition group-hover:opacity-100">
        <button
          onClick={() => onSearchPath(entry.path)}
          className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] transition"
          title="搜索该路径有什么作用"
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          onClick={() => onOpenFolder(entry.path)}
          className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] transition"
          title="打开目录"
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function DiskGrowthModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useDashboard();
  const { settings } = useSettings();
  const moduleState = modules.diskGrowth;
  const lastScanTriggerRef = useRef(0);
  const scanningRef = useRef(false);

  const [scanSummary, setScanSummary] = useState<DiskGrowthScanResponse | null>(null);
  const [growthReport, setGrowthReport] = useState<DiskGrowthReport | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [scanElapsed, setScanElapsed] = useState(0);
  const [scanProgress, setScanProgress] = useState<DiskGrowthScanProgress | null>(null);

  const isExpanded = expandedModule === 'disk-growth';

  useEffect(() => {
    let cancelled = false;
    checkAdminPrivilege()
      .then((result) => {
        if (!cancelled) setIsAdmin(result);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (moduleState.status !== 'scanning') {
      setScanElapsed(0);
      return;
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setScanElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [moduleState.status]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    listen<DiskGrowthScanProgress>('disk-growth:progress', (event) => {
      if (!cancelled) setScanProgress(event.payload);
    }).then((handler) => {
      if (cancelled) {
        handler();
      } else {
        unlisten = handler;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleScan = useCallback(async () => {
    if (scanningRef.current) return;
    if (isAdmin === false) {
      const message = 'C 盘全盘分析需要管理员权限读取 MFT，请以管理员身份启动应用后再扫描。';
      setError(message);
      updateModuleState('diskGrowth', { status: 'error', error: message });
      return;
    }
    scanningRef.current = true;

    updateModuleState('diskGrowth', { status: 'scanning', error: null, fileCount: 0, totalSize: 0 });
    setError(null);
    setScanSummary(null);
    setGrowthReport(null);
    setScanProgress(null);
    setShowAll(false);

    try {
      const result = await scanDiskGrowth(settings.diskGrowthMaxEntries);
      setScanSummary(result);
      setGrowthReport(result.growth);
      updateModuleState('diskGrowth', {
        status: 'done',
        fileCount: result.growth.entries.length,
        totalSize: Math.abs(result.growth.total_growth),
      });
    } catch (err) {
      const message = String(err);
      setError(message);
      updateModuleState('diskGrowth', { status: 'error', error: message });
    } finally {
      scanningRef.current = false;
    }
  }, [isAdmin, settings.diskGrowthMaxEntries, updateModuleState]);

  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await openInFolder(path);
    } catch (err) {
      console.error('打开目录失败:', err);
    }
  }, []);

  const handleSearchPath = useCallback(async (path: string) => {
    try {
      // 变化目录不等于可清理目录，搜索文案先确认用途，再辅助判断是否可删。
      const query = encodeURIComponent(`Windows 路径 ${path} 是什么 有什么作用 可以删除吗`);
      await openUrl(`https://www.bing.com/search?q=${query}`);
    } catch (err) {
      console.error('搜索路径用途失败:', err);
    }
  }, []);

  const growthMap = useMemo(() => {
    const map = new Map<string, DiskGrowthEntry>();
    for (const entry of growthReport?.entries ?? []) {
      map.set(entry.path.toLowerCase().replace(/\\/g, '/'), entry);
    }
    return map;
  }, [growthReport]);

  const entries = growthReport?.entries.length
    ? growthReport.entries.map(entryFromGrowth)
    : scanSummary?.analyze.entries ?? [];
  const resultMode = growthReport?.entries.length ? 'change' : 'usage';
  const displayedEntries = showAll ? entries : entries.slice(0, 20);
  const hasMore = entries.length > displayedEntries.length;

  return (
    <ModuleCard
      id="disk-growth"
      title="C 盘全盘分析"
      description="基于 MFT 快速扫描 C 盘，对比上次快照定位空间变化来源"
      icon={<HardDrive className="w-5 h-5 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      countLabel="个变化目录"
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'disk-growth')}
      onScan={handleScan}
      scanButtonText="开始扫描"
      scanDisabled={isAdmin === false}
      error={error}
    >
      {isAdmin === false && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>当前未检测到管理员权限。MFT 全盘分析需要管理员权限，请以管理员身份启动 LightC 或运行开发命令。</span>
        </div>
      )}

      {moduleState.status === 'idle' && !scanSummary && !growthReport && (
        <div className="p-4">
          <EmptyState
            icon={HardDrive}
            title="尚未扫描 C 盘变化"
            description="点击开始扫描，建立 C 盘快照；再次扫描后会对比新增、减少和明显变化的目录。"
          />
        </div>
      )}

      {moduleState.status === 'scanning' && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--text-muted)]">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-green)] mb-3" />
          <p className="text-sm">{scanProgress?.message ?? '正在通过 MFT 扫描 C 盘...'}</p>
          <p className="text-xs text-[var(--text-muted)] mt-1 tabular-nums">
            已用时 {scanElapsed}s
          </p>
          {scanProgress && (
            <p className="text-xs text-[var(--text-faint)] mt-1 tabular-nums">
              {getPhaseLabel(scanProgress.stage)} {formatProgressCount(scanProgress)}
            </p>
          )}
          <p className="text-xs text-[var(--text-faint)] mt-1">
            首次扫描会建立快照，下次扫描开始展示新增和减少的目录
          </p>
        </div>
      )}

      {moduleState.status === 'done' && scanSummary && growthReport && (
        <div className="p-4 space-y-4">
          <SummaryCards scanSummary={scanSummary} growthReport={growthReport} />
          <DiagnosticBanner report={growthReport} />

          <div className="flex items-center justify-between">
            <p className="text-[13px] text-[var(--text-muted)]">
              共 {entries.length} 个目录结果，扫描耗时 {(scanSummary.scan_duration_ms / 1000).toFixed(1)}s
            </p>
            <span className="text-[12px] text-[var(--text-faint)]">
              引擎: {scanSummary.backend === 'mft' ? 'MFT' : scanSummary.backend}
              {isAdmin ? ' · 管理员' : ''}
            </span>
          </div>
          {scanSummary.phase_durations.length > 0 && (
            <p className="text-[12px] text-[var(--text-faint)]">
              阶段耗时：{formatPhaseDurations(scanSummary.phase_durations)}
            </p>
          )}
          <p className="text-[12px] text-[var(--text-faint)]">
            列表模式：
            {resultMode === 'change'
              ? `仅展示与上次快照相比发生变化的目录，按变化量绝对值排序，最多 ${settings.diskGrowthMaxEntries} 项`
              : '当前没有可展示的变化目录，暂时展示本次占用较大的目录作为基线参考'}
          </p>
          <p className="text-[12px] text-[var(--text-faint)]">
            大小来源：MFT {scanSummary.mft_size_count.toLocaleString()} 个，metadata 回退{' '}
            {scanSummary.metadata_fallback_count.toLocaleString()} 个
          </p>

          <div className="bg-[var(--bg-main)] rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-color)] text-[11px] text-[var(--text-faint)] uppercase tracking-wider">
              <div className="w-1.5 shrink-0" />
              <div className="flex-1">路径</div>
              <div className="w-16 shrink-0 text-center">分类</div>
              <div className="w-24 shrink-0 text-right">变化级别</div>
              <div className="w-20 shrink-0 text-right">当前大小</div>
              <div className="w-24 shrink-0 text-right">变化量</div>
              <div className="w-16 shrink-0" />
            </div>

            {displayedEntries.map((entry) => {
              const normalizedPath = entry.path.toLowerCase().replace(/\\/g, '/');
              return (
                <ChangeRow
                  key={entry.path}
                  entry={entry}
                  growth={growthMap.get(normalizedPath) ?? null}
                  onOpenFolder={handleOpenFolder}
                  onSearchPath={handleSearchPath}
                />
              );
            })}

            {hasMore && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full py-3 text-center text-[13px] text-[var(--brand-green)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                显示全部 {entries.length} 项
              </button>
            )}

            {entries.length === 0 && (
              <div className="p-4">
                <EmptyState
                  icon={HardDrive}
                  title="已建立首次快照"
                  description="下次扫描后会对比本次快照，并在这里显示新增、减少或明显变化的目录。"
                  tone="success"
                  compact
                />
              </div>
            )}
          </div>
        </div>
      )}
    </ModuleCard>
  );
}

export default DiskGrowthModule;
