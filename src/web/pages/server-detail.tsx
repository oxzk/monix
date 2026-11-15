/**
 * 服务器详情页.
 *
 * 后台不需要实时指标: 本页只展示服务器档案(状态来自 D1 缓存),
 * 通过 `?action=` 参数在页面内挂载命令面板或终端面板, 避免跳转到
 * 独立路由而丢失上下文. 实时指标请看公开状态页.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { SquareTerminal, Terminal } from 'lucide-react'
import { serversApi } from '@/api/resources'
import { ApiError } from '@/api/client'
import type { ServerSummary } from '@/api/types'
import { useMonitorStream } from '@/hooks/use-monitor-stream'
import { Button, useToast } from '@/components/ui'
import { lazy, Suspense } from 'react'
import { cn } from '@/lib/utils'

// 终端(xterm)与命令面板都按需加载.
const CommandPanel = lazy(() =>
  import('@/pages/commands').then((module) => ({ default: module.CommandPanel })),
)
const TerminalPanel = lazy(() =>
  import('@/pages/terminal').then((module) => ({ default: module.TerminalPanel })),
)

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

  const online = server?.status === 'online'

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
            {server.platform ? <span className="font-mono">{server.platform}</span> : null}
            {server.version ? <span className="font-mono">v{server.version}</span> : null}
            <span className="font-mono">{server.id}</span>
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
            <Suspense fallback={<div className="text-sm text-slate-500">正在加载面板...</div>}>
              {action === 'command' ? (
                <CommandPanel serverId={server.id} online={online} stream={stream} />
              ) : (
                <TerminalPanel serverId={server.id} online={online} stream={stream} />
              )}
            </Suspense>
          </div>
        </div>
      ) : null}

      {!online ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
          该服务器当前离线, 无法执行命令或打开终端。Agent 重新连接后会自动恢复。
        </div>
      ) : null}
    </div>
  )
}