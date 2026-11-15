/** 下划线分段选项卡. 行为与键盘导航来自 Radix Tabs, 视觉为下划线风格. */
import type { ReactElement } from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export interface TabsOption<T extends string = string> {
  value: T
  label: string
}

export function Tabs<T extends string = string>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<TabsOption<T>>
  className?: string
  ariaLabel?: string
}): ReactElement {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsPrimitive.List
        aria-label={ariaLabel}
        className={cn('flex h-10 flex-wrap items-end gap-x-6 gap-y-1 border-b border-slate-200', className)}
      >
        {options.map((option) => (
          <TabsPrimitive.Trigger
            key={option.value}
            value={option.value}
            className={cn(
              'inline-flex h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap',
              'border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
              // 浏览器与 Radix 都会给聚焦的 tab 画轮廓, 鼠标点击后会残留方框.
              // 这里全部去掉: 激活态本身已有下划线指示, 不再额外绘制焦点样式,
              // 避免与 border-b-2 叠加导致下划线变粗.
              'outline-none focus:outline-none focus-visible:outline-none',
              'data-[state=active]:border-slate-900 data-[state=active]:text-slate-900',
              'data-[state=inactive]:border-transparent data-[state=inactive]:text-slate-500 data-[state=inactive]:hover:text-slate-900',
            )}
          >
            {option.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  )
}