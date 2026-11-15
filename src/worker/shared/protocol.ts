/**
 * 协议与边界的单一来源.
 *
 * 这些常量同时被 Worker 路由、MonitorDO 与安装脚本/文档引用.
 * Rust Agent 侧有一份等价镜像 `agent/src/limits.rs`, 由
 * `npm run check`(scripts/check-consistency.mjs) 校验两侧是否一致.
 *
 * 修改顺序: 先改这里, 再同步 agent/src/limits.rs, 最后跑 npm run check.
 */

/** 终端尺寸硬性范围. */
export const TERMINAL_COLS_MIN = 20
export const TERMINAL_COLS_MAX = 500
export const TERMINAL_ROWS_MIN = 5
export const TERMINAL_ROWS_MAX = 200

/** 终端时长范围(秒). */
export const TERMINAL_IDLE_TIMEOUT_MIN = 60
export const TERMINAL_IDLE_TIMEOUT_MAX = 3_600
export const TERMINAL_MAX_DURATION_MIN = 300
export const TERMINAL_MAX_DURATION_MAX = 7_200

/** 命令执行参数范围. */
export const COMMAND_TIMEOUT_MIN = 5
export const COMMAND_TIMEOUT_MAX = 300
export const COMMAND_OUTPUT_MIN = 65_536
export const COMMAND_OUTPUT_MAX = 16_777_216

/** Agent 采集间隔范围(毫秒). */
export const COLLECT_INTERVAL_MIN = 1_000
export const COLLECT_INTERVAL_MAX = 300_000

/** 终端二进制帧边界. 与 agent/src/limits.rs 保持一致. */
export const TERMINAL_INPUT_MAX_BYTES = 8 * 1024
/** Agent 单批输出上限; DO 侧留出协议头余量后校验. */
export const TERMINAL_OUTPUT_BATCH_MAX_BYTES = 8 * 1024
/** DO 侧接收单帧的硬上限: 批次上限 + 1 字节类型 + 8 字节序列号 + 余量. */
export const TERMINAL_OUTPUT_FRAME_MAX_BYTES = TERMINAL_OUTPUT_BATCH_MAX_BYTES + 16

/** Agent Token 前缀: 用于从格式上区分旧记录. */
export const AGENT_TOKEN_PREFIX = 'mnx_'

/** 可修改配置项的硬性边界. 键为 `type.key`. */
export const SETTINGS_BOUNDS: Record<string, { min: number; max: number }> = {
  'agent.collect_interval': { min: COLLECT_INTERVAL_MIN, max: COLLECT_INTERVAL_MAX },
  'command.timeout_seconds': { min: COMMAND_TIMEOUT_MIN, max: COMMAND_TIMEOUT_MAX },
  'command.max_output_bytes': { min: COMMAND_OUTPUT_MIN, max: COMMAND_OUTPUT_MAX },
  'terminal.idle_timeout_seconds': { min: TERMINAL_IDLE_TIMEOUT_MIN, max: TERMINAL_IDLE_TIMEOUT_MAX },
  'terminal.max_duration_seconds': { min: TERMINAL_MAX_DURATION_MIN, max: TERMINAL_MAX_DURATION_MAX },
}
