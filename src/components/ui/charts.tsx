// ============================================================================
// 轻量图表组件 - 不引入图表库，保持模块渲染成本和打包体积可控
// ============================================================================

import { useRef, useState, type MouseEvent } from 'react';

export const CHART_PALETTE = ['#07c160', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];

export interface ChartItem {
  id: string;
  label: string;
  value: number;
  color?: string;
  valueLabel: string;
  percentLabel?: string;
  secondaryLabel?: string;
}

interface ChartTooltipState {
  item: ChartItem;
  x: number;
  y: number;
}

interface DonutChartProps {
  items: ChartItem[];
  totalLabel: string;
  totalValueLabel: string;
  emptyText: string;
}

interface ColumnChartProps {
  items: ChartItem[];
  emptyText: string;
}

export function DonutChart({ items, totalLabel, totalValueLabel, emptyText }: DonutChartProps) {
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const totalValue = items.reduce((sum, item) => sum + item.value, 0);
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  let accumulatedRatio = 0;

  const updateTooltip = (event: MouseEvent, item: ChartItem) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // tooltip 跟随鼠标但限制在组件内计算，避免滚动页面后定位漂移。
    setTooltip({
      item,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  return (
    <div
      ref={containerRef}
      className="relative grid gap-4 md:grid-cols-[140px_minmax(0,1fr)] md:items-center"
      onMouseLeave={() => {
        setActiveItemId(null);
        setTooltip(null);
      }}
    >
      <div className="relative mx-auto h-32 w-32">
        <svg viewBox="0 0 120 120" className="-rotate-90">
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="var(--bg-hover)"
            strokeWidth="16"
          />
          {items.map((item, index) => {
            const ratio = totalValue > 0 ? item.value / totalValue : 0;
            const dashLength = Math.max(0, ratio * circumference);
            const dashOffset = -accumulatedRatio * circumference;
            const color = item.color ?? CHART_PALETTE[index % CHART_PALETTE.length];
            const isActive = activeItemId === item.id;
            accumulatedRatio += ratio;

            return (
              <circle
                key={item.id}
                cx="60"
                cy="60"
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={isActive ? 19 : 16}
                strokeDasharray={`${dashLength} ${circumference - dashLength}`}
                strokeDashoffset={dashOffset}
                strokeLinecap={ratio > 0.03 ? 'round' : 'butt'}
                className="cursor-pointer transition-all duration-150"
                opacity={activeItemId && !isActive ? 0.35 : 1}
                onMouseEnter={(event) => {
                  setActiveItemId(item.id);
                  updateTooltip(event, item);
                }}
                onMouseMove={(event) => updateTooltip(event, item)}
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11px] text-[var(--text-muted)]">{totalLabel}</span>
          <span className="text-sm font-bold text-[var(--text-primary)]">{totalValueLabel}</span>
        </div>
      </div>

      <div className="space-y-2">
        {items.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">{emptyText}</p>
        ) : (
          items.map((item, index) => {
            const color = item.color ?? CHART_PALETTE[index % CHART_PALETTE.length];
            const isActive = activeItemId === item.id;

            return (
              <button
                key={item.id}
                type="button"
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition ${
                  isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
                }`}
                onMouseEnter={(event) => {
                  setActiveItemId(item.id);
                  updateTooltip(event, item);
                }}
                onMouseMove={(event) => updateTooltip(event, item)}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]" title={item.label}>
                  {item.label}
                </span>
                {item.percentLabel && (
                  <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{item.percentLabel}</span>
                )}
                <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-[var(--brand-green)]">
                  {item.valueLabel}
                </span>
              </button>
            );
          })
        )}
      </div>

      <ChartTooltip tooltip={tooltip} />
    </div>
  );
}

export function ColumnChart({ items, emptyText }: ColumnChartProps) {
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const maxValue = Math.max(...items.map(item => item.value), 1);

  const updateTooltip = (event: MouseEvent, item: ChartItem) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // 柱状图 tooltip 与柱体共用同一套状态，保证图形和下方图例 hover 行为一致。
    setTooltip({
      item,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseLeave={() => {
        setActiveItemId(null);
        setTooltip(null);
      }}
    >
      <div className="flex h-36 items-end gap-2 border-b border-[var(--border-color)] pb-2">
        {items.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center text-xs text-[var(--text-muted)]">
            {emptyText}
          </div>
        ) : (
          items.map((item, index) => {
            const heightPercent = Math.max(6, (item.value / maxValue) * 100);
            const color = item.color ?? CHART_PALETTE[index % CHART_PALETTE.length];
            const isActive = activeItemId === item.id;

            return (
              <div key={item.id} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                <div className="flex h-28 w-full items-end justify-center">
                  <button
                    type="button"
                    className="w-full max-w-10 cursor-pointer rounded-t-lg transition-all duration-150 hover:brightness-110"
                    style={{
                      height: `${heightPercent}%`,
                      backgroundColor: color,
                      opacity: activeItemId && !isActive ? 0.35 : 1,
                      transform: isActive ? 'translateY(-3px)' : 'translateY(0)',
                    }}
                    aria-label={item.label}
                    onMouseEnter={(event) => {
                      setActiveItemId(item.id);
                      updateTooltip(event, item);
                    }}
                    onMouseMove={(event) => updateTooltip(event, item)}
                  />
                </div>
                <span className="w-full truncate text-center text-[10px] text-[var(--text-muted)]" title={item.label}>
                  {item.label}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {items.map((item, index) => {
          const color = item.color ?? CHART_PALETTE[index % CHART_PALETTE.length];
          const isActive = activeItemId === item.id;

          return (
            <button
              key={item.id}
              type="button"
              className={`flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition ${
                isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
              }`}
              onMouseEnter={(event) => {
                setActiveItemId(item.id);
                updateTooltip(event, item);
              }}
              onMouseMove={(event) => updateTooltip(event, item)}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]" title={item.label}>{item.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-[var(--brand-green)]">{item.valueLabel}</span>
            </button>
          );
        })}
      </div>

      <ChartTooltip tooltip={tooltip} />
    </div>
  );
}

function ChartTooltip({ tooltip }: { tooltip: ChartTooltipState | null }) {
  if (!tooltip) return null;

  return (
    <div
      className="pointer-events-none absolute z-30 min-w-40 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2 shadow-lg shadow-black/10"
      style={{
        left: tooltip.x + 12,
        top: tooltip.y + 12,
      }}
    >
      <p className="max-w-56 truncate text-xs font-semibold text-[var(--text-primary)]" title={tooltip.item.label}>
        {tooltip.item.label}
      </p>
      <p className="mt-1 text-sm font-bold tabular-nums text-[var(--brand-green)]">{tooltip.item.valueLabel}</p>
      {(tooltip.item.percentLabel || tooltip.item.secondaryLabel) && (
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          {[tooltip.item.percentLabel, tooltip.item.secondaryLabel].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}
