/**
 * 登录页(视觉参考 python/ternox).
 *
 * 全屏暗色终端风: 点阵背景 + CRT 扫描线 + ASCII LOGO + 玻璃卡片表单.
 * 校验在提交时本地完成, 错误以 `[!]` 行展示并抖动提示, 不使用浏览器原生气泡.
 */
import { useState, type FormEvent, type ReactElement } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { authApi } from '@/api/resources'
import { useSession } from '@/auth/session-provider'
import { useFieldErrors } from '@/components/ui'

function safeNextPath(raw: string | null): string {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/servers'
    return raw
}

/** ANSI Shadow 风格 ASCII LOGO: MONIX. */
const ASCII_LOGO = String.raw`
███╗   ███╗  ██████╗  ███╗   ██╗ ██╗ ██╗  ██╗
████╗ ████║ ██╔═══██╗ ████╗  ██║ ██║ ╚██╗ ██╔╝
██╔████╔██║ ██║   ██║ ██╔██╗ ██║ ██║  ╚███╔╝ 
██║╚██╔╝██║ ██║   ██║ ██║╚██╗██║ ██║  ██╔██╗ 
██║ ╚═╝ ██║ ╚██████╔╝ ██║ ╚████║ ██║ ██╔╝ ╚██╗
╚═╝     ╚═╝  ╚═════╝  ╚═╝  ╚═══╝ ╚═╝ ╚═╝   ╚═╝
`.trimStart()

export function LoginPage(): ReactElement {
    const { authenticated, loading, refresh } = useSession()
    const [params] = useSearchParams()
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    // 两步验证: 密码正确且服务端返回 TOTP_REQUIRED 后才展示验证码输入.
    const [totpCode, setTotpCode] = useState('')
    const [needsTotp, setNeedsTotp] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [apiError, setApiError] = useState<string | null>(null)
    const { errors, setError: setFieldError, clearAll } = useFieldErrors<'username' | 'password' | 'totp'>()

    const nextPath = safeNextPath(params.get('next'))

    if (!loading && authenticated) return <Navigate to={nextPath} replace />

    async function handleSubmit(event: FormEvent): Promise<void> {
        event.preventDefault()
        if (submitting) return
        clearAll()
        setApiError(null)

        // 自行校验, 用表单内 [!] 行替代浏览器原生气泡.
        if (!username.trim()) {
            setFieldError('username', '请输入用户名')
            return
        }
        if (!password) {
            setFieldError('password', '请输入密码')
            return
        }
        if (needsTotp && !/^\d{6}$/.test(totpCode.trim())) {
            setFieldError('totp', '请输入 6 位动态验证码')
            return
        }

        setSubmitting(true)
        try {
            await authApi.login(username.trim(), password, needsTotp ? totpCode.trim() : undefined)
            await refresh()
        } catch (err) {
            if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') {
                // 密码通过, 等待动态码: 不当作错误展示, 只切换表单.
                setNeedsTotp(true)
                setTotpCode('')
                setApiError(null)
                return
            }
            if (err instanceof ApiError && err.code === 'TOTP_INVALID') {
                setNeedsTotp(true)
                setTotpCode('')
                setApiError('动态验证码错误')
                return
            }
            setApiError(err instanceof Error ? err.message : '登录失败')
            setPassword('')
            setNeedsTotp(false)
            setTotpCode('')
        } finally {
            setSubmitting(false)
        }
    }

    const fieldError = (key: 'username' | 'password' | 'totp'): string | null => {
        const message = errors[key]
        return message ? `[!] ${message}` : null
    }

    return (
        <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#0f1220] px-4 font-mono">
            {/* 背景: 点阵网格 + 扫描线 + 冷色光晕 */}
            <div className="login-dots pointer-events-none absolute inset-0 opacity-40" aria-hidden />
            <div className="crt-lines pointer-events-none absolute inset-0 z-20 opacity-30" aria-hidden />
            <div
                className="pointer-events-none absolute -top-32 left-1/4 h-96 w-96 rounded-full bg-emerald-400/10 blur-[130px]"
                aria-hidden
            />
            <div
                className="pointer-events-none absolute bottom-[-6rem] right-[12%] h-80 w-80 rounded-full bg-cyan-400/10 blur-[120px]"
                aria-hidden
            />

            <div className="relative z-10 flex w-full max-w-md flex-col items-center">
                {/* ASCII LOGO */}
                <pre
                    aria-label="MONIX"
                    className="login-glow select-none text-center text-[7px] leading-[9px] text-emerald-300 sm:text-[11px] sm:leading-[13px]"
                >
                    {ASCII_LOGO}
                </pre>
                <p className="mt-2 text-[11px] tracking-[0.35em] text-slate-500">SERVER MONITORING</p>

                {/* 表单卡片 */}
                <form
                    noValidate
                    onSubmit={(event) => void handleSubmit(event)}
                    className="mt-9 w-full rounded-xl border border-slate-700 bg-[#0f1220]/70 p-7 shadow-[0_8px_40px_rgba(0,0,0,0.45)] backdrop-blur-md"
                >
                    <div className="mb-6 flex items-center justify-between">
                        <span className="text-[11px] tracking-[0.25em] text-slate-500">AUTHENTICATION</span>
                        <span className="flex gap-1.5" aria-hidden>
                            <i className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
                            <i className="h-1.5 w-1.5 rounded-full bg-cyan-400/50" />
                            <i className="h-1.5 w-1.5 rounded-full bg-slate-400/40" />
                        </span>
                    </div>

                    <label
                        htmlFor="username"
                        className="mb-1.5 block text-[11px] tracking-wider text-slate-500"
                    >
                        用户名
                    </label>
                    <div className="mb-4 rounded-lg border border-slate-700 bg-[#151b2b] transition focus-within:border-emerald-400/70 focus-within:shadow-[0_0_0_3px_rgba(52,211,153,0.12)]">
                        <input
                            id="username"
                            name="username"
                            autoComplete="username"
                            autoFocus
                            spellCheck={false}
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            aria-invalid={errors.username ? true : undefined}
                            className="w-full rounded-lg bg-transparent px-3 py-2.5 text-sm text-slate-100 caret-emerald-300 outline-none placeholder:text-slate-600"
                        />
                    </div>
                    {fieldError('username') ? (
                        <p className="login-shake -mt-2 mb-4 text-xs text-rose-400" role="alert">
                            {fieldError('username')}
                        </p>
                    ) : null}

                    <label
                        htmlFor="password"
                        className="mb-1.5 block text-[11px] tracking-wider text-slate-500"
                    >
                        密码
                    </label>
                    <div className="mb-5 rounded-lg border border-slate-700 bg-[#151b2b] transition focus-within:border-emerald-400/70 focus-within:shadow-[0_0_0_3px_rgba(52,211,153,0.12)]">
                        <input
                            id="password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            aria-invalid={errors.password ? true : undefined}
                            className="w-full rounded-lg bg-transparent px-3 py-2.5 text-sm text-slate-100 caret-emerald-300 outline-none"
                        />
                    </div>
                    {fieldError('password') || apiError ? (
                        <p className="login-shake mb-4 text-xs text-rose-400" role="alert">
                            {fieldError('password') ?? `[!] ${apiError}`}
                        </p>
                    ) : null}

                    {needsTotp ? (
                        <>
                            <label
                                htmlFor="totp"
                                className="mb-1.5 block text-[11px] tracking-wider text-slate-500"
                            >
                                动态验证码
                            </label>
                            <div className="mb-5 rounded-lg border border-slate-700 bg-[#151b2b] transition focus-within:border-emerald-400/70 focus-within:shadow-[0_0_0_3px_rgba(52,211,153,0.12)]">
                                <input
                                    id="totp"
                                    name="totp"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    autoFocus
                                    maxLength={6}
                                    spellCheck={false}
                                    value={totpCode}
                                    onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                                    aria-invalid={errors.totp ? true : undefined}
                                    placeholder="6 位数字"
                                    className="w-full rounded-lg bg-transparent px-3 py-2.5 font-mono text-sm tracking-[0.4em] text-slate-100 caret-emerald-300 outline-none placeholder:tracking-normal placeholder:text-slate-600"
                                />
                            </div>
                            {fieldError('totp') ? (
                                <p className="login-shake -mt-2 mb-4 text-xs text-rose-400" role="alert">
                                    {fieldError('totp')}
                                </p>
                            ) : null}
                        </>
                    ) : null}

                    <button
                        type="submit"
                        disabled={submitting || !username || !password || (needsTotp && totpCode.length !== 6)}
                        className="w-full rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 py-2.5 text-sm font-medium tracking-[0.2em] text-[#0f1220] transition hover:shadow-[0_0_28px_rgba(52,211,153,0.35)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
                    >
                        {submitting ? '连接中…' : '登录 →'}
                    </button>
                </form>

            </div>
        </div>
    )
}