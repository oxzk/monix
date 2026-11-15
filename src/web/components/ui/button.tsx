/** 按钮. 支持变体、尺寸、加载态与 asChild(包裹 Link 等). */
import type { ButtonHTMLAttributes, ReactElement } from 'react'
import { Slot as SlotPrimitive } from 'radix-ui'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'danger' | 'ghost'
  size?: 'default' | 'sm' | 'lg' | 'icon'
  loading?: boolean
  /** 为 true 时把样式合并到唯一子元素上, 用于包裹 Link 等. */
  asChild?: boolean
}

const buttonVariants = {
  default: 'bg-slate-900 text-white hover:bg-slate-900/90',
  secondary: 'border border-slate-200 bg-white hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-rose-600 text-white hover:bg-rose-600/90',
  ghost: 'hover:bg-slate-100 hover:text-slate-900',
}

const buttonSizes = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3 text-xs',
  lg: 'h-10 rounded-md px-8',
  icon: 'h-9 w-9 shrink-0',
}

export function Button({
  className,
  variant = 'default',
  size = 'default',
  loading = false,
  disabled,
  children,
  asChild = false,
  type = 'button',
  ...props
}: ButtonProps): ReactElement {
  const classes = cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 disabled:pointer-events-none disabled:opacity-50',
    buttonVariants[variant],
    buttonSizes[size],
    className,
  )

  const content = (
    <>
      {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> : null}
      {children}
    </>
  )

  if (asChild) {
    return (
      <SlotPrimitive.Slot className={classes} aria-busy={loading || undefined} {...props}>
        {children}
      </SlotPrimitive.Slot>
    )
  }

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...props}
    >
      {content}
    </button>
  )
}