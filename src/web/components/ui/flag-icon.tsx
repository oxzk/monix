/**
 * 国旗图标: 按两位国家代码引用本地 `public/flags/*.svg`.
 *
 * 旗帜资源来自 CF-Server-Monitor(MIT License), 构建后由静态资源层同源提供.
 * 加载失败(未知代码/资源缺失)时隐藏自身, 避免出现破损图标.
 */
import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

export function FlagIcon({
    countryCode,
    className = 'h-4 w-6 rounded-[2px] object-cover',
}: {
    countryCode: string | null | undefined
    className?: string
}): ReactElement | null {
    if (!countryCode || !/^[a-zA-Z]{2}$/.test(countryCode)) return null
    return (
        <img
            src={`/flags/${countryCode.toLowerCase()}.svg`}
            alt=""
            loading="lazy"
            draggable={false}
            className={cn('block shrink-0 select-none', className)}
            onError={(event) => {
                event.currentTarget.style.display = 'none'
            }}
        />
    )
}