/**
 * MonitorClient 的 React 适配层.
 *
 * 连接、重连与资源释放由 MonitorClient 负责; 这里只做两件事:
 * 把客户端状态同步到 React state, 并在 Provider 卸载时释放客户端.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { MonitorClient, type MonitorSnapshotState } from '@/lib/monitor-client'

export type {
  ActiveCommand,
  CommandOutputLine,
  MonitorSnapshotState,
  TerminalDataHandler,
  TerminalResetHandler,
  TerminalState,
} from '@/lib/monitor-client'

/** 页面可见的流接口: 状态 + 动作. */
export interface MonitorStream extends MonitorSnapshotState {
  /** 按需建立连接: 执行命令/打开终端前调用. */
  ensureConnected: () => void
  startCommand: (commandId: string, serverId: string) => void
  clearCommand: (serverId?: string) => void
  setTerminalSession: (sessionId: string, serverId: string, status?: 'opening' | 'open') => void
  setTerminalHandler: (handler: ((data: Uint8Array) => void) | null) => void
  setTerminalResetHandler: (handler: (() => void) | null) => void
  resumeTerminal: () => void
  sendTerminalInput: (data: Uint8Array) => void
  sendTerminalResize: (cols: number, rows: number) => void
  closeTerminal: () => void
  clearTerminalNotice: () => void
}

const MonitorStreamContext = createContext<MonitorStream | null>(null)

/** 整个后台共用一条 Dashboard WebSocket, 页面切换不会重建连接或中断终端会话. */
export function MonitorStreamProvider({ children }: { children: ReactNode }): ReactElement {
  const client = useMemo(() => new MonitorClient(), [])
  const [state, setState] = useState<MonitorSnapshotState>(() => client.getState())

  useEffect(() => {
    // 连接是按需的: 执行命令/打开终端时由调用方 ensureConnected.
    const unsubscribe = client.subscribe(setState)
    return () => {
      unsubscribe()
      client.dispose()
    }
  }, [client])

  const stream = useMemo<MonitorStream>(
    () => ({
      ...state,
      ensureConnected: () => client.ensureConnected(),
      startCommand: (commandId, serverId) => client.startCommand(commandId, serverId),
      clearCommand: (serverId?: string) => client.clearCommand(serverId),
      setTerminalSession: (sessionId, serverId, status) =>
        client.setTerminalSession(sessionId, serverId, status),
      setTerminalHandler: (handler) => client.setTerminalHandler(handler),
      setTerminalResetHandler: (handler) => client.setTerminalResetHandler(handler),
      resumeTerminal: () => client.resumeTerminal(),
      sendTerminalInput: (data) => client.sendTerminalInput(data),
      sendTerminalResize: (cols, rows) => client.sendTerminalResize(cols, rows),
      closeTerminal: () => client.closeTerminal(),
      clearTerminalNotice: () => client.clearTerminalNotice(),
    }),
    [state, client],
  )

  return createElement(MonitorStreamContext.Provider, { value: stream }, children)
}

export function useMonitorStream(): MonitorStream {
  const stream = useContext(MonitorStreamContext)
  if (!stream) throw new Error('useMonitorStream 必须在 MonitorStreamProvider 内使用')
  return stream
}
