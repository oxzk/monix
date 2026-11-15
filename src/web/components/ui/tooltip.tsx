/** 悬停提示与全局 Provider. */
import type { ReactElement, ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export interface TooltipProviderProps {
  children: ReactNode
  /** 悬停多久后显示, 毫秒. */
  delayDuration?: number
}

/** 全局只挂一次, 用于共享悬停计时, 让相邻提示立即切换. */
export function TooltipProvider({ children, delayDuration = 200 }: TooltipProviderProps): ReactElement {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={100}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

export interface TooltipProps {
  /** 提示文案; 为空时不渲染提示层. */
  content: ReactNode
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
}

/**
 * 悬停提示.
 *
 * 用于图标按钮这类没有可见文字的控件, 补充说明用途.
 * 触发元素必须可聚焦, 因此这里用 asChild 包裹原元素而非额外套一层 span.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps): ReactElement {
  if (!content) return children

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-[200] max-w-[min(90vw,20rem)] rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg',
            'select-none',
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-slate-900" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}