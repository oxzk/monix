/**
 * 服务器详情页.
 *
 * 展示当前实时指标与系统信息, 并通过 `?action=` 参数在页面内挂载
 * 命令面板或终端面板, 避免跳转到独立路由而丢失上下文.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Activity, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Network, SquareTerminal, Terminal } from 'lucide-react'
import { serversApi } from '@/api/resources'
import { ApiError } from '@/api/client'
import type { ServerSummary } from '@/api/types'
import { useMonitorStream } from '@/hooks/use-monitor-stream'
import { useToast } from '@/components/toast'
import { lazy, Suspense } from 'react'
import { Button } from '@/components/ui'
import { CommandPanel } from '@/pages/commands'

// xterm 体积较大, 终端面板按需加载.
const TerminalPanel = lazy(() =>
  import('@/pages/terminal').then((module) => ({ default: module.TerminalPanel })),
)
import { cn, formatAgo, formatBytes, formatPercent, formatRate, formatUptime } from '@/lib/utils'

function MetricCard({
  icon,
  title,
  value,
  unit,
  sub,
  children,
}: {
  icon: ReactElement
  title: string
  value: string
  unit?: string
  sub?: string
  children?: React.ReactNode
}): ReactElement {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 text-slate-400">
        {icon}
        <span className="text-xs font-medium text-slate-500">{title}</span>
      </div>
      <div className="mt-2 text-[26px] font-semibold leading-none tracking-tight text-slate-900 tabular-nums">
        {value}
        {unit ? <span className="ml-1 text-xs font-medium text-slate-400">{unit}</span> : null}
      </div>
      {sub ? <div className="mt-1.5 text-xs text-slate-400">{sub}</div> : null}
      {children}
    </div>
  )
}

export function ServerDetailPage(): ReactElement {
  const { id = '' } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const action = searchParams.get('action')
  const stream = useMonitorStream()
  const { toast } = useToast()
  const [server, setServer] = useState<ServerSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    serversApi
      .get(id, controller.signal)
      .then((data) => setServer(data))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        if (err instanceof ApiError && err.status === 404) {
          setServer(null)
          return
        }
        toast({ variant: 'error', title: '加载失败', description: err instanceof Error ? err.message : undefined })
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [id])

  const snapshot = stream.snapshots.get(id) ?? null
  const online = snapshot?.status === 'online'
  const metrics = online ? snapshot?.metrics : null

  const cores = useMemo<number[]>(() => {
    const list = metrics?.cpu?.per_core_usage ?? []
    return list.map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0))
  }, [metrics])

  if (loading) {
    return <div className="text-sm text-slate-500">加载中...</div>
  }

  if (!server) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center">
        <p className="text-sm text-slate-500">服务器不存在</p>
        <Link to="/servers" className="mt-3 inline-block text-sm font-medium text-slate-900 underline">
          返回服务器列表
        </Link>
      </div>
    )
  }

  const memPercent = metrics?.memory?.usage_percent ?? null
  const disk = metrics?.disks?.[0] ?? null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400">
            <Link to="/servers" className="hover:underline">
              服务器
            </Link>
            <span className="mx-1.5" aria-hidden>
              /
            </span>
            <span>{server.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-900">{server.name}</h1>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium',
                online ? 'bg-slate-100 text-slate-600' : 'bg-rose-50 text-rose-600',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-rose-500')} aria-hidden />
              {online ? '在线' : '离线'}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
            <span className="font-mono">{server.ipv4 ?? server.ipv6 ?? '—'}</span>
            {server.countryCode ? <span>{server.countryCode}</span> : null}
            <span className="font-mono">{server.id}</span>
            <span>{online ? formatAgo(snapshot?.receivedTs ?? null) : '无实时数据'}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant={action === 'command' ? 'default' : 'secondary'}
            onClick={() => setSearchParams({ action: 'command' })}
          >
            <Terminal size={14} aria-hidden />
            执行命令
          </Button>
          <Button
            variant={action === 'terminal' ? 'default' : 'secondary'}
            onClick={() => setSearchParams({ action: 'terminal' })}
          >
            <SquareTerminal size={14} aria-hidden />
            终端
          </Button>
        </div>
      </div>

      {action === 'command' || action === 'terminal' ? (
        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">
              {action === 'command' ? '执行命令' : '终端'}
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setSearchParams({})}>
              收起
            </Button>
          </div>
          <div className="p-4">
            {action === 'command' ? (
              <CommandPanel serverId={server.id} online={online} stream={stream} />
            ) : (
              <Suspense fallback={<div className="text-sm text-slate-500">正在加载终端...</div>}>
                <TerminalPanel serverId={server.id} online={online} stream={stream} />
              </Suspense>
            )}
          </div>
        </div>
      ) : null}

      {!online ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
          该服务器当前离线, 不展示过期指标。Agent 重新连接后会自动恢复实时数据。
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <MetricCard
          icon={<Cpu size={14} aria-hidden />}
          title="CPU"
          value={metrics?.cpu?.usage_percent === null || metrics?.cpu?.usage_percent === undefined ? '—' : metrics.cpu.usage_percent.toFixed(1)}
          unit="%"
          sub={metrics?.cpu ? `${metrics.cpu.physical_cores ?? '—'} 物理 / ${metrics.cpu.logical_cores ?? '—'} 逻辑核心` : undefined}
        >
          {cores.length > 0 ? (
            <div className="mt-3">
              <div className="flex h-12 items-end gap-[3px]" aria-label="每核心使用率">
                {cores.map((value, index) => (
                  <div key={index} className="flex h-full flex-1 items-end">
                    <div
                      className={cn('w-full rounded-sm', value >= 85 ? 'bg-amber-400' : 'bg-slate-900/80')}
                      style={{ height: `${Math.max(4, value)}%` }}
                      title={`核心 ${index}: ${value.toFixed(1)}%`}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-slate-300">
                <span>核心使用率</span>
                <span className="tabular-nums">{cores.length} 核</span>
              </div>
            </div>
          ) : null}
        </MetricCard>

        <MetricCard
          icon={<MemoryStick size={14} aria-hidden />}
          title="内存"
          value={memPercent === null ? '—' : memPercent.toFixed(1)}
          unit="%"
          sub={
            metrics?.memory?.total_bytes
              ? `${formatBytes(metrics.memory.used_bytes)} / ${formatBytes(metrics.memory.total_bytes)}`
              : undefined
          }
        >
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <div className="h-full rounded-full bg-slate-900" style={{ width: `${Math.min(100, memPercent ?? 0)}%` }} />
          </div>
          {metrics?.swap?.total_bytes ? (
            <div className="mt-2 text-[11px] text-slate-400">
              Swap {formatBytes(metrics.swap.used_bytes)} / {formatBytes(metrics.swap.total_bytes)}
            </div>
          ) : null}
        </MetricCard>

        <MetricCard
          icon={<HardDrive size={14} aria-hidden />}
          title="磁盘"
          value={disk?.usage_percent === null || disk?.usage_percent === undefined ? '—' : disk.usage_percent.toFixed(1)}
          unit="%"
          sub={disk ? `${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)}` : '无数据'}
        >
          <div className="mt-3 space-y-2">
            {(metrics?.disks ?? []).map((item) => (
              <div key={item.mount_point} className="flex items-center gap-2 text-[11px]">
                <code className="w-20 shrink-0 truncate font-mono text-slate-500">{item.mount_point}</code>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-slate-900"
                    style={{ width: `${Math.min(100, item.usage_percent ?? 0)}%` }}
                  />
                </div>
                <span className="w-12 text-right tabular-nums text-slate-500">
                  {formatPercent(item.usage_percent)}
                </span>
              </div>
            ))}
          </div>
        </MetricCard>

        <MetricCard icon={<Network size={14} aria-hidden />} title="网络" value={formatRate(metrics?.network?.download_bytes_per_sec)}>
          <div className="mt-3 space-y-1.5 text-xs text-slate-500">
            <div className="flex items-center gap-1.5">
              <ArrowDown size={12} className="text-slate-400" aria-hidden />
              <span className="tabular-nums">下行 {formatRate(metrics?.network?.download_bytes_per_sec)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <ArrowUp size={12} className="text-slate-400" aria-hidden />
              <span className="tabular-nums">上行 {formatRate(metrics?.network?.upload_bytes_per_sec)}</span>
            </div>
            <div className="pt-1 text-[11px] text-slate-400">
              累计 {formatBytes(metrics?.network?.bytes_received)} 接收 / {formatBytes(metrics?.network?.bytes_sent)} 发送
            </div>
          </div>
        </MetricCard>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-2 text-slate-400">
            <Activity size={14} aria-hidden />
            <span className="text-xs font-medium text-slate-500">系统信息</span>
          </div>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">主机名</dt>
              <dd className="truncate font-mono text-slate-700">{metrics?.system?.hostname ?? server.hostname ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">操作系统</dt>
              <dd className="truncate text-slate-700">
                {metrics?.system?.os ?? '—'} {metrics?.system?.os_version ?? ''}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">架构</dt>
              <dd className="truncate font-mono text-slate-700">{metrics?.system?.arch ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">运行时间</dt>
              <dd className="truncate text-slate-700">{formatUptime(metrics?.system?.uptime_seconds)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">负载 (1/5/15m)</dt>
              <dd className="truncate tabular-nums text-slate-700">
                {metrics?.load
                  ? `${metrics.load.load1?.toFixed(2) ?? '—'} / ${metrics.load.load5?.toFixed(2) ?? '—'} / ${metrics.load.load15?.toFixed(2) ?? '—'}`
                  : '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">最近上报</dt>
              <dd className="truncate tabular-nums text-slate-700">{formatAgo(snapshot?.receivedTs ?? null)}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Agent</div>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">启用状态</dt>
              <dd className="text-slate-700">{server.enabled ? '已启用' : '已禁用'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">连接</dt>
              <dd className="text-slate-700">{stream.connected ? 'WSS 已连接' : '断开'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">最新采样</dt>
              <dd className="tabular-nums text-slate-700">
                {snapshot?.sampleTs ? new Date(snapshot.sampleTs).toISOString().slice(11, 19) : '—'}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}
