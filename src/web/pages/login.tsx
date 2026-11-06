/**
 * 登录页.
 *
 * 校验在提交时本地完成, 错误显示在字段下方, 不使用浏览器原生气泡.
 */
import { useState, type FormEvent, type ReactElement } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { authApi } from '@/api/resources'
import { useSession } from '@/auth/session-provider'
import { Button, Field, Input, useFieldErrors } from '@/components/ui'
import { LogoMark } from '@/components/logo'
import { useToast } from '@/components/toast'

function safeNextPath(raw: string | null): string {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/'
    return raw
}

export function LoginPage(): ReactElement {
    const { authenticated, loading, refresh } = useSession()
    const [params] = useSearchParams()
    const [username, setUsername] = useState('admin')
    const [password, setPassword] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const { toast } = useToast()
    const { errors, setError: setFieldError, clearAll } = useFieldErrors<'username' | 'password'>()

    const nextPath = safeNextPath(params.get('next'))

    if (!loading && authenticated) return <Navigate to={nextPath} replace />

    async function handleSubmit(event: FormEvent): Promise<void> {
        event.preventDefault()
        clearAll()

        // 自行校验, 用控件下方提示替代浏览器原生气泡.
        if (!username.trim()) {
            setFieldError('username', '请输入用户名')
            return
        }
        if (!password) {
            setFieldError('password', '请输入密码')
            return
        }

        setSubmitting(true)
        try {
            await authApi.login(username.trim(), password)
            await refresh()
        } catch (err) {
            toast({ variant: 'error', title: '登录失败', description: err instanceof Error ? err.message : undefined })
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="page-shell">
            <div className="surface px-6 py-8 sm:px-8 sm:py-10">
                <div className="flex items-center gap-3">
                    <LogoMark className="h-12 w-12" />
                    <div className="leading-tight">
                        <div className="text-xl font-semibold tracking-[-0.02em] text-slate-900">Monix</div>
                        <div className="text-xs text-slate-400">服务器监控与远程运维</div>
                    </div>
                </div>

                <p className="mt-6 text-sm text-slate-500">登录以查看服务器状态并执行远程命令。</p>

                <form className="mt-5 space-y-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
                    <Field label="用户名" required error={errors.username}>
                        <Input
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            autoComplete="username"
                            aria-invalid={errors.username ? true : undefined}
                        />
                    </Field>
                    <Field label="密码" required error={errors.password}>
                        <Input
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete="current-password"
                            aria-invalid={errors.password ? true : undefined}
                            autoFocus
                        />
                    </Field>


                    <Button type="submit" loading={submitting} className="w-full">
                        登录
                    </Button>
                </form>

                <div className="mt-6 flex items-center gap-1.5 border-t border-slate-100 pt-4 text-[11px] text-slate-400">
                    <ShieldCheck size={13} aria-hidden />
                    HttpOnly · Secure · SameSite=Strict
                </div>
            </div>
        </div>
    )
}
