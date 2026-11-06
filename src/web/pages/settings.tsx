/**
 * 系统设置页.
 *
 * 所有配置项通过一次 PATCH 提交; 若填写了新密码则在同一保存动作里
 * 调用改密接口, 避免出现独立按钮导致两套提交路径.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { settingsApi, authApi } from '@/api/resources'
import { useToast } from '@/components/toast'
import type { SettingsMap } from '@/api/types'
import { Button, Field, Input, Select, Switch } from '@/components/ui'

interface RowProps {
  label: string
  hint: string
  children: React.ReactNode
}

function SettingRow({ label, hint, children }: RowProps): ReactElement {
  return (
    <div className="grid gap-3 border-b border-slate-100 px-4 py-3.5 last:border-b-0 sm:grid-cols-[1fr_280px] sm:items-center">
      <div>
        <div className="text-sm text-slate-800">{label}</div>
        <div className="mt-0.5 text-xs text-slate-400">{hint}</div>
      </div>
      <div className="flex items-center justify-end gap-2">{children}</div>
    </div>
  )
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }): ReactElement {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-400">{description}</p>
      </div>
      {children}
    </section>
  )
}

export function SettingsPage(): ReactElement {
  const [data, setData] = useState<SettingsMap | null>(null)
  const [collectInterval, setCollectInterval] = useState('5000')
  const [autoUpdate, setAutoUpdate] = useState(true)
  const [timeoutSeconds, setTimeoutSeconds] = useState('60')
  const [maxOutputBytes, setMaxOutputBytes] = useState('1048576')
  const [siteName, setSiteName] = useState('Monix')
  const [serverUrl, setServerUrl] = useState('')

  const [saving, setSaving] = useState(false)
  const { toast } = useToast()
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    settingsApi
      .get(controller.signal)
      .then((payload) => {
        setData(payload)
        const agent = payload.settings.agent ?? {}
        const command = payload.settings.command ?? {}
        const system = payload.settings.system ?? {}
        if (agent.collect_interval) setCollectInterval(agent.collect_interval.value)
        if (agent.auto_update) setAutoUpdate(agent.auto_update.value === 'true')
        if (command.timeout_seconds) setTimeoutSeconds(command.timeout_seconds.value)
        if (command.max_output_bytes) setMaxOutputBytes(command.max_output_bytes.value)
        if (system.site_name) setSiteName(system.site_name.value)
        if (system.server_url) setServerUrl(system.server_url.value)
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        toast({ variant: 'error', title: '加载失败', description: err instanceof Error ? err.message : undefined })
      })
    return () => controller.abort()
  }, [])

  /** 统一保存: 先提交设置, 若填写了新密码再一并修改. */
  async function handleSave(): Promise<void> {
    setSaving(true)

    const wantsPasswordChange = currentPassword.length > 0 || newPassword.length > 0
    // 用字段下方提示, 不使用浏览器原生校验气泡.
    if (wantsPasswordChange && !currentPassword) {
      setPasswordError('请输入当前密码')
      setSaving(false)
      return
    }
    if (wantsPasswordChange && newPassword.length < 8) {
      setPasswordError('新密码至少需要 8 位')
      setSaving(false)
      return
    }
    setPasswordError(null)

    try {
      await settingsApi.patch({
        agent: {
          collect_interval: Number(collectInterval),
          auto_update: autoUpdate,
        },
        command: {
          timeout_seconds: Number(timeoutSeconds),
          max_output_bytes: Number(maxOutputBytes),
        },
        system: { site_name: siteName, server_url: serverUrl },
      })

      if (wantsPasswordChange) {
        try {
          await authApi.changePassword(currentPassword, newPassword)
          setCurrentPassword('')
          setNewPassword('')
          toast({ variant: 'success', title: '设置已保存', description: '密码已修改, 其他会话已失效' })
        } catch (err) {
          toast({ variant: 'error', title: '设置已保存, 但密码修改失败', description: err instanceof Error ? err.message : undefined })
        }
      } else {
        toast({ variant: 'success', title: '设置已保存', description: '在下一次配置协商或 Agent 重连时生效' })
      }
    } catch (err) {
      toast({ variant: 'error', title: '保存失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  const bounds = data?.bounds ?? {}

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">系统设置</h1>
        <p className="mt-1 text-sm text-slate-500">修改后在下一次配置协商或 Agent 重连时生效。</p>
      </div>


      <Panel title="Agent 采集" description="控制指标采集频率与自动更新行为。">
        <SettingRow label="采集间隔" hint="每台服务器采集系统指标的时间间隔">
          <Input
            type="number"
            value={collectInterval}
            onChange={(event) => setCollectInterval(event.target.value)}
            min={bounds['agent.collect_interval']?.min ?? 1000}
            max={bounds['agent.collect_interval']?.max ?? 300000}
            step={500}
            aria-label="采集间隔"
            className="w-28 text-right"
          />
          <span className="w-7 text-xs text-slate-400">ms</span>
        </SettingRow>
        <SettingRow label="自动更新" hint="Agent 校验签名后自动安装新版本">
          <Switch checked={autoUpdate} onChange={setAutoUpdate} ariaLabel="自动更新" />
        </SettingRow>
      </Panel>

      <Panel title="远程命令" description="服务端与 Agent 双重超时控制, 客户端不能突破硬性上限。">
        <SettingRow label="执行超时" hint="超时后 Agent 终止整个进程组">
          <Input
            type="number"
            value={timeoutSeconds}
            onChange={(event) => setTimeoutSeconds(event.target.value)}
            min={bounds['command.timeout_seconds']?.min ?? 5}
            max={bounds['command.timeout_seconds']?.max ?? 300}
            aria-label="执行超时"
            className="w-28 text-right"
          />
          <span className="w-7 text-xs text-slate-400">秒</span>
        </SettingRow>
        <SettingRow label="最大输出" hint="超过上限后 Agent 继续读取并丢弃, 命令不受影响">
          <Input
            type="number"
            value={maxOutputBytes}
            onChange={(event) => setMaxOutputBytes(event.target.value)}
            min={bounds['command.max_output_bytes']?.min ?? 65536}
            max={bounds['command.max_output_bytes']?.max ?? 16777216}
            step={65536}
            aria-label="最大输出字节"
            className="w-32 text-right"
          />
          <span className="w-7 text-xs text-slate-400">B</span>
        </SettingRow>
      </Panel>

      <Panel title="系统与账号" description="单管理员账号, 修改密码后所有既有会话立即失效。">
        <SettingRow label="站点名称" hint="显示在浏览器标题">
          <Input
            value={siteName}
            onChange={(event) => setSiteName(event.target.value)}
            aria-label="站点名称"
            className="w-44"
          />
        </SettingRow>
        <SettingRow label="服务端地址" hint="用于生成 Agent 安装命令, 留空则使用当前访问域名">
          <Input
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="https://monix.example.com"
            aria-label="服务端地址"
            className="w-64"
          />
        </SettingRow>
        <SettingRow label="修改密码" hint="至少 8 位; 留空表示不修改。保存后其他设备需要重新登录">
          <div className="flex w-full flex-col gap-2">
            <Input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder="当前密码"
              aria-label="当前密码"
              aria-invalid={passwordError ? true : undefined}
              autoComplete="current-password"
            />
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="新密码(留空则不修改)"
              aria-label="新密码"
              aria-invalid={passwordError ? true : undefined}
              autoComplete="new-password"
            />
            {passwordError ? (
              <p className="text-xs leading-relaxed text-rose-600" role="alert">
                {passwordError}
              </p>
            ) : null}
          </div>
        </SettingRow>
      </Panel>

      <div className="flex justify-end">
        <Button onClick={() => void handleSave()} loading={saving}>
          保存设置
        </Button>
      </div>
    </div>
  )
}
