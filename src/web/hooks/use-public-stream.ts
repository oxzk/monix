/**
 * 公开状态页的实时订阅.
 *
 * 只连接 `/api/v1/stream`(匿名只读), 接收快照、脱敏指标与在线状态.
 * 前端不轮询: 指标与状态只来自该通道, 断开后指数退避重连.
 * 25 秒一次的字面量 keepalive ping 由 DO 的 auto-response 免唤醒应答,
 * 防止中间代理掐断空闲连接, 也不产生 DO 唤醒/时长费用.
 */
import { useEffect, useState } from 'react'
import type { PublicMetrics } from '@/api/types'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** keepalive 间隔: 字面量 ping, 由 DO auto-response 应答, 不唤醒 DO. */
const KEEPALIVE_MS = 25_000

export interface PublicSnapshot {
  serverId: string
  status: 'online' | 'offline'
  sampleTs: number | null
  receivedTs: number | null
  metrics: PublicMetrics | null
}

interface SnapshotEvent {
  type: 'snapshot'
  servers: PublicSnapshot[]
}

interface MetricsEvent {
  type: 'metrics'
  serverId: string
  sampleTs: number | null
  receivedTs: number
  metrics: PublicMetrics | null
}

interface StatusEvent {
  type: 'server.status'
  serverId: string
  status: 'online' | 'offline'
  ts: number
}

type PublicEvent = SnapshotEvent | MetricsEvent | StatusEvent

export interface PublicStream {
  connected: boolean
  snapshots: Map<string, PublicSnapshot>
}

export function usePublicStream(): PublicStream {
  const [connected, setConnected] = useState(false)
  const [snapshots, setSnapshots] = useState<Map<string, PublicSnapshot>>(new Map())

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: number | null = null
    let attempt = 0

    const apply = (event: PublicEvent): void => {
      if (event.type === 'snapshot') {
        const next = new Map<string, PublicSnapshot>()
        for (const item of event.servers) next.set(item.serverId, item)
        setSnapshots(next)
        return
      }
      if (event.type === 'metrics') {
        setSnapshots((prev) => {
          const next = new Map(prev)
          next.set(event.serverId, {
            serverId: event.serverId,
            status: 'online',
            sampleTs: event.sampleTs,
            receivedTs: event.receivedTs,
            metrics: event.metrics,
          })
          return next
        })
        return
      }
      setSnapshots((prev) => {
        const next = new Map(prev)
        const existing = next.get(event.serverId)
        next.set(event.serverId, {
          serverId: event.serverId,
          status: event.status,
          sampleTs: existing?.sampleTs ?? null,
          receivedTs: existing?.receivedTs ?? null,
          // 离线后不保留过期指标, 与服务端语义一致.
          metrics: event.status === 'online' ? (existing?.metrics ?? null) : null,
        })
        return next
      })
    }

    const connect = (): void => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/stream`)

      socket.onopen = (): void => {
        attempt = 0
        setConnected(true)
      }

      socket.onmessage = (event: MessageEvent): void => {
        if (typeof event.data !== 'string') return
        try {
          apply(JSON.parse(event.data) as PublicEvent)
        } catch {
          // 非法消息忽略, 不断开连接.
        }
      }

      socket.onclose = (): void => {
        socket = null
        setConnected(false)
        if (disposed) return
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
        attempt += 1
        const jitter = delay * 0.3 * Math.random()
        retryTimer = window.setTimeout(connect, delay + jitter)
      }

      socket.onerror = (): void => {
        // onclose 会跟进.
      }
    }

    connect()

    // keepalive: 空载(30s 上报间隔)期间保持中间设备不掐连接.
    const keepalive = window.setInterval(() => {
      if (disposed || document.hidden) return
      if (socket && socket.readyState === WebSocket.OPEN) socket.send('ping')
    }, KEEPALIVE_MS)

    return () => {
      disposed = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      window.clearInterval(keepalive)
      socket?.close()
      socket = null
    }
  }, [])

  return { connected, snapshots }
}