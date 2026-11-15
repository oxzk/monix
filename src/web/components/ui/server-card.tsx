/**
 * 公开状态页的服务器卡片与进度条.
 *
 * 无边框进度条 + 填充/轨道区分, 只展示当前值.
 * 颜色全部走前台主题变量(--p-*), 因此切换主题时无需改组件.
 */
import type { ReactElement } from 'react'
import type { PublicServer } from '@/api/types'
import { cn } from '@/lib/utils'
import { FlagIcon } from './flag-icon'
import { Tooltip } from './tooltip'
import { formatRate } from '@/lib/utils'

/** 简约进度条: 无边框、无描边, 只用填充与轨道区分; compact 用于紧凑布局(小间距). */
export function Meter({
  value,
  label,
  compact = false,
}: {
  value: number | null
  label: string
  compact?: boolean
}): ReactElement {
  const safe = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value))
  const bar = (
    <div
      className="relative h-3 flex-1 overflow-hidden rounded-full bg-[var(--p-line)]"
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(safe)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-[var(--p-accent)] transition-[width] duration-300"
        style={{ width: `${safe}%` }}
      />
    </div>
  )
  return (
    <div className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-3')}>
      <span className="w-10 shrink-0 text-xs text-[var(--p-faint)]">{label}</span>
      {/* 悬停进度条时以浮层显示百分比(无数据不弹) */}
      {value === null ? bar : <Tooltip content={`${label} ${safe.toFixed(0)}%`}>{bar}</Tooltip>}
    </div>
  )
}

/** load1 / 逻辑核数, 折算成 0-100 的进度条百分比. */
export function loadPercentOf(server: PublicServer): number | null {
  const load = server.metrics?.load?.load1 ?? null
  if (load === null) return null
  const cores = Math.max(server.metrics?.cpu?.logicalCores ?? 1, 1)
  return Math.min(100, (load / cores) * 100)
}

export function ServerCard({ server }: { server: PublicServer }): ReactElement {
  const online = server.status === 'online'
  const metrics = online ? server.metrics : null
  const memory = metrics?.memory?.usagePercent ?? null
  const disk = metrics?.disks?.[0]?.usagePercent ?? null
  const down = metrics?.network?.downloadBytesPerSec ?? null
  const up = metrics?.network?.uploadBytesPerSec ?? null

  return (
    <div className="p-glass flex flex-col rounded-xl border border-[var(--p-line)] p-4 transition-colors">
      {/* 国旗 + 名称/分组在左, 状态点在右 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FlagIcon countryCode={server.countryCode} className="h-4 w-6 rounded-[2px] object-cover" />
          <h3 className="truncate text-lg font-semibold tracking-[-0.01em]">{server.name}</h3>
          <span className="shrink-0 truncate text-xs text-[var(--p-faint)]">
            {server.groupName ?? '未分组'}
          </span>
        </div>
        <span
          role="img"
          aria-label={online ? '运行中' : '离线'}
          title={online ? '运行中' : '离线'}
          className="h-3.5 w-3.5 shrink-0 rounded-full"
          style={{ backgroundColor: online ? 'var(--p-ok)' : 'var(--p-bad)' }}
        />
      </div>

      {/* 网络: IP 在左, 上下行速率在右; 离线且无 IP 时整行不渲染 */}
      {(server.ip || online) && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--p-muted)]">
          {server.ip ? <span className="truncate font-mono">{server.ip}</span> : null}
          {online ? (
            <span className="shrink-0 tabular-nums">
              ↓ {formatRate(down)} / ↑ {formatRate(up)}
            </span>
          ) : null}
        </div>
      )}

      <div className="mt-4 space-y-3">
        <Meter label="内存" value={memory} />
        <Meter label="硬盘" value={disk} />
        <Meter label="负载" value={loadPercentOf(server)} />
      </div>
    </div>
  )
}