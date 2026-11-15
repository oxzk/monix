#!/usr/bin/env node
/**
 * 校验安全响应头与协议边界常量的单一来源.
 *
 * 1. `src/worker/app.ts` 的 SECURITY_HEADERS 与 `public/_headers` 必须一致.
 *    静态资源由 assets 层直接返回, 不经过 Worker, 因此两处必须手工同步;
 *    本脚本把"必须保持一致"从注释变成可执行的检查.
 * 2. `src/worker/shared/protocol.ts` 与 `agent/src/limits.rs` 的边界常量必须相等.
 *
 * 用法: node scripts/check-consistency.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(resolve(root, relative), 'utf8')

const failures = []

/* ---------------- 1. 安全响应头 ---------------- */

const appSource = read('src/worker/app.ts')
const headersFile = read('public/_headers')

/** 从 app.ts 的 SECURITY_HEADERS 数组中提取 [name, value] 对. */
function parseWorkerHeaders(source) {
  // 数组字面量以顶格的 `]` 结束; 不能用 `\n\]` 匹配, 否则会在内层 CSP 数组
  // 的缩进 `]` 之前就截断(内层缩进为 4 空格, 不匹配顶格).
  const start = source.indexOf('const SECURITY_HEADERS')
  if (start < 0) throw new Error('未能在 src/worker/app.ts 中定位 SECURITY_HEADERS')
  const end = source.indexOf('\n]', start)
  if (end < 0) throw new Error('SECURITY_HEADERS 数组未正常结束')
  // 先剔除行注释: 注释里会出现 `'self'` 之类的字面量, 会被后面的引号扫描误采.
  const block = source
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')

  const entries = {}

  // 形如 ['Header-Name', ['a', 'b'].join('; ')] 的多行 CSP:
  // 先摘出这种形态, 再处理普通的单行条目, 避免正则互相干扰.
  // 注意 `[` 与头部名之间可能有换行与缩进.
  const joinedPattern = /\[\s*'([^']+)'\s*,\s*\[([\s\S]*?)\]\s*\.join\(';\s*'\)\s*,?\s*\]/g
  let match
  while ((match = joinedPattern.exec(block)) !== null) {
    const parts = [...match[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map((item) => item[1] ?? item[2])
    entries[match[1]] = parts.join('; ')
  }

  const simple = /\[\s*'([^']+)'\s*,\s*'([^']*)'\s*\]/g
  while ((match = simple.exec(block)) !== null) {
    entries[match[1]] ??= match[2]
  }

  return entries
}

/** 从 public/_headers 的 `/*` 块中提取 [name, value] 对. */
function parseHeadersFile(source) {
  const lines = source.split('\n')
  const entries = {}
  let inBlock = false
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inBlock = line.trim() === '/*'
      continue
    }
    if (!inBlock) continue
    const match = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (match) entries[match[1]] = match[2].trim()
  }
  return entries
}

const workerHeaders = parseWorkerHeaders(appSource)
const staticHeaders = parseHeadersFile(headersFile)

for (const [name, value] of Object.entries(workerHeaders)) {
  if (!(name in staticHeaders)) {
    failures.push(`public/_headers 缺少响应头 ${name}`)
    continue
  }
  if (staticHeaders[name] !== value) {
    failures.push(`响应头 ${name} 两处不一致:\n  app.ts : ${value}\n  _headers: ${staticHeaders[name]}`)
  }
}
for (const name of Object.keys(staticHeaders)) {
  if (!(name in workerHeaders)) {
    failures.push(`src/worker/app.ts 缺少 public/_headers 中的响应头 ${name}`)
  }
}

/* ---------------- 2. 协议边界常量 ---------------- */

const protocolSource = read('src/worker/shared/protocol.ts')
const limitsSource = read('agent/src/limits.rs')

/** 只保留数字、标识符与四则运算, 防止把任意代码当表达式求值. */
const SAFE_EXPR = /^[\s0-9A-Za-z_*+()/-]+$/

/**
 * 求值一个常量表达式.
 *
 * 常量之间会互相引用(如 `A + 64`), 因此按声明顺序迭代直到无法继续,
 * 支持引用同一文件中先声明的常量. 只允许数字与四则运算, 不做通用 eval.
 */
function evaluateConstants(declarations) {
  const values = {}
  let progress = true
  while (progress) {
    progress = false
    for (const [name, expression] of Object.entries(declarations)) {
      if (name in values) continue
      // 把已知常量替换成数字字面量.
      const substituted = expression
        .split(/([A-Za-z_][A-Za-z0-9_]*)/)
        .map((token) => {
          if (/^[A-Za-z_]/.test(token)) {
            const value = values[token]
            return value === undefined ? token : String(value)
          }
          return token
        })
        .join('')
        .replaceAll('_', '')

      // 仍含未解析标识符时跳过, 等下一轮.
      if (/[A-Za-z_]/.test(substituted)) continue
      if (!SAFE_EXPR.test(substituted)) continue

      try {
        const result = Function(`"use strict"; return (${substituted});`)()
        if (typeof result === 'number' && Number.isFinite(result)) {
          values[name] = result
          progress = true
        }
      } catch {
        // 不是可求值表达式, 忽略.
      }
    }
  }
  return values
}

/** 提取 TS 中 `export const NAME = <expr>` 的表达式部分. */
function collectTsDeclarations(source) {
  const declarations = {}
  const pattern = /export const ([A-Z0-9_]+)\s*=\s*([^\n;]+)/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    declarations[match[1]] = match[2].trim()
  }
  return declarations
}

/** 提取 Rust 中 `pub const NAME: T = <expr>;` 的表达式部分. */
function collectRustDeclarations(source) {
  const declarations = {}
  const pattern = /pub const ([A-Z0-9_]+)\s*:\s*[a-z0-9]+\s*=\s*([^;]+);/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    declarations[match[1]] = match[2].trim()
  }
  return declarations
}

const tsConstants = evaluateConstants(collectTsDeclarations(protocolSource))
const rustConstants = evaluateConstants(collectRustDeclarations(limitsSource))

/** Rust 侧的命名与 TS 一致, 直接逐项比对共享的边界常量. */
const SHARED_PREFIXES = ['TERMINAL_', 'COMMAND_', 'COLLECT_']

/**
 * 仅由 Worker 侧使用、Agent 侧无需镜像的常量.
 *
 * 这些是接收方(envelope)的校验上限, 由发送上限推导而来, 不属于双方约定.
 */
const WORKER_ONLY = new Set(['TERMINAL_OUTPUT_FRAME_MAX_BYTES'])

for (const [name, tsValue] of Object.entries(tsConstants)) {
  if (!SHARED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
  if (WORKER_ONLY.has(name)) continue
  const rustValue = rustConstants[name]
  if (rustValue === undefined) {
    failures.push(`agent/src/limits.rs 缺少常量 ${name} (src/worker/shared/protocol.ts 中为 ${tsValue})`)
    continue
  }
  if (rustValue !== tsValue) {
    failures.push(`常量 ${name} 两侧不一致: protocol.ts=${tsValue}, limits.rs=${rustValue}`)
  }
}

/* ---------------- 结果 ---------------- */

if (failures.length > 0) {
  console.error('❌ 一致性检查失败:\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('')
  process.exit(1)
}

console.log(
  `✅ 一致性检查通过: ${Object.keys(workerHeaders).length} 个响应头一致, ` +
    `${Object.keys(rustConstants).length} 个 Rust 常量与 TS 侧匹配`,
)
