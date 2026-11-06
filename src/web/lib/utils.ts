import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs))
}

/** 容量: 字节 → 人类可读. */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
    if (bytes < 1024) return `${Math.round(bytes)} B`
    const units = ['KB', 'MB', 'GB', 'TB', 'PB']
    let value = bytes / 1024
    let index = 0
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
    }
    return `${value.toFixed(digits)} ${units[index]}`
}

/** 速率: 字节/秒. */
export function formatRate(bytesPerSec: number | null | undefined): string {
    if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '—'
    return `${formatBytes(bytesPerSec, 1)}/s`
}

/** 百分比, 保留一位小数. */
export function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—'
    return `${value.toFixed(1)}%`
}

/** 相对时间, 用于"最近上报". */
export function formatAgo(ts: number | null | undefined, now = Date.now()): string {
    if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—'
    const diff = Math.max(0, now - ts)
    if (diff < 5_000) return '刚刚'
    if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 运行时长: 秒 → 天/小时. */
export function formatUptime(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '—'
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    if (days > 0) return `${days} 天 ${hours} 小时`
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${hours} 小时 ${minutes} 分`
}
