/**
 * 系统设置页.
 *
 * 按「常规 / 安全 / 主题」分页:
 * - 常规: Agent 采集、远程命令、站点信息, 一次 PATCH 提交;
 * - 安全: 修改密码与两步验证, 各自独立接口(即时生效);
 * - 主题: 前台背景图与配色, 独立保存.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { settingsApi, authApi, themeApi } from '@/api/resources'
import type { SettingsMap, ThemeColorKey, ThemeOptions } from '@/api/types'
import { DEFAULT_THEME_COLORS, THEME_COLOR_KEYS, THEME_COLOR_LABELS } from '@/lib/themes'
import { QRCodeSVG } from 'qrcode.react'
import { Button, Field, Input, Select, Switch, Tabs, useToast } from '@/components/ui'

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
  const [timeoutSeconds, setTimeoutSeconds] = useState('60')
  const [maxOutputBytes, setMaxOutputBytes] = useState('1048576')
  const [siteName, setSiteName] = useState('Monix')
  const [serverUrl, setServerUrl] = useState('')

  const [tab, setTab] = useState<'general' | 'security' | 'theme'>('general')
  const [saving, setSaving] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const { toast } = useToast()
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [numericError, setNumericError] = useState<string | null>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const [themeBgImage, setThemeBgImage] = useState('')
  const [themeOpacity, setThemeOpacity] = useState('0')
  const [themeColors, setThemeColors] = useState<Record<ThemeColorKey, string>>(() => ({ ...DEFAULT_THEME_COLORS }))
  const [themeSaving, setThemeSaving] = useState(false)

  // 两步验证(TOTP): 独立于页面统一保存, 开关操作即时生效.
  const [totpEnabled, setTotpEnabled] = useState(false)
  const [totpMode, setTotpMode] = useState<'idle' | 'setup' | 'disable'>('idle')
  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string } | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [totpBusy, setTotpBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void authApi
      .totpStatus(controller.signal)
      .then((status) => setTotpEnabled(status.enabled))
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

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

  // 前台主题: 独立接口, 未配置时用内置 default 基底预填.
  useEffect(() => {
    const controller = new AbortController()
    themeApi
      .get(controller.signal)
      .then((theme: ThemeOptions) => {
        setThemeBgImage(theme.backgroundImage ?? '')
        setThemeOpacity(String(theme.backgroundOpacity ?? 0))
        setThemeColors((prev) => ({ ...prev, ...theme.colors }))
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  async function handleSaveTheme(): Promise<void> {
    setThemeSaving(true)
    try {
      const opacity = Number(themeOpacity)
      if (!Number.isInteger(opacity) || opacity < 0 || opacity > 95) {
        toast({ variant: 'error', title: '背景透明度需为 0-95 的整数' })
        setThemeSaving(false)
        return
      }
      await themeApi.save({
        backgroundImage: themeBgImage.trim().length > 0 ? themeBgImage.trim() : null,
        backgroundOpacity: opacity,
        colors: { ...themeColors },
      })
      toast({ variant: 'success', title: '前台主题已保存', description: '刷新公开状态页即可看到效果' })
    } catch (err) {
      toast({ variant: 'error', title: '主题保存失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setThemeSaving(false)
    }
  }

  /** 统一保存: 先提交设置, 若填写了新密码再一并修改. */
  function resetTotpFlow(): void {
    setTotpMode('idle')
    setTotpSetup(null)
    setTotpCode('')
  }

  async function startTotpSetup(): Promise<void> {
    setTotpBusy(true)
    try {
      const data = await authApi.totpSetup()
      setTotpSetup(data)
      setTotpMode('setup')
      setTotpCode('')
    } catch (err) {
      toast({ variant: 'error', title: '生成密钥失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setTotpBusy(false)
    }
  }

  function handleTotpToggle(checked: boolean): void {
    // 关闭确认流程中把开关拨回: 视为取消, 保持原启用状态.
    if (totpMode === 'disable') {
      resetTotpFlow()
      return
    }
    if (checked) {
      if (totpEnabled || totpMode === 'setup') return
      void startTotpSetup()
      return
    }
    if (totpMode === 'setup') {
      resetTotpFlow()
      return
    }
    if (totpEnabled) {
      setTotpMode('disable')
      setTotpCode('')
    }
  }

  /** 输入满 6 位自动确认: setup 走启用, disable 走关闭. */
  function handleTotpCodeChange(value: string): void {
    const digits = value.replace(/\D/g, '').slice(0, 6)
    setTotpCode(digits)
    if (digits.length !== 6 || totpBusy) return
    if (totpMode === 'setup') void confirmTotpEnable(digits)
    else if (totpMode === 'disable') void confirmTotpDisable(digits)
  }

  async function confirmTotpEnable(code = totpCode): Promise<void> {
    if (!/^\d{6}$/.test(code.trim())) {
      toast({ variant: 'error', title: '请输入 6 位动态验证码' })
      return
    }
    setTotpBusy(true)
    try {
      await authApi.totpEnable(code.trim())
      setTotpEnabled(true)
      resetTotpFlow()
      toast({ variant: 'success', title: '两步验证已启用', description: '下次登录需要输入动态验证码。' })
    } catch (err) {
      toast({ variant: 'error', title: '启用失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setTotpBusy(false)
    }
  }

  async function confirmTotpDisable(code = totpCode): Promise<void> {
    if (!/^\d{6}$/.test(code.trim())) {
      toast({ variant: 'error', title: '请输入 6 位动态验证码' })
      return
    }
    setTotpBusy(true)
    try {
      await authApi.totpDisable(code.trim())
      setTotpEnabled(false)
      resetTotpFlow()
      toast({ variant: 'success', title: '两步验证已关闭' })
    } catch (err) {
      toast({ variant: 'error', title: '关闭失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setTotpBusy(false)
    }
  }

  /** 常规页保存: Agent 采集 / 远程命令 / 站点信息. */
  async function handleSaveGeneral(): Promise<void> {
    setSaving(true)
    setNumericError(null)

    // 数字项先本地校验: 空字符串经 Number('') 会变成 NaN, 序列化后成为 null,
    // 服务端只会返回"取值类型不支持", 无法定位到具体字段.
    for (const [label, raw] of [
      ['采集间隔', collectInterval],
      ['执行超时', timeoutSeconds],
      ['最大输出', maxOutputBytes],
    ] as const) {
      const parsed = Number(raw)
      if (!Number.isInteger(parsed)) {
        setNumericError(`${label}必须是整数`)
        setSaving(false)
        return
      }
    }

    try {
      await settingsApi.patch({
        agent: {
          collect_interval: Number(collectInterval),
        },
        command: {
          timeout_seconds: Number(timeoutSeconds),
          max_output_bytes: Number(maxOutputBytes),
        },
        system: { site_name: siteName, server_url: serverUrl },
      })
      // 站点名称立即生效, 不必等刷新.
      if (siteName.trim().length > 0) document.title = siteName.trim()
      toast({ variant: 'success', title: '设置已保存', description: '在下一次配置协商或 Agent 重连时生效' })
    } catch (err) {
      toast({ variant: 'error', title: '保存失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  /** 安全页: 修改密码(改密后所有既有会话失效). */
  async function handleSavePassword(): Promise<void> {
    setPasswordError(null)
    if (!currentPassword) {
      setPasswordError('请输入当前密码')
      return
    }
    if (newPassword.length < 8) {
      setPasswordError('新密码至少需要 8 位')
      return
    }

    setPasswordSaving(true)
    try {
      await authApi.changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      toast({ variant: 'success', title: '密码已修改', description: '其他会话已失效' })
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : '修改失败')
    } finally {
      setPasswordSaving(false)
    }
  }

  const bounds = data?.bounds ?? {}

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">系统设置</h1>
        <p className="mt-1 text-sm text-slate-500">按分类分页; 设置项在下一次配置协商或 Agent 重连时生效。</p>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        ariaLabel="设置分类"
        options={[
          { value: 'general', label: '常规' },
          { value: 'security', label: '安全' },
          { value: 'theme', label: '主题' },
        ]}
      />

      {tab === 'general' ? (
        <div className="space-y-5">
          <Panel title="Agent 配置" description="采集频率与 Agent 使用的服务端地址; Agent 在建立连接时拉取。">
            <SettingRow label="采集间隔" hint="每台服务器采集系统指标的时间间隔">
              <Input
                type="number"
                value={collectInterval}
                onChange={(event) => setCollectInterval(event.target.value)}
                min={bounds['agent.collect_interval']?.min ?? 1000}
                max={bounds['agent.collect_interval']?.max ?? 300000}
                step={500}
                aria-label="采集间隔"
                aria-invalid={numericError ? true : undefined}
                className="w-28 text-right"
              />
              <span className="w-7 text-xs text-slate-400">ms</span>
            </SettingRow>
            <SettingRow
              label="服务端地址"
              hint="安装命令会带上 --server-url; 留空则使用 Agent 内置默认地址"
            >
              <Input
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="https://monix.api01.eu.org"
                aria-label="服务端地址"
                className="w-64"
              />
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

          <Panel title="站点" description="站点名称显示在浏览器标题与前台页头。">
            <SettingRow label="站点名称" hint="显示在浏览器标题">
              <Input
                value={siteName}
                onChange={(event) => setSiteName(event.target.value)}
                aria-label="站点名称"
                className="w-44"
              />
            </SettingRow>
          </Panel>

          <div className="flex items-center justify-end gap-3">
            {numericError ? (
              <p className="text-xs leading-relaxed text-rose-600" role="alert">
                {numericError}
              </p>
            ) : null}
            <Button onClick={() => void handleSaveGeneral()} loading={saving}>
              保存设置
            </Button>
          </div>
        </div>
      ) : null}

      {tab === 'security' ? (
        <Panel title="账号安全" description="修改密码与两步验证; 操作即时生效, 不随其他设置一起保存。">
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3.5">
            <div>
              <div className="text-sm text-slate-800">两步验证 (TOTP)</div>
              <div className="mt-0.5 text-xs text-slate-400">
                {totpEnabled
                  ? '已启用, 登录需输入验证器 App 中的 6 位动态码'
                  : totpMode === 'setup'
                    ? '待输入验证码确认, 确认后生效'
                    : '启用后登录需在密码之外输入 6 位动态码'}
              </div>
            </div>
            <Switch
              checked={totpEnabled ? totpMode !== 'disable' : totpMode === 'setup'}
              onChange={handleTotpToggle}
              disabled={totpBusy}
              ariaLabel="两步验证"
            />
          </div>

          {totpMode === 'setup' && totpSetup ? (
            <div className="space-y-4 px-4 py-4">
              <div>
                <p className="text-sm text-slate-800">1. 用验证器 App 扫描二维码</p>
                <div className="mt-3 flex flex-wrap items-start gap-4">
                  <div className="rounded-lg border border-slate-200 bg-white p-2">
                    <QRCodeSVG value={totpSetup.uri} size={140} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="text-xs text-slate-400">无法扫码时手动输入密钥:</p>
                    <div className="flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900">
                        {totpSetup.secret}
                      </code>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void navigator.clipboard?.writeText(totpSetup.secret)
                          toast({ variant: 'success', title: '密钥已复制' })
                        }}
                      >
                        复制
                      </Button>
                    </div>
                    <p className="break-all text-[11px] text-slate-400">{totpSetup.uri}</p>
                  </div>
                </div>
              </div>
              <div>
                <p className="text-sm text-slate-800">2. 输入 App 显示的 6 位验证码确认</p>
                <div className="mt-2">
                  <Input
                    value={totpCode}
                    onChange={(event) => handleTotpCodeChange(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    placeholder="000000"
                    aria-label="动态验证码"
                    className="w-36 font-mono tracking-[0.3em]"
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    {totpBusy ? '正在验证…' : '输入满 6 位后自动确认; 关闭上方开关可取消'}
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {totpMode === 'disable' ? (
            <div className="space-y-2 border-b border-slate-100 px-4 py-4">
              <p className="text-sm text-slate-800">输入当前动态验证码以关闭两步验证</p>
              <Input
                value={totpCode}
                onChange={(event) => handleTotpCodeChange(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                placeholder="000000"
                aria-label="动态验证码"
                className="w-36 font-mono tracking-[0.3em]"
              />
              <p className="text-xs text-slate-400">
                {totpBusy ? '正在验证…' : '输入满 6 位后自动关闭; 重新打开上方开关可取消'}
              </p>
            </div>
          ) : null}

          <div className="space-y-3 px-4 py-4">
            <div>
              <div className="text-sm text-slate-800">修改密码</div>
              <div className="mt-0.5 text-xs text-slate-400">至少 8 位; 修改后所有既有会话立即失效, 需重新登录</div>
            </div>
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
              placeholder="新密码(至少 8 位)"
              aria-label="新密码"
              aria-invalid={passwordError ? true : undefined}
              autoComplete="new-password"
            />
            {passwordError ? (
              <p className="text-xs leading-relaxed text-rose-600" role="alert">
                {passwordError}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button onClick={() => void handleSavePassword()} loading={passwordSaving}>
                保存
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {tab === 'theme' ? (
        <div className="space-y-5">
          <Panel title="前台主题" description="公开状态页的背景图与配色; 未配置的键使用内置默认值。">
            <SettingRow label="背景图片" hint="完整 URL(http/https) 或站内路径; 留空则不使用背景图">
              <Input
                value={themeBgImage}
                onChange={(event) => setThemeBgImage(event.target.value)}
                placeholder="https://example.com/bg.jpg"
                aria-label="背景图片"
                className="w-64"
              />
            </SettingRow>
            <SettingRow
              label="背景透明度"
              hint="叠加页面底色的遮罩浓度: 0 为图片原样显示, 越高背景图越淡(0-95)"
            >
              <Input
                type="number"
                value={themeOpacity}
                onChange={(event) => setThemeOpacity(event.target.value)}
                min={0}
                max={95}
                step={5}
                aria-label="背景透明度"
                className="w-24 text-right"
              />
              <span className="w-5 text-xs text-slate-400">%</span>
            </SettingRow>
            {THEME_COLOR_KEYS.map((key) => (
              <SettingRow key={key} label={THEME_COLOR_LABELS[key]} hint={`CSS 变量 var(--p-${key.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())})`}>
                <span className="font-mono text-xs text-slate-500">{themeColors[key]}</span>
                <input
                  type="color"
                  value={themeColors[key]}
                  onChange={(event) => setThemeColors((prev) => ({ ...prev, [key]: event.target.value }))}
                  aria-label={`配色: ${THEME_COLOR_LABELS[key]}`}
                  className="h-8 w-12 cursor-pointer rounded border border-slate-200 bg-white"
                />
              </SettingRow>
            ))}
            <div className="flex justify-end px-4 py-3">
              <Button onClick={() => void handleSaveTheme()} loading={themeSaving}>
                保存主题
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  )
}
