/**
 * 骨架屏基元: 加载占位.
 *
 * pulse 呼吸 + 结构化线条, 由调用方组合成对齐真实内容的形态,
 * 避免加载完成后的布局跳动. 配色走前台主题变量.
 */
import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

export function Skeleton({ className }: { className?: string }): ReactElement {
    return <div aria-hidden className={cn('animate-pulse rounded-md bg-[var(--p-line)]', className)} />
}
