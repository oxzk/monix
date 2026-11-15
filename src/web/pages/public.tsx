/**
 * 公开状态页: 无需登录, 展示服务器在线状态与当前指标.
 *
 * - 指标与状态全部走 WebSocket(`/api/v1/stream`), 不做轮询;
 *   服务器列表(/servers)首屏拉一次并在 WS 重连时刷新; 站点配置(/config)只拉一次.
 * - 按分组切换: tabs 上直接给出该组的在线/总数.
 * - 卡片视图沿用总览页设计, 列表视图便于快速横向对比.
 * - 独立前台布局 + 主题(见 PublicLayout), 与后台完全隔离.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { LayoutGrid, List, Server } from 'lucide-react'
import { publicApi } from '@/api/resources'
import type { PublicServer, ThemeOptions } from '@/api/types'
import { FlagIcon, loadPercentOf, Meter, PublicLayout, ServerCard, Skeleton, Tooltip } from '@/components/ui'
import { usePublicStream } from '@/hooks/use-public-stream'
import { ALL_GROUPS, buildGroupTabs } from '@/lib/public-groups'
import { cn, formatRate } from '@/lib/utils'

const VIEW_STORAGE_KEY = 'monix.public.view'
type ViewMode = 'cards' | 'list'

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'cards'
  } catch {
    return 'cards'
  }
}


/** 卡片视图骨架: 形态对齐 ServerCard. */
function CardSkeleton(): ReactElement {
    return (
        <div className="p-glass flex flex-col rounded-xl border border-[var(--p-line)] p-4">
            <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-6 rounded-[2px]" />
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-3 w-14" />
                <Skeleton className="ml-auto h-3.5 w-3.5 rounded-full" />
            </div>
            <div className="mt-2.5 flex items-center justify-between">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-28" />
            </div>
            <div className="mt-4 space-y-3">
                {[0, 1, 2, 3].map((index) => (
                    <div key={index} className="flex items-center gap-3">
                        <Skeleton className="h-3 w-10" />
                        <Skeleton className="h-3 flex-1 rounded-full" />
                    </div>
                ))}
            </div>
        </div>
    )
}

/** 列表视图骨架: 6 列网格对齐真实行. */
function ListRowSkeleton(): ReactElement {
    return (
        <li className="grid grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_minmax(0,1.6fr)] items-center gap-x-5 rounded-xl border border-[var(--p-line)] bg-[var(--p-card)]/85 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
                <Skeleton className="h-3 w-3 rounded-full" />
                <Skeleton className="h-3.5 w-5 rounded-[2px]" />
                <Skeleton className="h-4 w-24" />
            </div>
            {[0, 1, 2].map((index) => (
                <div key={index} className="flex items-center gap-1.5">
                    <Skeleton className="h-3 w-10" />
                    <Skeleton className="h-3 flex-1 rounded-full" />
                </div>
            ))}
            <div className="flex min-w-0 justify-end">
                <Skeleton className="h-3 w-32" />
            </div>
        </li>
    )
}

export function PublicPage(): ReactElement {
  const [servers, setServers] = useState<PublicServer[]>([])
  const [siteName, setSiteName] = useState('Monix')
  const [theme, setTheme] = useState<ThemeOptions>({ backgroundImage: null, backgroundOpacity: 0, colors: {} })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>(readViewMode)
  const [groupKey, setGroupKey] = useState<string>(ALL_GROUPS)
  // 实时通道: 指标与状态只来自 WebSocket.
  const { connected, snapshots } = usePublicStream()

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const data = await publicApi.servers(signal)
      setServers(data.servers)
      setError(null)
      setLoading(false)
    } catch (err) {
      // abort: 请求被取消, 保持当前加载态, 不落到空态.
      if (err instanceof Error && err.name === 'AbortError') return
      setError('服务器列表加载失败, 请稍后刷新页面')
      setLoading(false)
    }
  }, [])

  /** 站点配置变化频率低: 只在首屏拉一次, 失败时静默沿用默认(站点名 Monix / 内置主题). */
  const loadConfig = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const data = await publicApi.config(signal)
      setSiteName(data.siteName)
      setTheme(data.theme)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
    }
  }, [])

  // 首屏拉取一次服务器列表(名称/分组)与站点配置. 指标与状态由 WebSocket 推送, 不轮询.
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    const controller = new AbortController()
    void loadConfig(controller.signal)
    return () => controller.abort()
  }, [loadConfig])

  // WS 建立/重连成功时刷新列表, 补齐期间新增或删除的服务器.
  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [connected, load])

  /** 把 WS 快照合并进 REST 返回的列表; 未连接时只用 REST 数据. */
  const liveServers = useMemo<PublicServer[]>(() => {
    if (!connected) return servers
    return servers.map((server) => {
      const live = snapshots.get(server.id)
      if (!live) return server
      return {
        ...server,
        status: live.status,
        sampleTs: live.sampleTs,
        receivedTs: live.receivedTs,
        metrics: live.metrics,
      }
    })
  }, [servers, snapshots, connected])

  const changeView = useCallback((next: ViewMode) => {
    setView(next)
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next)
    } catch {
      // 隐私模式下 localStorage 不可用, 仅本次生效.
    }
  }, [])

  /** 分组 tabs: 全部 + 各分组, 均带在线/总数. */
  const tabs = useMemo(() => buildGroupTabs(liveServers), [liveServers])

  // 分组消失(例如改分组或删除服务器)时回到「全部」.
  useEffect(() => {
    if (groupKey === ALL_GROUPS) return
    if (!tabs.some((tab) => tab.key === groupKey)) setGroupKey(ALL_GROUPS)
  }, [tabs, groupKey])

  const visibleServers = useMemo(() => {
    if (groupKey === ALL_GROUPS) return liveServers
    return liveServers.filter((server) => (server.groupName ?? '') === groupKey)
  }, [liveServers, groupKey])

  return (
    <PublicLayout siteName={siteName} theme={theme}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">仪表盘</h1>
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-[var(--p-line)] bg-[var(--p-card)]">
            <button
              type="button"
              aria-label="卡片视图"
              title="卡片视图"
              aria-pressed={view === 'cards'}
              onClick={() => changeView('cards')}
              className={cn(
                'inline-flex items-center px-2.5 py-1.5 text-xs transition',
                view === 'cards'
                  ? 'bg-[var(--p-accent)] text-[var(--p-accent-ink)]'
                  : 'text-[var(--p-muted)] hover:bg-[var(--p-bg)]',
              )}
            >
              <LayoutGrid size={14} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="列表视图"
              title="列表视图"
              aria-pressed={view === 'list'}
              onClick={() => changeView('list')}
              className={cn(
                'inline-flex items-center border-l border-[var(--p-line)] px-2.5 py-1.5 text-xs transition',
                view === 'list'
                  ? 'bg-[var(--p-accent)] text-[var(--p-accent-ink)]'
                  : 'text-[var(--p-muted)] hover:bg-[var(--p-bg)]',
              )}
            >
              <List size={14} aria-hidden />
            </button>
          </div>
        </div>

        {/* 分组 tabs: 每组显示 在线/总数 */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="按分组筛选">
          {tabs.map((tab) => {
            const active = tab.key === groupKey
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setGroupKey(tab.key)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition',
                  active
                    ? 'border-[var(--p-accent)] bg-[var(--p-accent)] text-[var(--p-accent-ink)]'
                    : 'border-[var(--p-line)] bg-[var(--p-card)] text-[var(--p-muted)] hover:border-[var(--p-faint)]',
                )}
              >
                <span className="font-medium">{tab.label}</span>
                <span className={cn('tabular-nums', active ? 'opacity-80' : 'text-[var(--p-faint)]')}>
                  {tab.online}/{tab.total}
                </span>
              </button>
            )
          })}
        </div>

        {error ? (
          <div
            role="alert"
            className="p-glass rounded-xl border px-4 py-3 text-sm"
            style={{
              borderColor: 'var(--p-bad)',
              color: 'var(--p-bad)',
            }}
          >
            {error}
          </div>
        ) : null}

        {loading ? (
          view === 'cards' ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <CardSkeleton key={index} />
              ))}
            </div>
          ) : (
            <div className="p-glass rounded-2xl border border-[var(--p-line)] p-2">
              <ul className="flex flex-col gap-2">
                {Array.from({ length: 6 }).map((_, index) => (
                  <ListRowSkeleton key={index} />
                ))}
              </ul>
            </div>
          )
        ) : visibleServers.length === 0 ? (
          error ? null : (
            <div className="p-glass rounded-xl border border-dashed border-[var(--p-line)] p-10 text-center">
              <Server size={20} className="mx-auto text-[var(--p-faint)]" aria-hidden />
              <p className="mt-3 text-sm text-[var(--p-muted)]">
                {servers.length === 0 ? '还没有可展示的服务器。' : '该分组下没有服务器。'}
              </p>
            </div>
          )
        ) : view === 'cards' ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleServers.map((server) => (
              <ServerCard key={server.id} server={server} />
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--p-line)] bg-[var(--p-card)]">
            <ul className="divide-y divide-[var(--p-line)]">
              {visibleServers.map((server) => {
                const online = server.status === 'online'
                const metrics = online ? server.metrics : null
                const serverInfo = [server.ip, online ? (server.metrics?.os ?? null) : null].filter(Boolean).join(' · ')
                const nameCell = (
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      role="img"
                      aria-label={online ? '运行中' : '离线'}
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: online ? 'var(--p-ok)' : 'var(--p-bad)' }}
                    />
                    <FlagIcon countryCode={server.countryCode} className="h-3.5 w-5" />
                    <span className="truncate text-sm font-medium">{server.name}</span>
                    <span className="shrink-0 truncate text-[11px] text-[var(--p-faint)]">
                      {server.groupName ?? '未分组'}
                    </span>
                  </div>
                )
                return (
                  <li
                    key={server.id}
                    className="grid grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_minmax(0,1.6fr)] items-center gap-x-5 px-4 py-3"
                  >
                    {/* 第 1 列: 状态点 + 国旗 + 名称(分组跟在后面); 悬停显示 IP 与系统 */}
                    {serverInfo ? <Tooltip content={serverInfo}>{nameCell}</Tooltip> : nameCell}

                    {/* 第 2-5 列: 四条进度条 */}
                    <Meter compact label="内存" value={metrics ? (metrics.memory?.usagePercent ?? null) : null} />
                    <Meter compact label="硬盘" value={metrics ? (metrics.disks?.[0]?.usagePercent ?? null) : null} />
                    <Meter compact label="负载" value={metrics ? loadPercentOf(server) : null} />

                    {/* 第 6 列: 网络 ↓/↑ (IP 在名称列 tooltip) */}
                    <div className="min-w-0 text-right text-xs tabular-nums text-[var(--p-muted)]">
                      {online ? (
                        <>
                          ↓ {formatRate(metrics?.network?.downloadBytesPerSec)} / ↑{' '}
                          {formatRate(metrics?.network?.uploadBytesPerSec)}
                        </>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </PublicLayout>
  )
}