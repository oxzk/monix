/**
 * 交互式终端面板.
 *
 * xterm 实例、ResizeObserver 与用户输入订阅都属于需要显式释放的资源,
 * 因此集中在单个 effect 内创建并在清理函数中统一销毁.
 * 终端输出不进入 React 状态, 由 MonitorClient 直接写入 xterm.
 *
 * 会话生命周期与断线续传:
 * - 页面刷新/断线重连后, 通过 `terminal.active` 找回会话并按 seq 续传;
 * - 会话被其他窗口接管时显示接管入口;
 * - 会话结束(退出/超时/关闭)显示原因与重新打开按钮.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { AlertTriangle, Plug, Search, Terminal as TerminalIcon, X } from 'lucide-react'
import { terminalApi } from '@/api/resources'
import type { MonitorStream } from '@/hooks/use-monitor-stream'
import { Button, useToast } from '@/components/ui'
import { cn } from '@/lib/utils'

const REASON_LABEL: Record<string, string> = {
  closed_by_user: '已关闭',
  process_exited: 'Shell 已退出',
  idle_timeout: '空闲超时, 会话已终止',
  max_duration: '已达最长时长, 会话已终止',
  open_timeout: 'Agent 未响应, 会话建立失败',
  disconnected: '实时连接已断开, 会话已终止',
  detached: '已在其他窗口打开',
  busy: '该服务器已有执行中的任务',
  error: '会话异常结束',
}

const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 9
const MAX_FONT_SIZE = 32
/** 搜索高亮装饰配色, 与终端主题协调. */
const SEARCH_DECORATIONS = {
  matchOverviewRuler: '#334155',
  activeMatchColorOverviewRuler: '#8ab4f8',
}

/** 搜索浮层: 输入框 + 上一个/下一个/关闭. */
function SearchBar({
    query,
    inputRef,
    onQueryChange,
    onSearch,
    onClose,
}: {
    query: string
    inputRef: React.RefObject<HTMLInputElement | null>
    onQueryChange: (value: string) => void
    onSearch: (direction: 1 | -1) => void
    onClose: () => void
}): ReactElement {
    return (
        <div className="absolute right-3 top-2 flex items-center gap-1 rounded-md border border-slate-700 bg-[#0f172b]/95 px-2 py-1 shadow-lg">
            <Search size={12} className="text-slate-500" aria-hidden />
            <input
                ref={inputRef}
                value={query}
                placeholder="搜索…"
                spellCheck={false}
                aria-label="搜索终端输出"
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        onSearch(e.shiftKey ? -1 : 1)
                        e.preventDefault()
                    } else if (e.key === 'Escape') {
                        onClose()
                    }
                }}
                className="w-40 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-500"
            />
            <button
                type="button"
                title="上一个 (Shift+Enter)"
                onClick={() => onSearch(-1)}
                className="rounded px-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-slate-200"
            >
                ↑
            </button>
            <button
                type="button"
                title="下一个 (Enter)"
                onClick={() => onSearch(1)}
                className="rounded px-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-slate-200"
            >
                ↓
            </button>
            <button
                type="button"
                title="关闭 (Esc)"
                onClick={onClose}
                className="rounded px-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-slate-200"
            >
                ✕
            </button>
        </div>
    )
}

/** 居中覆盖层容器: 重连中/已接管/已结束 共用. */
function CenterOverlay({
    children,
    interactive = false,
}: {
    children: React.ReactNode
    interactive?: boolean
}): ReactElement {
    return (
        <div
            className={
                'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-slate-300 ' +
                (interactive ? 'bg-black/60 backdrop-blur-sm' : 'pointer-events-none bg-black/50')
            }
        >
            {children}
        </div>
    )
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
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const { toast } = useToast()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const fontSizeRef = useRef(DEFAULT_FONT_SIZE)
  /** 最新 stream 引用: 终端 effect 只初始化一次, 但回调要拿到最新流对象. */
  const streamRef = useRef(stream)
  streamRef.current = stream

  const terminal = stream.terminal
  const isThisServer = terminal.serverId === serverId
  const active =
    isThisServer &&
    (terminal.status === 'opening' || terminal.status === 'open' || terminal.status === 'reconnecting')
  const targetOnline = online

  /** 字体调整(不进入导出接口). */
  const changeFontSize = useCallback((size: number) => {
    setFontSize(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)))
  }, [])

  /** 搜索并在结束后保持输入框焦点. */
  const runSearch = useCallback(
    (direction: 1 | -1) => {
      const addon = searchRef.current
      if (!addon || !searchQuery) return
      try {
        if (direction === 1) addon.findNext(searchQuery, { decorations: SEARCH_DECORATIONS })
        else addon.findPrevious(searchQuery, { decorations: SEARCH_DECORATIONS })
      } catch {
        // 无匹配时忽略
      }
      searchInputRef.current?.focus()
    },
    [searchQuery],
  )

  // 初始化 xterm, 只做一次.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: DEFAULT_FONT_SIZE,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: {
        background: '#0f172b',
        foreground: '#e2e8f0',
        cursor: '#e2e8f0',
        selectionBackground: '#334155',
      },
      scrollback: 5_000,
      convertEol: false,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // 屏蔽可被远端输出滥用的 OSC 序列: 52 写系统剪贴板, 8 伪造超链接,
    // 0/1/2 改写窗口标题. 它们对命令行交互没有价值, 却能让命令影响终端之外的环境.
    const blockedOscDisposables = [0, 1, 2, 8, 52].map((ident) =>
      term.parser.registerOscHandler(ident, () => true),
    )

    // 键盘输入直接送给 Agent.
    const inputDisposable = term.onData((data) => {
      streamRef.current.sendTerminalInput(new TextEncoder().encode(data))
    })

    // 输出写入 xterm; 由 xterm 处理 ANSI 与 UTF-8.
    streamRef.current.setTerminalHandler((bytes) => {
      term.write(bytes)
    })
    // 续传出现空洞时由客户端触发清屏.
    streamRef.current.setTerminalResetHandler(() => {
      term.reset()
    })

    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

    async function paste(): Promise<void> {
      try {
        const text = await navigator.clipboard.readText()
        if (text) term.paste(text)
      } catch {
        // 剪贴板权限被拒绝
      }
    }

    function copySelection(): void {
      const selection = term.getSelection()
      if (selection) {
        navigator.clipboard?.writeText(selection).catch(() => {})
      }
    }

    /**
     * 快捷键:
     * Ctrl/Cmd+Shift+C 复制、Ctrl/Cmd+Shift+V 粘贴、Ctrl/Cmd+F 搜索、
     * Ctrl/Cmd + +/-/0 字体缩放; macOS 下 Cmd+C/Cmd+V 直接复制粘贴.
     */
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      const mod = ev.ctrlKey || ev.metaKey
      if (mod && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
        copySelection()
        return false
      }
      if (mod && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
        void paste()
        return false
      }
      if (isMac && ev.metaKey && !ev.shiftKey && (ev.key === 'c' || ev.key === 'C')) {
        // 终端惯例: 有选中复制; 无选中放行让 ^C 中断当前命令.
        if (term.hasSelection()) {
          copySelection()
          return false
        }
        return true
      }
      if (isMac && ev.metaKey && (ev.key === 'v' || ev.key === 'V')) {
        void paste()
        return false
      }
      if ((ev.ctrlKey || (isMac && ev.metaKey)) && !ev.shiftKey && (ev.key === 'f' || ev.key === 'F')) {
        setSearchVisible(true)
        return false
      }
      if (mod && (ev.key === '+' || ev.key === '=')) {
        changeFontSize(fontSizeRef.current + 1)
        return false
      }
      if (mod && (ev.key === '-' || ev.key === '_')) {
        changeFontSize(fontSizeRef.current - 1)
        return false
      }
      if (mod && ev.key === '0') {
        changeFontSize(DEFAULT_FONT_SIZE)
        return false
      }
      return true
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        streamRef.current.sendTerminalResize(term.cols, term.rows)
      } catch {
        // 容器尺寸为 0 时 fit 会抛错, 忽略.
      }
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      for (const disposable of blockedOscDisposables) disposable.dispose()
      streamRef.current.setTerminalHandler(null)
      streamRef.current.setTerminalResetHandler(null)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [changeFontSize])

  // 字体变化后重新布局并上报尺寸.
  useEffect(() => {
    fontSizeRef.current = fontSize
    const term = termRef.current
    if (!term) return
    term.options = { fontSize }
    window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // 容器尺寸为 0 时忽略.
      }
      if (termRef.current) {
        streamRef.current.sendTerminalResize(termRef.current.cols, termRef.current.rows)
      }
    })
  }, [fontSize])

  // 面板挂载即建立通道: 找回会话、打开终端都依赖它.
  useEffect(() => {
    streamRef.current.ensureConnected()
  }, [])

  // 页面加载/切换服务器: 找回仍在运行的活动会话并续传.
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    terminalApi
      .active(serverId, controller.signal)
      .then((session) => {
        if (cancelled || !session) return
        // 先建立通道并清屏, 再登记会话: 重放帧可能在状态更新后的 effect 之前到达.
        streamRef.current.ensureConnected()
        termRef.current?.reset()
        streamRef.current.setTerminalSession(session.sessionId, serverId, session.status)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [serverId])

  // 输入过载等一次性提示: 3 秒后自动消失.
  const notice = isThisServer ? terminal.notice : null
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => streamRef.current.clearTerminalNotice(), 3_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (searchVisible) searchInputRef.current?.focus()
  }, [searchVisible])

  const handleOpen = useCallback(async () => {
    const term = termRef.current
    if (!term || opening) return
    setOpening(true)
    try {
      // 先建立实时通道: resume 绑定与 opened/输出事件都依赖它.
      streamRef.current.ensureConnected()
      const accepted = await terminalApi.open(serverId, term.cols || 80, term.rows || 24)
      // 先清屏再登记会话与续传, 避免重放帧被随后的清屏覆盖.
      term.reset()
      streamRef.current.setTerminalSession(accepted.sessionId, serverId, 'opening')
      term.focus()
    } catch (err) {
      toast({
        variant: 'error',
        title: '终端会话建立失败',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setOpening(false)
    }
  }, [serverId, opening, toast])

  const handleClose = useCallback(async () => {
    const sessionId = streamRef.current.terminal.sessionId
    if (!sessionId) return
    try {
      await terminalApi.close(sessionId)
    } catch {
      // 服务端可能已清理, 忽略.
    }
    streamRef.current.closeTerminal()
  }, [])

  /** 被其他窗口接管后重新接管: 清屏并从缓冲重新拉取, 保证画面完整. */
  const handleTakeover = useCallback(() => {
    const sessionId = streamRef.current.terminal.sessionId
    if (!sessionId) return
    termRef.current?.reset()
    streamRef.current.ensureConnected()
    streamRef.current.setTerminalSession(sessionId, serverId, 'open')
    termRef.current?.focus()
  }, [serverId])

  const statusLabel = (() => {
    if (!isThisServer || terminal.status === 'idle') return '未连接'
    if (terminal.status === 'opening') return '建立中'
    if (terminal.status === 'open') return '已连接'
    if (terminal.status === 'reconnecting') return '重连中'
    return REASON_LABEL[terminal.reason ?? ''] ?? '已结束'
  })()

  const closedReason = isThisServer && terminal.status === 'closed'
  const detached = closedReason && terminal.reason === 'detached'

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium',
              terminal.status === 'open' && isThisServer && 'bg-slate-900 text-white',
              (terminal.status === 'opening' || terminal.status === 'reconnecting') &&
                isThisServer &&
                'bg-slate-100 text-slate-600',
              terminal.status === 'idle' && 'bg-slate-100 text-slate-500',
              closedReason && 'bg-amber-50 text-amber-800',
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
              <Button
                size="sm"
                onClick={() => void handleOpen()}
                loading={opening}
                disabled={!targetOnline}
              >
                <Plug size={13} aria-hidden />
                {closedReason && !detached ? '重新打开终端' : '打开终端'}
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

          {notice ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            >
              <AlertTriangle size={14} aria-hidden />
              <span className="flex-1">{notice}</span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => streamRef.current.clearTerminalNotice()}
                className="rounded p-0.5 text-amber-700 hover:bg-amber-100"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ) : null}

          <div className="relative">
            <div
              ref={containerRef}
              aria-label="终端"
              className="h-[420px] w-full overflow-hidden rounded-lg border border-slate-800 bg-[#0f172b] p-2"
            />

            {searchVisible ? (
                <SearchBar
                    query={searchQuery}
                    inputRef={searchInputRef}
                    onQueryChange={setSearchQuery}
                    onSearch={runSearch}
                    onClose={() => {
                        searchRef.current?.clearDecorations()
                        setSearchVisible(false)
                    }}
                />
            ) : null}

            {active && terminal.status === 'reconnecting' ? (
              <CenterOverlay>
                <span className="text-xs">实时连接已断开, 正在重连…</span>
                <span className="text-[11px] text-slate-500">会话仍在服务端运行, 重连后自动续传输出</span>
              </CenterOverlay>
            ) : null}

            {closedReason ? (
              <CenterOverlay interactive>
                <p className="text-xs">
                  {detached ? '终端已在其他窗口打开' : (REASON_LABEL[terminal.reason ?? ''] ?? '会话已结束')}
                </p>
                <Button
                  size="sm"
                  variant={detached ? 'default' : 'secondary'}
                  onClick={() => (detached ? handleTakeover() : void handleOpen())}
                  disabled={!targetOnline && !detached}
                >
                  {detached ? '接管终端' : '重新打开终端'}
                </Button>
              </CenterOverlay>
            ) : null}

            {!active && !closedReason ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-500">
                <TerminalIcon size={20} aria-hidden />
                <span className="text-[11px]">选择服务器后打开终端</span>
              </div>
            ) : null}
          </div>

        </div>
      </div>
    </div>
  )
}
