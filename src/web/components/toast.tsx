/**
 * Toast 通知: 默认 5 秒自动消失, 文案可选中复制. 参考 anvil 的实现.
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const DEFAULT_DURATION = 5000
const MAX_TOASTS = 3

export type ToastVariant = 'default' | 'success' | 'error'

export interface ToastItem {
  id: string
  title: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

interface ToastContextValue {
  toast: (input: Omit<ToastItem, 'id'>) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 须在 ToastProvider 内使用')
  return ctx
}

function ToastIcon({ variant }: { variant?: ToastVariant }): ReactElement {
  if (variant === 'success') {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
  }
  if (variant === 'error') {
    return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
  }
  return <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
}

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem
  onDismiss: (id: string) => void
}): ReactElement {
  const [open, setOpen] = useState(true)
  const [remaining, setRemaining] = useState(1)
  const duration = item.duration ?? DEFAULT_DURATION

  // 自管计时, 不依赖 Radix 的 duration/pause.
  useEffect(() => {
    if (!open) return
    const started = performance.now()
    let frame = 0

    const tick = (): void => {
      const left = Math.max(0, 1 - (performance.now() - started) / duration)
      setRemaining(left)
      if (left === 0) {
        setOpen(false)
        onDismiss(item.id)
        return
      }
      frame = window.requestAnimationFrame(tick)
    }

    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [open, duration, item.id, onDismiss])

  const barColor =
    item.variant === 'success'
      ? 'bg-emerald-500'
      : item.variant === 'error'
        ? 'bg-rose-500'
        : 'bg-slate-400'

  return (
    <ToastPrimitive.Root
      open={open}
      duration={Infinity}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) onDismiss(item.id)
      }}
      style={{ userSelect: 'text', touchAction: 'auto' }}
      className={cn(
        'group pointer-events-auto relative flex w-[min(100vw-2rem,356px)] items-start gap-3',
        'overflow-hidden rounded-lg border border-slate-200 bg-white p-4 text-slate-950 shadow-lg outline-none',
      )}
    >
      <ToastIcon variant={item.variant} />
      <div className="min-w-0 flex-1 select-text" onPointerDown={(e) => e.stopPropagation()}>
        <ToastPrimitive.Title className="text-sm font-semibold leading-none tracking-tight">
          {item.title}
        </ToastPrimitive.Title>
        {item.description ? (
          <ToastPrimitive.Description className="mt-1 break-words text-sm text-slate-500">
            {item.description}
          </ToastPrimitive.Description>
        ) : null}
      </div>
      <ToastPrimitive.Close
        className={cn(
          'absolute right-2 top-2 rounded-md p-1 text-slate-400 opacity-0 transition',
          'hover:bg-slate-100 hover:text-slate-700',
          'focus:opacity-100 focus:outline-none group-hover:opacity-100',
        )}
        aria-label="关闭"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </ToastPrimitive.Close>
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-slate-100" aria-hidden>
        <div className={cn('h-full origin-left', barColor)} style={{ transform: `scaleX(${remaining})` }} />
      </div>
    </ToastPrimitive.Root>
  )
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: string): void => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((input: Omit<ToastItem, 'id'>): void => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const item: ToastItem = { id, duration: DEFAULT_DURATION, variant: 'default', ...input }
    setItems((prev) => [...prev, item].slice(-MAX_TOASTS))
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      <ToastPrimitive.Provider swipeDirection="right" duration={DEFAULT_DURATION}>
        {children}
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={dismiss} />
        ))}
        <ToastPrimitive.Viewport className="fixed right-4 top-4 z-[100] flex max-h-screen w-auto flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}
