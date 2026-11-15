/**
 * 前台独立布局.
 *
 * 与后台 Layout 完全分离: 自己的顶栏与配色, 不复用后台导航.
 * 配色来自后台自定义主题(背景图/各配色键), 以 CSS 变量注入本容器,
 * 只影响前台子树; 未配置的键沿用内置 default 基底.
 */
import { useEffect, useMemo, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '@/auth/session-provider'
import { LogoMark } from './logo'
import { buildBackgroundStyle, buildThemeVars } from '@/lib/themes'
import type { ThemeOptions } from '@/api/types'

export function PublicLayout({
    siteName,
    theme,
    children,
}: {
    siteName: string
    theme: ThemeOptions
    children: ReactNode
}): ReactElement {
    const { authenticated } = useSession()

    // 背景图作用在 body 级别(全屏、fixed), 由下方 effect 写入/清理;
    // 容器自身保持透明, 让 body 背景透出来.
    const style = useMemo(
        () => ({ ...buildThemeVars(theme.colors), backgroundColor: 'transparent' }) as CSSProperties,
        [theme],
    )

    useEffect(() => {
        const bg = buildBackgroundStyle(theme)
        const body = document.body
        body.style.backgroundImage = bg.backgroundImage ?? ''
        body.style.backgroundSize = bg.backgroundSize ?? ''
        body.style.backgroundPosition = bg.backgroundPosition ?? ''
        body.style.backgroundAttachment = bg.backgroundAttachment ?? ''
        // 离开前台时清掉内联背景, 恢复全局默认底色.
        return () => {
            body.style.backgroundImage = ''
            body.style.backgroundSize = ''
            body.style.backgroundPosition = ''
            body.style.backgroundAttachment = ''
        }
    }, [theme])

    return (
        <div style={style} className="min-h-screen bg-[var(--p-bg)] text-[var(--p-ink)]">
            <header className="p-glass border-b border-[var(--p-line)]">
                <div className="p-container flex items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <LogoMark className="h-9 w-9 rounded-xl" />
                        <div className="min-w-0 truncate font-semibold tracking-[-0.02em]">{siteName}</div>
                    </div>

                    <Link
                        to={authenticated ? '/servers' : '/login'}
                        className="rounded-md px-2.5 py-1.5 text-sm font-medium text-[var(--p-muted)] no-underline transition hover:bg-[var(--p-bg)] hover:text-[var(--p-ink)]"
                    >
                        {authenticated ? '管理后台' : '登录'}
                    </Link>
                </div>
            </header>

            <main className="p-container py-8">{children}</main>
        </div>
    )
}