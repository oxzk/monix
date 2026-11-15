/**
 * 应用外壳.
 *
 * 提供顶部导航与退出操作. 导航只保留服务器与系统设置两个入口,
 * 命令与终端在服务器详情页内以面板形式出现.
 */
import type { ReactElement } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ExternalLink, LogOut } from 'lucide-react'
import { useSession } from '@/auth/session-provider'
import { authApi } from '@/api/resources'
import { Button } from './button'
import { Tooltip } from './tooltip'
import { LogoMark } from './logo'
import { cn } from '@/lib/utils'

const nav = [
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
                        <div className="font-semibold tracking-[-0.02em] text-slate-900">Monix</div>
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

                    <div className="flex items-center gap-1">
                        <Tooltip content="浏览前台">
                            <NavLink
                                to="/"
                                aria-label="浏览前台"
                                className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 no-underline transition hover:bg-slate-100 hover:text-slate-900"
                            >
                                <ExternalLink size={16} aria-hidden />
                            </NavLink>
                        </Tooltip>
                        <Tooltip content="退出登录">
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => void handleLogout()}
                                aria-label="退出登录"
                                className="text-slate-500"
                            >
                                <LogOut size={16} aria-hidden />
                            </Button>
                        </Tooltip>
                    </div>
                </div>
            </header>

            <main className="mx-auto max-w-6xl px-4 py-8">
                <Outlet />
            </main>
        </div>
    )
}
