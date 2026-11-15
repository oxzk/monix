/** 二次确认弹窗(参考 pusho): 危险操作前统一确认, 支持异步执行与加载态. */
import type { ReactElement, ReactNode } from 'react'
import { AppDialog } from './dialog'
import { Button } from './button'

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmText = '确认',
    danger = false,
    loading = false,
    onConfirm,
    children,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    description?: ReactNode
    confirmText?: string
    danger?: boolean
    loading?: boolean
    onConfirm: () => void
    children?: ReactNode
}): ReactElement {
    return (
        <AppDialog
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            width="min(100% - 2rem, 440px)"
            footer={
                <>
                    <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
                        取消
                    </Button>
                    <Button variant={danger ? 'danger' : 'default'} onClick={onConfirm} loading={loading}>
                        {confirmText}
                    </Button>
                </>
            }
        >
            <div className="space-y-1.5 text-sm leading-relaxed text-slate-600">
                {description ? <p className="font-medium text-slate-800">{description}</p> : null}
                <p>{children ?? '此操作不可撤销, 请确认。'}</p>
            </div>
        </AppDialog>
    )
}
