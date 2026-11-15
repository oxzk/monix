//! 协议边界的本地镜像.
//!
//! 权威定义在 `src/worker/shared/protocol.ts`. 这里必须与之一致,
//! 由 `npm run check`(scripts/check-consistency.mjs) 校验两侧相等.
//! 修改时先改 TS 侧, 再同步本文件.

/// 终端尺寸范围.
pub const TERMINAL_COLS_MIN: u16 = 20;
pub const TERMINAL_COLS_MAX: u16 = 500;
pub const TERMINAL_ROWS_MIN: u16 = 5;
pub const TERMINAL_ROWS_MAX: u16 = 200;

/// 终端时长范围(秒).
pub const TERMINAL_IDLE_TIMEOUT_MIN: u64 = 60;
pub const TERMINAL_IDLE_TIMEOUT_MAX: u64 = 3_600;
pub const TERMINAL_MAX_DURATION_MIN: u64 = 300;
pub const TERMINAL_MAX_DURATION_MAX: u64 = 7_200;

/// 命令执行参数范围.
pub const COMMAND_TIMEOUT_MIN: u64 = 5;
pub const COMMAND_TIMEOUT_MAX: u64 = 300;
pub const COMMAND_OUTPUT_MIN: usize = 65_536;
pub const COMMAND_OUTPUT_MAX: usize = 16_777_216;

/// 采集间隔范围(毫秒).
pub const COLLECT_INTERVAL_MIN: u64 = 1_000;
pub const COLLECT_INTERVAL_MAX: u64 = 300_000;

/// 终端输入帧载荷上限.
pub const TERMINAL_INPUT_MAX_BYTES: usize = 8 * 1024;
/// 终端单批输出上限(与 DO 侧校验一致).
pub const TERMINAL_OUTPUT_BATCH_MAX_BYTES: usize = 8 * 1024;
