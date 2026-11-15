/**
 * 应用路由.
 *
 * 页面全部走动态导入(React.lazy): 每个路由独立分包, 首屏只加载
 * 公开状态页所需的代码; 管理端页面在导航到时才拉取对应 chunk.
 */
import { Suspense, lazy } from 'react'
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom'
import type { ReactElement } from 'react'
import { SessionProvider, useSession } from '@/auth/session-provider'
import { MonitorStreamProvider } from '@/hooks/use-monitor-stream'
import { Layout, ToastProvider, TooltipProvider } from '@/components/ui'

// 页面按路由拆分.
const PublicPage = lazy(() => import('@/pages/public').then((module) => ({ default: module.PublicPage })))
const LoginPage = lazy(() => import('@/pages/login').then((module) => ({ default: module.LoginPage })))
const ServersPage = lazy(() => import('@/pages/servers').then((module) => ({ default: module.ServersPage })))
const ServerDetailPage = lazy(() =>
    import('@/pages/server-detail').then((module) => ({ default: module.ServerDetailPage })),
)
const SettingsPage = lazy(() => import('@/pages/settings').then((module) => ({ default: module.SettingsPage })))

function RequireAdmin(): ReactElement {
    const { authenticated, loading } = useSession()
    const location = useLocation()

    if (loading) {
        return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">加载中...</div>
    }
    if (!authenticated) {
        const next = `${location.pathname}${location.search}`
        return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
    }
    return (
        <MonitorStreamProvider>
            <Layout />
        </MonitorStreamProvider>
    )
}

export default function App(): ReactElement {
    return (
        <TooltipProvider>
            <ToastProvider>
                <Router>
                    <SessionProvider>
                        <Suspense
                            fallback={
                                <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
                                    加载中...
                                </div>
                            }
                        >
                            <Routes>
                                <Route path="/" element={<PublicPage />} />
                                <Route path="/login" element={<LoginPage />} />
                                <Route element={<RequireAdmin />}>
                                    <Route path="/servers" element={<ServersPage />} />
                                    <Route path="/servers/:id" element={<ServerDetailPage />} />
                                    <Route path="/settings" element={<SettingsPage />} />
                                </Route>
                                <Route path="*" element={<Navigate to="/" replace />} />
                            </Routes>
                        </Suspense>
                    </SessionProvider>
                </Router>
            </ToastProvider>
        </TooltipProvider>
    )
}