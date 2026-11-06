import type { Env } from '../shared/types'

/** 全局唯一的 MonitorDO 实例. 所有 Worker 入口共用同一份连接与运行态. */
export function monitorStub(env: Env): DurableObjectStub {
  return env.MONITOR.get(env.MONITOR.idFromName('global'))
}
