/**
 * 管理员会话上下文.
 *
 * 只在内存中保存是否已登录; 真正的凭据是 HttpOnly Cookie, 前端不可读取.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { authApi } from '@/api/resources'

interface SessionState {
  authenticated: boolean
  username: string | null
  loading: boolean
  refresh: () => Promise<void>
  setAuthenticated: (value: boolean) => void
}

const SessionContext = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }): ReactElement {
  const [authenticated, setAuthenticated] = useState(false)
  const [username, setUsername] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await authApi.me()
      setAuthenticated(data.authenticated)
      setUsername(data.username ?? null)
    } catch {
      setAuthenticated(false)
      setUsername(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(
    () => ({
      authenticated,
      username,
      loading,
      refresh,
      setAuthenticated: (next: boolean) => {
        setAuthenticated(next)
        if (!next) setUsername(null)
      },
    }),
    [authenticated, username, loading, refresh],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession 必须在 SessionProvider 内使用')
  return ctx
}
