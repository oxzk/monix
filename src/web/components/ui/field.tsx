/** 表单字段容器与字段级校验状态. */
import type { ReactElement, ReactNode } from 'react'
import { useCallback, useId, useState } from 'react'
import { Label as LabelPrimitive } from 'radix-ui'
import { FieldControlContext } from './control'

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
      <div className="text-sm">
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
      </div>
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