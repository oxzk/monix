/** 单行/多行输入. 错误态通过 aria-invalid 触发. */
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { forwardRef, useContext } from 'react'
import { cn } from '@/lib/utils'
import { controlBase, FieldControlContext } from './control'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, id, ...props }, ref) => {
    const fieldId = useContext(FieldControlContext)
    return (
      <input
        ref={ref}
        id={id ?? fieldId}
        className={cn(
          controlBase,
          'placeholder:text-slate-400 focus:border-slate-900 focus:ring-4 focus:ring-slate-900/8 disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-rose-500 aria-[invalid=true]:focus:ring-rose-500/15',
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