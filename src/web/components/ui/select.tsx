/** 下拉选择. 高度/内边距/焦点/错误态与 Input 复用 controlBase. */
import type { ReactElement } from 'react'
import { useContext } from 'react'
import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { controlBase, FieldControlContext } from './control'

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