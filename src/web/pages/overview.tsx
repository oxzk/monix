/**
 * 总览页.
 *
 * 汇总卡片与服务器卡片都只展示当前值, 不提供历史曲线:
 * 后端不保存指标历史, 刷新页面后由实时连接重新下发快照.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Server, Wifi, WifiOff } from 'lucide-react'
import { serversApi } from '@/api/resources'
import type { ServerSnapshot, ServerSummary } from '@/api/types'
import { useMonitorStream } from '@/hooks/use-monitor-stream'
import { useToast } from '@/components/toast'
import { ConnectionBadge } from '@/components/layout'
import { cn, formatAgo, formatPercent, formatRate } from '@/lib/utils'

interface CardData {
  server: ServerSummary
  snapshot: ServerSnapshot | null
}

/** 简约进度条: 无边框、无描边, 只用填充与轨道区分. */
function Meter({ value, label }: { value: number | null; label: string }): ReactElement {
  const safe = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div className="flex items-center gap-3">
      <span className="w-9 shrink-0 text-[11px] text-slate-400">{label}</span>
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(safe)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-slate-900 transition-[width] duration-300" style={{ width: `${safe}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-slate-500">
        {value === null ? '—' : `${safe.toFixed(0)}%`}
      </span>
    </div>
  )
}

function ServerCard({ data }: { data: CardData }): ReactElement {
  const { server, snapshot } = data
  const online = snapshot?.status === 'online'
  const metrics = online ? snapshot?.metrics : null

  const load = metrics?.load?.load1 ?? null
  const loadPercent = load === null ? null : Math.min(100, (load / Math.max((metrics?.cpu?.logical_cores ?? 1), 1)) * 100)
  const ram = metrics?.memory?.usage_percent ?? null
  const disk = metrics?.disks?.[0]?.usage_percent ?? null

  const down = metrics?.network?.download_bytes_per_sec ?? null
  const up = metrics?.network?.upload_bytes_per_sec ?? null

  return (
    <Link
      to={`/servers/${encodeURIComponent(server.id)}`}
      className={cn(
        'group flex flex-col rounded-xl border bg-white p-4 transition-colors no-underline',
        online ? 'border-slate-200 hover:border-slate-300' : 'border-slate-200/70',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', online ? 'text-slate-600' : 'text-slate-400')}>
          <span className={cn('h-1.5 w-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-slate-300')} aria-hidden />
          {online ? '运行中' : '离线'}
        </span>
        <span className="text-[11px] text-slate-400">
          {formatAgo(snapshot?.receivedTs ?? null)}
        </span>
      </div>

      <h3 className="mt-2 truncate text-base font-semibold tracking-[-0.01em] text-slate-900 group-hover:text-slate-900">
        {server.name}
      </h3>

      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
        <span className="tabular-nums">{server.ipv4 ?? server.ipv6 ?? '—'}</span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-0.5">
          {online ? <Wifi size={11} aria-hidden /> : <WifiOff size={11} aria-hidden />}
          <span className="tabular-nums">
            {online ? `${formatRate(down)} ↓` : '—'}
          </span>
        </span>
        {server.countryCode ? (
          <>
            <span aria-hidden>·</span>
            <span>{server.countryCode}</span>
          </>
        ) : null}
      </div>

      <div className="mt-4 space-y-2.5">
        <Meter label="Load" value={loadPercent} />
        <Meter label="RAM" value={ram} />
        <Meter label="Disk" value={disk} />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1">
          <Activity size={12} aria-hidden />
          <span className="tabular-nums">{online ? `CPU ${formatPercent(metrics?.cpu?.usage_percent)}` : '无数据'}</span>
        </span>
        <span className="tabular-nums">{online ? `↑ ${formatRate(up)}` : server.hostname ?? '—'}</span>
      </div>
    </Link>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }): ReactElement {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] text-slate-400">{hint}</div>
    </div>
  )
}

export function OverviewPage(): ReactElement {
  const stream = useMonitorStream()
  const { toast } = useToast()
  const [servers, setServers] = useState<ServerSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    serversApi
      .list({ limit: 100 }, controller.signal)
      .then((data) => setServers(data.items))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        toast({ variant: 'error', title: '加载失败', description: err instanceof Error ? err.message : undefined })
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  const cards = useMemo<CardData[]>(() => {
    return servers.map((server) => ({
      server,
      snapshot: stream.snapshots.get(server.id) ?? null,
    }))
  }, [servers, stream.snapshots])

  const onlineCount = cards.filter((c) => c.snapshot?.status === 'online').length
  const offlineCount = cards.length - onlineCount

  const avgCpu = useMemo<number | null>(() => {
    const values = cards
      .filter((c) => c.snapshot?.status === 'online')
      .map((c) => c.snapshot?.metrics?.cpu?.usage_percent)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (values.length === 0) return null
    return values.reduce((a, b) => a + b, 0) / values.length
  }, [cards])

  const avgMem = useMemo<number | null>(() => {
    const values = cards
      .filter((c) => c.snapshot?.status === 'online')
      .map((c) => c.snapshot?.metrics?.memory?.usage_percent)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (values.length === 0) return null
    return values.reduce((a, b) => a + b, 0) / values.length
  }, [cards])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">总览</h1>
          <p className="mt-1 text-sm text-slate-500">
            共 {cards.length} 台服务器 · 实时指标只保存在内存中, 不写入数据库
          </p>
        </div>
        <ConnectionBadge connected={stream.connected} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="服务器总数" value={String(cards.length)} hint={`${onlineCount} 台在线`} />
        <StatCard label="在线" value={String(onlineCount)} hint="有效连接且 30 秒内有消息" />
        <StatCard label="离线" value={String(offlineCount)} hint="连接关闭或超时" />
        <StatCard
          label="平均 CPU"
          value={avgCpu === null ? '—' : `${avgCpu.toFixed(1)}%`}
          hint={avgMem === null ? '仅统计在线服务器' : `内存 ${avgMem.toFixed(1)}%`}
        />
      </div>


      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-56 animate-pulse rounded-xl border border-slate-200 bg-white" />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center">
          <Server size={20} className="mx-auto text-slate-300" aria-hidden />
          <p className="mt-3 text-sm text-slate-500">还没有服务器, 先创建一台并部署 Agent。</p>
          <Link to="/servers" className="mt-3 inline-block text-sm font-medium text-slate-900 underline">
            前往服务器管理
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <ServerCard key={card.server.id} data={card} />
          ))}
        </div>
      )}
    </div>
  )
}
