/**
 * 交互式终端面板.
 *
 * xterm 实例、ResizeObserver 与用户输入订阅都属于需要显式释放的资源,
 * 因此集中在单个 effect 内创建并在清理函数中统一销毁.
 * 终端输出不进入 React 状态, 由 MonitorClient 直接写入 xterm.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { AlertTriangle, Plug, PlugZap, Terminal as TerminalIcon } from 'lucide-react'
import { terminalApi } from '@/api/resources'
import type { MonitorStream } from '@/hooks/use-monitor-stream'
import { useToast } from '@/components/toast'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

const REASON_LABEL: Record<string, string> = {
  closed_by_user: '已关闭',
  process_exited: 'Shell 已退出',
  idle_timeout: '空闲超时, 会话已终止',
  max_duration: '已达最长时长, 会话已终止',
  open_timeout: 'Agent 未响应, 会话建立失败',
  disconnected: '实时连接已断开, 会话已终止',
  busy: '该服务器已有执行中的任务',
  error: '会话异常结束',
}

/** 服务器详情页内的交互式终端面板. */
export function TerminalPanel({
  serverId,
  online,
  stream,
}: {
  serverId: string
  online: boolean
  stream: MonitorStream
}): ReactElement {
  const [opening, setOpening] = useState(false)
  const { toast } = useToast()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const openedRef = useRef<string | null>(null)

  // 初始化 xterm, 只做一次.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: {
        background: '#0f172b',
        foreground: '#e2e8f0',
        cursor: '#e2e8f0',
        selectionBackground: '#334155',
      },
      scrollback: 2_000,
      convertEol: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    // 屏蔽可被远端输出滥用的 OSC 序列: 52 写系统剪贴板, 8 伪造超链接,
    // 0/1/2 改写窗口标题. 它们对命令行交互没有价值, 却能让命令影响终端之外的环境.
    const blockedOscDisposables = [0, 1, 2, 8, 52].map((ident) =>
      term.parser.registerOscHandler(ident, () => true),
    )

    termRef.current = term
    fitRef.current = fit

    // 键盘输入直接送给 Agent.
    const inputDisposable = term.onData((data) => {
      stream.sendTerminalInput(new TextEncoder().encode(data))
    })

    // 输出写入 xterm; 由 xterm 处理 ANSI 与 UTF-8.
    stream.setTerminalHandler((bytes) => {
      term.write(bytes)
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        stream.sendTerminalResize(term.cols, term.rows)
      } catch {
        // 容器尺寸为 0 时 fit 会抛错, 忽略.
      }
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      for (const disposable of blockedOscDisposables) disposable.dispose()
      stream.setTerminalHandler(null)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // stream 的方法均为 useCallback 稳定引用, 不纳入依赖避免重复初始化.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const targetOnline = online
  const active = stream.terminal.status === 'opening' || stream.terminal.status === 'open'

  const handleOpen = useCallback(async () => {
    if (!serverId || active) return
    const term = termRef.current
    if (!term) return

    setOpening(true)
    try {
      const accepted = await terminalApi.open(serverId, term.cols, term.rows)
      openedRef.current = accepted.sessionId
      stream.setTerminalSession(accepted.sessionId, serverId)
      term.clear()
      term.focus()
    } catch (err) {
      toast({ variant: 'error', title: '终端会话建立失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setOpening(false)
    }
  }, [serverId, active, stream])

  const handleClose = useCallback(async () => {
    const sessionId = stream.terminal.sessionId
    if (!sessionId) return
    try {
      await terminalApi.close(sessionId)
    } catch {
      // 服务端可能已清理, 忽略.
    }
    openedRef.current = null
    stream.closeTerminal()
  }, [stream])

  // 会话结束时在终端里写一行提示, 便于用户理解原因.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (stream.terminal.status !== 'closed') return
    const label = REASON_LABEL[stream.terminal.reason ?? ''] ?? '会话已结束'
    term.write(`\r\n\x1b[2m· ${label}\x1b[0m\r\n`)
  }, [stream.terminal.status, stream.terminal.reason])

  const statusLabel = (() => {
    if (stream.terminal.status === 'idle') return '未连接'
    if (stream.terminal.status === 'opening') return '建立中'
    if (stream.terminal.status === 'open') return '已连接'
    return REASON_LABEL[stream.terminal.reason ?? ''] ?? '已结束'
  })()

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        交互式 PTY 会话, 以 Agent 服务账号权限运行。关闭页面或连接中断会立即终止会话, 服务端不保存会话内容。
      </p>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium',
              stream.terminal.status === 'open' && 'bg-slate-900 text-white',
              stream.terminal.status === 'opening' && 'bg-slate-100 text-slate-600',
              stream.terminal.status === 'idle' && 'bg-slate-100 text-slate-500',
              stream.terminal.status === 'closed' && 'bg-amber-50 text-amber-800',
            )}
            role="status"
            aria-live="polite"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
            {statusLabel}
          </span>

          <div className="ml-auto flex items-center gap-2">
            {active ? (
              <Button size="sm" variant="secondary" onClick={() => void handleClose()}>
                关闭会话
              </Button>
            ) : (
              <Button size="sm" onClick={() => void handleOpen()} loading={opening} disabled={!targetOnline}>
                <Plug size={13} aria-hidden />
                打开终端
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-3 px-4 py-4">
          {!targetOnline && !active ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertTriangle size={14} aria-hidden />
              目标服务器离线, 无法打开终端。
            </div>
          ) : null}


          <div className="relative">
            <div
              ref={containerRef}
              aria-label="终端"
              className="h-[420px] w-full overflow-hidden rounded-lg border border-slate-800 bg-[#0f172b] p-2"
            />
            {!active ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-500">
                <TerminalIcon size={20} aria-hidden />
                <span className="text-[11px]">
                  {stream.terminal.status === 'closed' ? statusLabel : '选择服务器后打开终端'}
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1">
              <PlugZap size={12} aria-hidden />
              实时通道 {stream.connected ? '已连接' : '断开'}
            </span>
            <span>终端与一次性命令共用执行槽, 同一服务器同时只能运行一个</span>
            <span className="ml-auto">会话 ID {stream.terminal.sessionId ?? '—'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
