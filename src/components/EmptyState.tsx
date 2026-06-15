// ============================================================================
// 通用空数据占位组件
// ============================================================================

import type { ComponentType, ReactNode } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';

interface EmptyStateProps {
  /** 用图标承载当前状态，避免不同模块各自写一套空白占位。 */
  icon?: ComponentType<{ className?: string }>;
  title?: string;
  description?: string;
  action?: ReactNode;
  tone?: 'neutral' | 'success';
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon,
  title = '暂无数据',
  description = '开始扫描后，这里会展示可处理的结果。',
  action,
  tone = 'neutral',
  compact = false,
  className = '',
}: EmptyStateProps) {
  const Icon = icon ?? (tone === 'success' ? CheckCircle2 : Sparkles);
  const iconClassName = tone === 'success'
    ? 'bg-[var(--brand-green-10)] text-[var(--brand-green)]'
    : 'bg-[var(--bg-hover)] text-[var(--text-muted)]';

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border-color)] bg-[var(--bg-main)] px-6 text-center ${
        compact ? 'py-8' : 'py-12'
      } ${className}`}
    >
      <div className={`mb-3 flex h-12 w-12 items-center justify-center rounded-2xl ${iconClassName}`}>
        <Icon className="h-6 w-6" />
      </div>
      <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-[var(--text-muted)]">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
