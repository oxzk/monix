/**
 * 品牌标识.
 *
 * 页面内的图形直接复用 `public/favicon.svg`: 标签页与界面共用同一份几何形状,
 * 不需要在两处同步维护. 图形本身是装饰性的, 语义由相邻的文字承担.
 */
import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

export function LogoMark({ className }: { className?: string }): ReactElement {
    return (
        <img
            src="/favicon.svg"
            alt=""
            draggable={false}
            className={cn('block shrink-0 select-none', className)}
        />
    )
}
