/**
 * 一次性命令面板.
 *
 * 以服务器详情页内的组件形式提供, 不单独占用路由.
 * 输出只保留在页面内存中, 服务端不保存命令正文与输出.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { AlertTriangle, Play, Square, Terminal } from 'lucide-react'
import { commandsApi } from '@/api/resources'
import type { MonitorStream } from '@/hooks/use-monitor-stream'
import { useToast } from '@/components/toast'
import { Button, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'

const PRESETS = ['df -h', 'free -m', 'uname -a', 'ps aux | head', 'systemctl status nginx']

const STATUS_LABEL: Record<string, string> = {
  queued: '已排队',
  running: '执行中',
  succeeded: '已完成',
  failed: '执行失败',
  timed_out: '已超时',
  cancelled: '已取消',
  disconnected: '结果未知',
}

function statusTone(status: string): string {
  if (status === 'running' || status === 'queued') return 'bg-slate-900 text-white'
  if (status === 'succeeded') return 'bg-emerald-50 text-emerald-700'
  if (status === 'cancelled' || status === 'timed_out') return 'bg-amber-50 text-amber-800'
  if (status === 'disconnected') return 'bg-orange-50 text-orange-800'
  return 'bg-rose-50 text-rose-700'
}

/** 服务器详情页内的一次性命令面板. */
export function CommandPanel({
  serverId,
  online,
  stream,
}: {
  serverId: string
  online: boolean
  stream: MonitorStream
}): ReactElement {
  const [command, setCommand] = useState('df -h')
  const [submitting, setSubmitting] = useState(false)
  const { toast } = useToast()
  const [elapsed, setElapsed] = useState(0)
  const outputRef = useRef<HTMLDivElement | null>(null)
  const startedAtRef = useRef<number | null>(null)

  const active = stream.command
  const running = active?.status === 'queued' || active?.status === 'running'

  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active?.lines.length])

  useEffect(() => {
    if (!running) {
      startedAtRef.current = null
      return
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now()
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - (startedAtRef.current ?? Date.now()))
    }, 200)
    return () => window.clearInterval(timer)
  }, [running])

  async function handleRun(): Promise<void> {
    if (!serverId || !command.trim() || running) return
    setSubmitting(true)
    try {
      const accepted = await commandsApi.create(serverId, command.trim())
      stream.startCommand(accepted.commandId, serverId)
      setElapsed(0)
    } catch (err) {
      toast({ variant: 'error', title: '命令提交失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel(): Promise<void> {
    if (!active) return
    try {
      const result = await commandsApi.cancel(active.commandId)
      if (result.status === 'disconnected') {
        toast({ variant: 'error', title: '结果未知', description: '连接已断开, 无法确认远端进程是否停止' })
      }
    } catch (err) {
      toast({ variant: 'error', title: '取消失败', description: err instanceof Error ? err.message : undefined })
    }
  }

  const exitLabel =
    active?.status === 'succeeded' || active?.status === 'failed' ? String(active.exitCode ?? '—') : '—'
  const durationLabel =
    active?.durationMs !== null && active?.durationMs !== undefined
      ? `${active.durationMs} ms`
      : running
        ? `${elapsed} ms`
        : '—'

  return (
    <div className="space-y-3">
      {!online ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle size={14} aria-hidden />
          目标服务器离线, 无法执行命令。
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium',
            !active ? 'bg-slate-100 text-slate-600' : statusTone(active.status),
          )}
          role="status"
          aria-live="polite"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
          {active ? (STATUS_LABEL[active.status] ?? active.status) : '空闲'}
        </span>
        <span className="text-[11px] text-slate-400">每台服务器同时只允许一个执行单元</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setCommand(preset)}
            className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-mono text-[11px] text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
          >
            {preset}
          </button>
        ))}
      </div>

      <Textarea
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void handleRun()
        }}
        aria-label="Shell 命令"
        spellCheck={false}
        rows={2}
        className="font-mono text-xs"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void handleRun()} loading={submitting} disabled={!online || running || !command.trim()}>
          <Play size={13} aria-hidden />
          执行
        </Button>
        <Button variant="secondary" onClick={() => void handleCancel()} disabled={!running}>
          <Square size={13} aria-hidden />
          取消
        </Button>
        <span className="text-[11px] text-slate-400">Ctrl / Cmd + Enter 提交</span>
      </div>


      <div
        ref={outputRef}
        aria-label="命令输出"
        aria-live="polite"
        className="monix-scroll-dark min-h-56 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900 px-3 py-3 font-mono text-xs leading-relaxed text-slate-200"
      >
        {!active || active.lines.length === 0 ? (
          <div className="flex h-44 flex-col items-center justify-center gap-2 text-slate-500">
            <Terminal size={18} aria-hidden />
            <span className="text-[11px]">执行命令后在此查看 stdout 与 stderr</span>
          </div>
        ) : (
          active.lines.map((line, index) => (
            <div
              key={index}
              className={cn(
                'whitespace-pre-wrap break-words',
                line.kind === 'stderr' && 'text-rose-300',
                line.kind === 'system' && 'text-slate-500',
              )}
            >
              {line.kind === 'system' ? `· ${line.text}` : line.text}
            </div>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span>
          退出码 <b className="font-medium tabular-nums text-slate-700">{exitLabel}</b>
        </span>
        <span>
          耗时 <b className="font-medium tabular-nums text-slate-700">{durationLabel}</b>
        </span>
        <span>
          输出行 <b className="font-medium tabular-nums text-slate-700">{active?.lines.length ?? 0}</b>
        </span>
        {active?.outputTruncated ? <span className="text-amber-700">输出已达上限, 后续内容未传输</span> : null}
        {active?.truncated ? <span className="text-amber-700">页面仅保留最近 300 行输出</span> : null}
      </div>
    </div>
  )
}
