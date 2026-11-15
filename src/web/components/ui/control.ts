/**
 * 表单控件共享的上下文与外观.
 *
 * `controlBase` 由 Input / Select / Textarea 复用, 保证任何位置
 * (弹窗表单、列表筛选)高度完全一致; `FieldControlContext` 让控件
 * 自动关联 Field 生成的 id, 显式传入的 id 优先.
 */
import { createContext } from 'react'

export const FieldControlContext = createContext<string | undefined>(undefined)

/** 统一高度 36px. 不在此处放 margin: 间距由 Field 或调用方布局决定. */
export const controlBase =
  'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition'