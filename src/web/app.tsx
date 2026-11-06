import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom'
import type { ReactElement } from 'react'
import { SessionProvider, useSession } from '@/auth/session-provider'
import { MonitorStreamProvider } from '@/hooks/use-monitor-stream'
import { Layout } from '@/components/layout'
import { ToastProvider } from '@/components/toast'
import { LoginPage } from '@/pages/login'
import { OverviewPage } from '@/pages/overview'
import { ServersPage } from '@/pages/servers'
import { ServerDetailPage } from '@/pages/server-detail'
import { SettingsPage } from '@/pages/settings'

function RequireAdmin(): ReactElement {
    const { authenticated, loading } = useSession()
    const location = useLocation()

    if (loading) {
        return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">加载中...</div>
    }
    if (!authenticated) {
        const next = `${location.pathname}${location.search}`
        return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
    }
    return (
        <MonitorStreamProvider>
            <Layout />
        </MonitorStreamProvider>
    )
}

export default function App(): ReactElement {
    return (
        <ToastProvider>
            <Router>
                <SessionProvider>
                    <Routes>
                        <Route path="/login" element={<LoginPage />} />
                        <Route element={<RequireAdmin />}>
                            <Route path="/" element={<OverviewPage />} />
                            <Route path="/servers" element={<ServersPage />} />
                            <Route path="/servers/:id" element={<ServerDetailPage />} />
                            <Route path="/settings" element={<SettingsPage />} />
                        </Route>
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </SessionProvider>
            </Router>
        </ToastProvider>
    )
}
