// ============================================================================
// C 盘空间变化分析
//
// 对比本次 MFT 聚合结果和上一次快照，找出新增、减少和增长最快的目录。
// 这里只做变化分析，不做清理判断，避免把“能不能删”的语义误加到全盘目录上。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use super::mft_scan::{
    scan_system_drive_with_progress, DirSizeEntry, DiskGrowthPhaseDuration, DiskGrowthScanProgress,
};
use super::snapshot::{build_snapshot, DiskSnapshot, DiskSnapshotEntry, DiskSnapshotManager};

const SIGNIFICANT_THRESHOLD: i64 = 1024 * 1024 * 1024;
const FAST_THRESHOLD: i64 = 300 * 1024 * 1024;
// 小变化也需要进入列表，否则会出现汇总有净变化、明细变化量为空的割裂体验。
const MINOR_THRESHOLD: i64 = 1;
const DEFAULT_MAX_CHANGE_ENTRIES: usize = 300;
const MIN_CHANGE_ENTRIES: usize = 50;
const MAX_CHANGE_ENTRIES: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiskGrowthLevel {
    Significant,
    Fast,
    Minor,
    Stable,
    Decreased,
    New,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthEntry {
    pub path: String,
    pub old_size: u64,
    pub new_size: u64,
    pub diff: i64,
    pub diff_percent: f64,
    pub level: DiskGrowthLevel,
    pub explanation: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthReport {
    pub entries: Vec<DiskGrowthEntry>,
    pub total_growth: i64,
    pub significant_count: usize,
    pub fast_count: usize,
    pub new_count: usize,
    pub decreased_count: usize,
    pub time_span: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskAnalyzeEntry {
    pub path: String,
    pub size: u64,
    pub depth: u8,
    pub category: String,
    pub reason: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskAnalyzeResult {
    pub entries: Vec<DiskAnalyzeEntry>,
    pub changed_size: u64,
    pub increased_size: u64,
    pub decreased_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskScanAndAnalyzeResponse {
    pub total_size: u64,
    pub total_files_scanned: usize,
    pub scan_duration_ms: u64,
    pub root_path: String,
    pub previous_scan_time: Option<String>,
    pub current_scan_time: String,
    pub backend: String,
    pub phase_durations: Vec<DiskGrowthPhaseDuration>,
    pub mft_size_count: usize,
    pub metadata_fallback_count: usize,
    pub analyze: DiskAnalyzeResult,
    pub growth: DiskGrowthReport,
}

pub fn scan_and_analyze_system_drive_with_progress<F>(
    progress: &F,
    max_change_entries: Option<usize>,
) -> Result<DiskScanAndAnalyzeResponse, String>
where
    F: Fn(DiskGrowthScanProgress) + Sync,
{
    let max_change_entries = normalize_max_change_entries(max_change_entries);
    let manager = DiskSnapshotManager::new()?;
    let previous = manager.load_latest_snapshot()?;
    let previous_scan_time = previous.as_ref().map(|snapshot| snapshot.date.clone());
    let scan = scan_system_drive_with_progress(progress)?;
    let current_snapshot = build_snapshot(&scan);
    let growth = compare_snapshots(&current_snapshot, previous.as_ref(), max_change_entries);
    manager.save_snapshot(&current_snapshot)?;

    let analyze_entries = build_analyze_entries(&scan.entries, &growth);
    let increased_size = growth
        .entries
        .iter()
        .filter(|entry| entry.diff > 0)
        .map(|entry| entry.diff as u64)
        .sum();
    let decreased_size = growth
        .entries
        .iter()
        .filter(|entry| entry.diff < 0)
        .map(|entry| entry.diff.unsigned_abs())
        .sum();

    Ok(DiskScanAndAnalyzeResponse {
        total_size: scan.total_size,
        total_files_scanned: scan.total_files_scanned,
        scan_duration_ms: scan.scan_duration_ms,
        root_path: scan.root_path,
        previous_scan_time,
        current_scan_time: current_snapshot.date,
        backend: scan.backend,
        phase_durations: scan.phase_durations,
        mft_size_count: scan.mft_size_count,
        metadata_fallback_count: scan.metadata_fallback_count,
        analyze: DiskAnalyzeResult {
            entries: analyze_entries,
            changed_size: growth.total_growth.unsigned_abs(),
            increased_size,
            decreased_size,
        },
        growth,
    })
}

pub fn compare_snapshots(
    current: &DiskSnapshot,
    previous: Option<&DiskSnapshot>,
    max_change_entries: usize,
) -> DiskGrowthReport {
    let Some(previous) = previous else {
        return first_scan_report(current);
    };

    let current_map = snapshot_map(&current.entries);
    let previous_map = snapshot_map(&previous.entries);
    let mut all_paths: HashSet<String> = current_map.keys().cloned().collect();
    all_paths.extend(previous_map.keys().cloned());

    let mut entries: Vec<DiskGrowthEntry> = all_paths
        .into_iter()
        .filter_map(|path| {
            let old_size = previous_map.get(&path).copied().unwrap_or(0);
            let new_size = current_map.get(&path).copied().unwrap_or(0);
            create_growth_entry(path, old_size, new_size)
        })
        .collect();

    entries.sort_by(|left, right| {
        right
            .diff
            .abs()
            .cmp(&left.diff.abs())
            .then_with(|| left.path.cmp(&right.path))
    });
    entries.truncate(max_change_entries);

    let total_growth = current.total_size as i64 - previous.total_size as i64;
    let significant_count = entries
        .iter()
        .filter(|entry| entry.level == DiskGrowthLevel::Significant)
        .count();
    let fast_count = entries
        .iter()
        .filter(|entry| entry.level == DiskGrowthLevel::Fast)
        .count();
    let new_count = entries
        .iter()
        .filter(|entry| entry.level == DiskGrowthLevel::New)
        .count();
    let decreased_count = entries
        .iter()
        .filter(|entry| entry.level == DiskGrowthLevel::Decreased)
        .count();

    DiskGrowthReport {
        summary: build_summary(total_growth, significant_count, fast_count, decreased_count),
        entries,
        total_growth,
        significant_count,
        fast_count,
        new_count,
        decreased_count,
        time_span: format!("{} -> {}", previous.date, current.date),
    }
}

fn normalize_max_change_entries(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_MAX_CHANGE_ENTRIES)
        .clamp(MIN_CHANGE_ENTRIES, MAX_CHANGE_ENTRIES)
}

fn first_scan_report(current: &DiskSnapshot) -> DiskGrowthReport {
    DiskGrowthReport {
        entries: Vec::new(),
        total_growth: 0,
        significant_count: 0,
        fast_count: 0,
        new_count: 0,
        decreased_count: 0,
        time_span: "暂无历史快照".to_string(),
        summary: format!(
            "首次完成 C 盘快照，已记录 {} 个文件。下次扫描后会展示空间新增和减少的目录。",
            current.total_files_scanned
        ),
    }
}

fn snapshot_map(entries: &[DiskSnapshotEntry]) -> HashMap<String, u64> {
    entries
        .iter()
        .map(|entry| (entry.path.clone(), entry.size))
        .collect()
}

fn create_growth_entry(path: String, old_size: u64, new_size: u64) -> Option<DiskGrowthEntry> {
    let diff = new_size as i64 - old_size as i64;
    if diff == 0 {
        return None;
    }

    let level = determine_level(diff, old_size);
    if level == DiskGrowthLevel::Stable {
        return None;
    }

    let diff_percent = if old_size > 0 {
        diff as f64 / old_size as f64 * 100.0
    } else {
        100.0
    };
    let (explanation, suggestion) = explain_path(&path, diff, level);

    Some(DiskGrowthEntry {
        path,
        old_size,
        new_size,
        diff,
        diff_percent,
        level,
        explanation,
        suggestion,
    })
}

fn determine_level(diff: i64, old_size: u64) -> DiskGrowthLevel {
    if old_size == 0 && diff > 0 {
        DiskGrowthLevel::New
    } else if diff >= SIGNIFICANT_THRESHOLD {
        DiskGrowthLevel::Significant
    } else if diff >= FAST_THRESHOLD {
        DiskGrowthLevel::Fast
    } else if diff >= MINOR_THRESHOLD {
        DiskGrowthLevel::Minor
    } else if diff <= -MINOR_THRESHOLD {
        DiskGrowthLevel::Decreased
    } else {
        DiskGrowthLevel::Stable
    }
}

fn build_analyze_entries(
    scan_entries: &[DirSizeEntry],
    growth: &DiskGrowthReport,
) -> Vec<DiskAnalyzeEntry> {
    if growth.entries.is_empty() {
        return scan_entries
            .iter()
            .take(50)
            .map(|entry| DiskAnalyzeEntry {
                path: entry.path.clone(),
                size: entry.size,
                depth: entry.depth,
                category: classify_path(&entry.path),
                reason: "当前占用较大的目录".to_string(),
                suggestion: "下次扫描后会显示该目录的空间变化".to_string(),
            })
            .collect();
    }

    growth
        .entries
        .iter()
        .map(|entry| DiskAnalyzeEntry {
            path: entry.path.clone(),
            size: entry.new_size,
            depth: path_depth(&entry.path),
            category: classify_path(&entry.path),
            reason: entry.explanation.clone(),
            suggestion: entry.suggestion.clone(),
        })
        .collect()
}

fn explain_path(path: &str, diff: i64, level: DiskGrowthLevel) -> (String, String) {
    let lower_path = path.to_lowercase();
    let readable = format_size(diff.abs() as u64);
    let direction = if diff > 0 { "增加" } else { "减少" };

    if lower_path.contains("/windows/softwaredistribution") {
        (
            format!("Windows 更新缓存{}了 {}", direction, readable),
            "可在系统更新完成后通过 Windows 磁盘清理处理".to_string(),
        )
    } else if lower_path.contains("/users/") && lower_path.contains("/appdata/") {
        (
            format!("用户 AppData 目录{}了 {}", direction, readable),
            "建议展开对应用户目录，确认具体应用缓存来源".to_string(),
        )
    } else if lower_path.contains("/program files") || lower_path.contains("/program files (x86)") {
        (
            format!("程序安装目录{}了 {}", direction, readable),
            "通常与软件安装、更新或游戏资源变化有关，请谨慎处理".to_string(),
        )
    } else if lower_path.contains("/programdata") {
        (
            format!("ProgramData 后台数据{}了 {}", direction, readable),
            "可能来自系统组件、驱动或应用后台缓存".to_string(),
        )
    } else if lower_path.contains("cache") || lower_path.contains("temp") {
        (
            format!("缓存/临时目录{}了 {}", direction, readable),
            "可结合应用状态判断是否需要清理缓存".to_string(),
        )
    } else {
        let label = match level {
            DiskGrowthLevel::Significant => "显著变化",
            DiskGrowthLevel::Fast => "快速变化",
            DiskGrowthLevel::Minor => "轻微变化",
            DiskGrowthLevel::Decreased => "空间释放",
            DiskGrowthLevel::New => "新增目录",
            DiskGrowthLevel::Stable => "基本稳定",
        };
        (
            format!("{}，空间{} {}", label, direction, readable),
            "建议打开目录确认具体文件来源".to_string(),
        )
    }
}

fn classify_path(path: &str) -> String {
    let lower_path = path.to_lowercase();
    if lower_path.contains("/windows") {
        "Windows".to_string()
    } else if lower_path.contains("/users/") {
        "用户数据".to_string()
    } else if lower_path.contains("/program files") || lower_path.contains("/program files (x86)") {
        "程序目录".to_string()
    } else if lower_path.contains("/programdata") {
        "后台数据".to_string()
    } else if lower_path.contains("$recycle.bin") {
        "回收站".to_string()
    } else {
        "其他目录".to_string()
    }
}

fn build_summary(
    total_growth: i64,
    significant_count: usize,
    fast_count: usize,
    decreased_count: usize,
) -> String {
    if total_growth > 0 {
        format!(
            "相比上次扫描，C 盘净增加 {}。发现 {} 个显著增长目录、{} 个快速增长目录。",
            format_size(total_growth as u64),
            significant_count,
            fast_count
        )
    } else if total_growth < 0 {
        format!(
            "相比上次扫描，C 盘净减少 {}，其中 {} 个目录释放了明显空间。",
            format_size(total_growth.unsigned_abs()),
            decreased_count
        )
    } else {
        "相比上次扫描，C 盘总占用基本没有变化。".to_string()
    }
}

fn path_depth(path: &str) -> u8 {
    path.trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .count()
        .saturating_sub(1) as u8
}

fn format_size(bytes: u64) -> String {
    let value = bytes as f64;
    if value >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.2} GB", value / 1024.0 / 1024.0 / 1024.0)
    } else if value >= 1024.0 * 1024.0 {
        format!("{:.1} MB", value / 1024.0 / 1024.0)
    } else if value >= 1024.0 {
        format!("{:.1} KB", value / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_growth_levels() {
        assert_eq!(
            determine_level(2 * 1024 * 1024 * 1024, 1),
            DiskGrowthLevel::Significant
        );
        assert_eq!(
            determine_level(-100 * 1024 * 1024, 1),
            DiskGrowthLevel::Decreased
        );
    }
}
