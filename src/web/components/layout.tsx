/**
 * 应用外壳.
 *
 * 提供顶部导航、实时连接状态与退出操作. 导航只保留总览、服务器与
 * 系统设置三个入口, 命令与终端在服务器详情页内以面板形式出现.
 */
import type { ReactElement } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LogOut, Radio } from 'lucide-react'
import { useSession } from '@/auth/session-provider'
import { authApi } from '@/api/resources'
import { Button } from '@/components/ui'
import { LogoMark } from '@/components/logo'
import { cn } from '@/lib/utils'

const nav = [
    { to: '/', label: '总览', end: true },
    { to: '/servers', label: '服务器', end: false },
    { to: '/settings', label: '系统设置', end: false },
] as const

export function Layout(): ReactElement {
    const { setAuthenticated } = useSession()
    const { pathname } = useLocation()
    const navigate = useNavigate()

    async function handleLogout(): Promise<void> {
        try {
            await authApi.logout()
        } finally {
            setAuthenticated(false)
            navigate('/login', { replace: true })
        }
    }

    return (
        <div className="min-h-screen">
            <header className="border-b border-slate-200/80 bg-white">
                <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3">
                    <div className="flex items-center gap-3">
                        <LogoMark className="h-9 w-9" />
                        <div className="leading-tight">
                            <div className="font-semibold tracking-[-0.02em] text-slate-900">Monix</div>
                            <div className="text-[11px] text-slate-400">服务器监控</div>
                        </div>
                    </div>

                    <nav className="flex flex-wrap items-center gap-1" aria-label="主导航">
                        {nav.map((item) => {
                            const active = item.end
                                ? pathname === item.to
                                : pathname === item.to || pathname.startsWith(`${item.to}/`)
                            return (
                                <NavLink
                                    key={item.to}
                                    to={item.to}
                                    end={item.end}
                                    className={cn(
                                        'inline-flex items-center whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-medium no-underline transition',
                                        active
                                            ? 'bg-slate-900 text-white hover:bg-slate-900 hover:text-white'
                                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                                    )}
                                >
                                    {item.label}
                                </NavLink>
                            )
                        })}
                    </nav>

                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleLogout()}
                        aria-label="退出登录"
                        className="text-slate-500"
                    >
                        <LogOut size={16} aria-hidden />
                    </Button>
                </div>
            </header>

            <main className="mx-auto max-w-6xl px-4 py-8">
                <Outlet />
            </main>
        </div>
    )
}

export function ConnectionBadge({ connected }: { connected: boolean }): ReactElement {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium',
                connected ? 'bg-slate-100 text-slate-600' : 'bg-rose-50 text-rose-600',
            )}
        >
            <Radio size={12} aria-hidden />
            {connected ? '实时已连接' : '实时已断开'}
        </span>
    )
}
