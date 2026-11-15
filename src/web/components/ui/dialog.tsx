/** 弹窗: 基础部件 + 常用组合 AppDialog. */
import type { ComponentPropsWithoutRef, ElementRef, ReactElement, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px]', className)}
    {...props}
  />
))
DialogOverlay.displayName = 'DialogOverlay'

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 flex max-h-[min(90vh,720px)] w-[min(100%-2rem,560px)] -translate-x-1/2 -translate-y-1/2 flex-col',
        'rounded-xl border border-slate-200 bg-white shadow-xl outline-none',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
        aria-label="关闭"
      >
        <X className="h-4 w-4" aria-hidden />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
DialogContent.displayName = 'DialogContent'

export function DialogHeader({ children }: { children: ReactNode }): ReactElement {
  return <div className="border-b border-slate-100 px-5 py-4 pr-12">{children}</div>
}

export function DialogTitle({ children }: { children: ReactNode }): ReactElement {
  return (
    <DialogPrimitive.Title className="text-base font-semibold text-slate-900">{children}</DialogPrimitive.Title>
  )
}

export function DialogDescription({ children }: { children: ReactNode }): ReactElement {
  return (
    <DialogPrimitive.Description className="mt-1 text-sm text-slate-500">
      {children}
    </DialogPrimitive.Description>
  )
}

export function DialogBody({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)}>{children}</div>
}

export function DialogFooter({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
      {children}
    </div>
  )
}

/** 常用组合: 标题 + 内容 + 底部动作. */
export function AppDialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  width,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={width ? { width } : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  )
}