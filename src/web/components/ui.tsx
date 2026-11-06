/**
 * 基础 UI 组件. 行为与可访问性来自 Radix, 视觉来自 Tailwind
 * (不加载 Radix Themes 的全局样式, 与 kryva 保持一致).
 */

import type {
  ComponentProps,
  ComponentPropsWithoutRef,
  ElementRef,
  ReactElement,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react'
import { createContext, forwardRef, useCallback, useContext, useId, useState } from 'react'
import { Button as RadixButton, IconButton, TextField, Box } from '@radix-ui/themes'
import { Dialog as DialogPrimitive, Label as LabelPrimitive, Select as SelectPrimitive, Switch as SwitchPrimitive, Tabs as TabsPrimitive } from 'radix-ui'
import { Check, ChevronDown, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ------------------------------- Button ------------------------------- */

export interface ButtonProps extends Omit<ComponentProps<typeof RadixButton>, 'variant' | 'size' | 'color'> {
  variant?: 'default' | 'secondary' | 'danger' | 'ghost'
  size?: 'default' | 'sm' | 'lg' | 'icon'
  loading?: boolean
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
  asChild,
  ...props
}: ButtonProps): ReactElement {
  const Component = size === 'icon' ? IconButton : RadixButton
  return (
    <Component
      asChild={asChild}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> : null}
          {children}
        </>
      )}
    </Component>
  )
}

/* -------------------------------- Input -------------------------------- */

const FieldControlContext = createContext<string | undefined>(undefined)

/**
 * 表单控件的共享尺寸与外观. Input / Select / Textarea 必须复用同一份,
 * 保证任何位置(弹窗表单、列表筛选)高度完全一致.
 *
 * 统一高度 36px. 不在此处放 margin: 间距由 Field 或调用方布局决定.
 */
const controlBase =
  'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition'

export interface InputProps extends Omit<ComponentProps<typeof TextField.Root>, 'size'> {}

export const Input = forwardRef<ElementRef<typeof TextField.Root>, InputProps>(
  ({ className, id, ...props }, ref) => {
    const fieldId = useContext(FieldControlContext)
    return (
      <TextField.Root
        ref={ref}
        id={id ?? fieldId}
        className={cn(
          'monix-text-field inline-flex items-center',
          controlBase,
          'focus-within:border-slate-900 focus-within:ring-4 focus-within:ring-slate-900/8 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
          'has-[:aria-invalid=true]:border-rose-500 has-[:aria-invalid=true]:focus-within:ring-rose-500/15',
          className,
        )}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

/** 多行输入. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition',
        'placeholder:text-slate-400 focus:border-slate-900 focus:ring-4 focus:ring-slate-900/8 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'

/* -------------------------------- Field -------------------------------- */

export function Field({
  label,
  id,
  hint,
  error,
  required = false,
  children,
}: {
  label: ReactNode
  id?: string
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  children: ReactNode
}): ReactElement {
  const generatedId = useId()
  const controlId = id ?? generatedId
  const errorId = `${controlId}-error`
  return (
    <FieldControlContext.Provider value={controlId}>
      <Box className="text-sm">
        <LabelPrimitive.Root htmlFor={controlId} className="font-medium text-slate-600">
          {label}
          {required ? <span className="ml-0.5 text-rose-500" aria-hidden="true">*</span> : null}
        </LabelPrimitive.Root>
        <div className="mt-1">{children}</div>
        {error ? (
          <p id={errorId} className="mt-1 text-xs leading-relaxed text-rose-600" role="alert">{error}</p>
        ) : hint ? (
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{hint}</p>
        ) : null}
      </Box>
    </FieldControlContext.Provider>
  )
}

/**
 * 字段级校验状态. 配合表单 `noValidate` 使用, 用控件下方提示替代浏览器原生气泡.
 */
export function useFieldErrors<K extends string>(): {
  errors: Partial<Record<K, string>>
  setError: (field: K, message: string) => void
  clearError: (field: K) => void
  clearAll: () => void
} {
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({})
  const setError = useCallback((field: K, message: string) => {
    setErrors((prev) => ({ ...prev, [field]: message }))
  }, [])
  const clearError = useCallback((field: K) => {
    setErrors((prev) => {
      if (!(field in prev)) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }, [])
  const clearAll = useCallback(() => setErrors({}), [])
  return { errors, setError, clearError, clearAll }
}

/* -------------------------------- Select -------------------------------- */

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
  id?: string
  invalid?: boolean
  required?: boolean
}

/** 基于 radix-ui Select 的下拉选择, 高度/内边距/焦点/错误态与 Input 复用同一份样式. */
export function Select({
  value,
  onChange,
  options,
  placeholder = '',
  disabled,
  className,
  ariaLabel,
  id,
  invalid = false,
  required = false,
}: SelectProps): ReactElement {
  const fieldId = useContext(FieldControlContext)
  const current = options.find((option) => option.value === value)
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id ?? fieldId}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        className={cn(
          'inline-flex items-center justify-between gap-2',
          controlBase,
          'focus:border-slate-900 focus:ring-4 focus:ring-slate-900/8 disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-rose-500 aria-[invalid=true]:focus:ring-rose-500/15',
          className,
        )}
      >
        {/*
         * 不使用 SelectPrimitive.Value: 它把空字符串视为"未选择"并回退到 placeholder,
         * 导致 value="" 的合法选项(如"不分组")显示成"请选择". 这里直接渲染标签.
         */}
        <span className={cn('truncate', current ? undefined : 'text-slate-400')}>
          {current ? current.label : placeholder}
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          className="z-50 max-h-[min(60vh,320px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-slate-200 bg-white p-1 text-sm text-slate-900 shadow-lg"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="relative flex cursor-pointer select-none items-center justify-between rounded-md px-2 py-1.5 pl-7 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-slate-100"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute left-2">
                  <Check className="h-3.5 w-3.5" aria-hidden />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/* -------------------------------- Switch -------------------------------- */

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  ariaLabel?: string
}

/** 开关. 行为与键盘交互来自 Radix Switch, 视觉为 Tailwind. */
export function Switch({
  checked,
  onChange,
  disabled,
  id,
  ariaLabel,
}: SwitchProps): ReactElement {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-slate-900 bg-slate-900' : 'border-slate-200 bg-slate-200',
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform',
          'translate-x-0.5 data-[state=checked]:translate-x-[18px]',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

/* -------------------------------- Dialog -------------------------------- */

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

/** 常用组合: 标题 + 描述 + 内容 + 底部动作. */
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

/* -------------------------------- Badge -------------------------------- */

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'accent'
}): ReactElement {
  const tones = {
    default: 'bg-slate-100 text-slate-600',
    success: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-800',
    danger: 'bg-rose-50 text-rose-700',
    accent: 'bg-slate-900 text-white',
  }
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  )
}

/* -------------------------------- Tabs -------------------------------- */

export interface TabsOption<T extends string = string> {
  value: T
  label: string
}

/**
 * 下划线分段选项卡. 行为与键盘导航来自 Radix Tabs, 视觉为下划线风格.
 */
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
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20',
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
