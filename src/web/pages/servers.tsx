/**
 * 服务器管理页.
 *
 * 两个标签页共用一份数据: 服务器表格与分组表格. 表格行的操作包括
 * 执行命令、打开终端、复制安装命令和删除; 分组通过弹窗新增或编辑.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Copy, Download, KeyRound, Pencil, Plus, Search, SquareTerminal, Terminal, Trash2 } from 'lucide-react'
import { groupsApi, serversApi } from '@/api/resources'
import type { Group, ServerSummary } from '@/api/types'
import { AppDialog, Button, Field, Input, Select, Tabs, Tooltip, useFieldErrors, useToast, type SelectOption, ConfirmDialog } from '@/components/ui'
import { cn } from '@/lib/utils'

/** 每页条数. 与服务端 parsePagination 的默认上限一致. */
const PAGE_SIZE = 100

/** 列表分页控件. 总数为 0 或只有一页时不渲染. */
function Pagination({
  page,
  pageSize,
  total,
  loading,
  onChange,
}: {
  page: number
  pageSize: number
  total: number
  loading: boolean
  onChange: (page: number) => void
}): ReactElement | null {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (loading || pageCount <= 1) return null
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
      <span className="tabular-nums">
        共 {total} 台 · 第 {page + 1} / {pageCount} 页
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => onChange(page - 1)}>
          上一页
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pageCount - 1}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  )
}

export function ServersPage(): ReactElement {
  const navigate = useNavigate()
  const { toast } = useToast()

  const [servers, setServers] = useState<ServerSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const pageSize = PAGE_SIZE

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newGroup, setNewGroup] = useState('')

  const [tab, setTab] = useState<'servers' | 'groups'>('servers')
  const [groupName, setGroupName] = useState('')
  const [groupDesc, setGroupDesc] = useState('')
  const [editingGroup, setEditingGroup] = useState<Group | null>(null)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)

  /** 安装弹窗: 脚本命令与 AI Skill 两种方式; skill 为 null 时只展示脚本. */
  const [installCommand, setInstallCommand] = useState<{
    name: string
    script: string
    skill: string | null
  } | null>(null)
  const [installTab, setInstallTab] = useState<'script' | 'skill'>('script')

  const serverForm = useFieldErrors<'name'>()
  const groupForm = useFieldErrors<'name'>()

  const load = useCallback(async (signal?: AbortSignal, targetPage = 0) => {
    try {
      const [list, groupList] = await Promise.all([
        serversApi.list({ limit: PAGE_SIZE, offset: targetPage * PAGE_SIZE }, signal),
        groupsApi.list(signal),
      ])
      setServers(list.items)
      setTotal(list.total)
      setGroups(groupList)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      toast({ variant: 'error', title: '加载失败', description: err instanceof Error ? err.message : undefined })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal, page)
    return () => controller.abort()
  }, [load, page])

  const visible = useMemo<ServerSummary[]>(() => {
    return servers.filter((server) => {
      if (statusFilter && server.status !== statusFilter) return false
      if (groupFilter && String(server.groupId ?? '') !== groupFilter) return false
      if (query) {
        const q = query.toLowerCase()
        if (
          !server.name.toLowerCase().includes(q) &&
          !server.id.toLowerCase().includes(q) &&
          !(server.ipv4 ?? '').includes(q)
        ) {
          return false
        }
      }
      return true
    })
  }, [servers, statusFilter, groupFilter, query])

  const groupOptions = useMemo<SelectOption[]>(
    () => [{ value: '', label: '不分组' }, ...groups.map((g) => ({ value: String(g.id), label: g.name }))],
    [groups],
  )

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault()
    serverForm.clearAll()
    // 自行校验, 用控件下方提示替代浏览器原生气泡.
    if (!newName.trim()) {
      serverForm.setError('name', '请输入服务器名称')
      return
    }
    try {
      await serversApi.create(newName.trim(), newGroup ? Number(newGroup) : null)
      toast({ variant: 'success', title: '服务器已创建', description: '可在操作列点击“安装 Agent”复制安装命令或 Skill。' })
      setNewName('')
      setNewGroup('')
      setCreateOpen(false)
      await load(undefined, page)
    } catch (err) {
      toast({ variant: 'error', title: '创建失败', description: err instanceof Error ? err.message : undefined })
    }
  }

  /** 二次确认弹窗的当前请求; null 表示关闭. */
  const [confirmRequest, setConfirmRequest] = useState<{
    title: string
    description: string
    confirmText: string
    danger: boolean
    run: () => Promise<void>
  } | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)

  /** 执行确认操作: 弹窗保持打开并显示加载态, 完成后关闭. */
  async function handleConfirm(): Promise<void> {
    if (!confirmRequest) return
    setConfirmLoading(true)
    try {
      await confirmRequest.run()
    } finally {
      setConfirmLoading(false)
      setConfirmRequest(null)
    }
  }

  async function handleInstallCommand(id: string, name: string): Promise<void> {
    try {
      const result = await serversApi.getInstallCommand(id)
      // Skill 方式: 交给支持 skill 的 AI 助手, 由它阅读安装文档并执行.
      const skill = [
        `请阅读 ${window.location.origin}/install-agent.md 并按其中步骤在这台服务器上安装 Monix Agent。`,
        `Agent Token: ${result.token}`,
        '安装完成后确认 monix-agent 正常运行, 且 Monix 后台服务器列表显示在线。',
      ].join('\n')
      setInstallTab('script')
      setInstallCommand({ name, script: result.command, skill })
    } catch (err) {
      toast({ variant: 'error', title: '获取安装命令失败', description: err instanceof Error ? err.message : undefined })
    }
  }

  async function handleRotateToken(server: ServerSummary): Promise<void> {
    setConfirmRequest({
      title: '轮换 Agent Token',
      description: `轮换 ${server.name} 的 Agent Token? 旧 Token 立即失效, 该服务器的连接会被断开。`,
      confirmText: '轮换 Token',
      danger: true,
      run: async () => {
        try {
          const result = await serversApi.rotateToken(server.id)
          try {
            await navigator.clipboard.writeText(result.token)
            toast({
              variant: 'success',
              title: 'Token 已轮换并复制',
              description: '新 Token 只显示这一次, 请立即写入目标机器的配置。',
            })
          } catch {
            // 剪贴板不可用: 弹窗展示新 Token(无 skill 变体).
            setInstallCommand({ name: `${server.name} 的新 Token`, script: result.token, skill: null })
            setInstallTab('script')
          }
          await load(undefined, page)
        } catch (err) {
          toast({ variant: 'error', title: '轮换失败', description: err instanceof Error ? err.message : undefined })
        }
      },
    })
  }

  async function handleDelete(server: ServerSummary): Promise<void> {
    setConfirmRequest({
      title: '删除服务器',
      description: `删除服务器 ${server.name}?`,
      confirmText: '删除',
      danger: true,
      run: async () => {
        try {
          await serversApi.remove(server.id)
          await load(undefined, page)
        } catch (err) {
          toast({ variant: 'error', title: '删除失败', description: err instanceof Error ? err.message : undefined })
        }
      },
    })
  }

  async function handleGroupSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    groupForm.clearAll()
    if (!groupName.trim()) {
      groupForm.setError('name', '请输入分组名称')
      return
    }
    try {
      if (editingGroup) {
        await groupsApi.update(editingGroup.id, groupName.trim(), groupDesc.trim() || null)
      } else {
        await groupsApi.create(groupName.trim(), groupDesc.trim() || null)
      }
      setGroupName('')
      setGroupDesc('')
      setEditingGroup(null)
      setGroupDialogOpen(false)
      await load(undefined, page)
    } catch (err) {
      toast({ variant: 'error', title: '保存分组失败', description: err instanceof Error ? err.message : undefined })
    }
  }

  async function handleGroupDelete(group: Group): Promise<void> {
    setConfirmRequest({
      title: '删除分组',
      description: `删除分组 ${group.name}? 组内服务器会解除关联, 但不会被删除。`,
      confirmText: '删除',
      danger: true,
      run: async () => {
        try {
          await groupsApi.remove(group.id)
          await load(undefined, page)
        } catch (err) {
          toast({ variant: 'error', title: '删除分组失败', description: err instanceof Error ? err.message : undefined })
        }
      },
    })
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">服务器</h1>
        <p className="mt-1 text-sm text-slate-500">
          新建服务器后复制安装命令即可接入。命令内含该服务器的 Agent Token，
          只粘贴到目标机器执行；怀疑泄露时轮换 Token 并重新安装。
        </p>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        ariaLabel="服务器与分组"
        options={[
          { value: 'servers', label: `服务器 (${servers.length})` },
          { value: 'groups', label: `分组 (${groups.length})` },
        ]}
      />

      {tab === 'servers' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称、ID 或 IP"
                aria-label="搜索服务器"
                className="w-56 pl-9"
              />
            </div>
            <div className="w-32">
              <Select
                value={statusFilter}
                onChange={setStatusFilter}
                ariaLabel="按状态筛选"
                options={[
                  { value: '', label: '全部状态' },
                  { value: 'online', label: '在线' },
                  { value: 'offline', label: '离线' },
                ]}
              />
            </div>
            <div className="w-36">
              <Select
                value={groupFilter}
                onChange={setGroupFilter}
                ariaLabel="按分组筛选"
                options={[
                  { value: '', label: '全部分组' },
                  ...groups.map((g) => ({ value: String(g.id), label: g.name })),
                ]}
              />
            </div>
            <Button className="ml-auto" onClick={() => setCreateOpen(true)}>
              <Plus size={14} aria-hidden />
              新建服务器
            </Button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="whitespace-nowrap px-4 py-3 font-medium">服务器</th>
                    <th className="whitespace-nowrap px-4 py-3 font-medium">IP</th>
                    <th className="whitespace-nowrap px-4 py-3 font-medium">分组</th>
                    <th className="whitespace-nowrap px-4 py-3 font-medium">状态</th>
                    <th className="whitespace-nowrap px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400">
                        加载中...
                      </td>
                    </tr>
                  ) : visible.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400">
                        没有匹配的服务器
                      </td>
                    </tr>
                  ) : (
                    visible.map((server) => {
                      const online = server.status === 'online'
                      const group = groups.find((g) => g.id === server.groupId)
                      return (
                        <tr key={server.id} className="border-t border-slate-100">
                          <td className="px-4 py-3">
                            <Link
                              to={`/servers/${encodeURIComponent(server.id)}`}
                              className="font-medium text-slate-900 hover:underline"
                            >
                              {server.name}
                            </Link>
                            <div className="mt-0.5 font-mono text-[11px] text-slate-400">{server.id}</div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600">
                            <div>{server.ipv4 ?? server.ipv6 ?? '—'}</div>
                            {server.platform || server.version ? (
                              <div className="mt-0.5 text-[11px] text-slate-400">
                                {[server.platform, server.version ? `v${server.version}` : null]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </div>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-slate-600">{group?.name ?? '—'}</td>
                          <td className="px-4 py-3">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium',
                                online ? 'bg-slate-100 text-slate-600' : 'bg-rose-50 text-rose-600',
                              )}
                            >
                              <span
                                className={cn('h-1.5 w-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-rose-500')}
                                aria-hidden
                              />
                              {online ? '在线' : '离线'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-1">
                              <Tooltip content="执行命令">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`对 ${server.name} 执行命令`}
                                  onClick={() => navigate(`/servers/${encodeURIComponent(server.id)}?action=command`)}
                                >
                                  <Terminal size={14} aria-hidden />
                                </Button>
                              </Tooltip>
                              <Tooltip content="打开终端">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`打开 ${server.name} 的终端`}
                                  onClick={() => navigate(`/servers/${encodeURIComponent(server.id)}?action=terminal`)}
                                >
                                  <SquareTerminal size={14} aria-hidden />
                                </Button>
                              </Tooltip>
                              <Tooltip content="安装 Agent">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`安装 ${server.name} 的 Agent`}
                                  onClick={() => void handleInstallCommand(server.id, server.name)}
                                >
                                  <Download size={14} aria-hidden />
                                </Button>
                              </Tooltip>
                              <Tooltip content="轮换 Token">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`轮换 ${server.name} 的 Token`}
                                  onClick={() => void handleRotateToken(server)}
                                >
                                  <KeyRound size={14} aria-hidden />
                                </Button>
                              </Tooltip>
                              <Tooltip content="删除服务器">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`删除 ${server.name}`}
                                  onClick={() => void handleDelete(server)}
                                >
                                  <Trash2 size={14} aria-hidden />
                                </Button>
                              </Tooltip>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              loading={loading}
              onChange={setPage}
            />
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button
              onClick={() => {
                setEditingGroup(null)
                setGroupName('')
                setGroupDesc('')
                setGroupDialogOpen(true)
              }}
            >
              <Plus size={14} aria-hidden />
              新建分组
            </Button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">名称</th>
                    <th className="px-4 py-3 font-medium">说明</th>
                    <th className="px-4 py-3 font-medium">服务器</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-400">
                        还没有分组
                      </td>
                    </tr>
                  ) : (
                    groups.map((group) => (
                      <tr key={group.id} className="border-t border-slate-100">
                        <td className="px-4 py-3 font-medium text-slate-900">{group.name}</td>
                        <td className="px-4 py-3 text-slate-600">{group.description ?? '—'}</td>
                        <td className="px-4 py-3 tabular-nums text-slate-600">{group.serverCount}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <Tooltip content="编辑分组">
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`编辑 ${group.name}`}
                                onClick={() => {
                                  setEditingGroup(group)
                                  setGroupName(group.name)
                                  setGroupDesc(group.description ?? '')
                                  setGroupDialogOpen(true)
                                }}
                              >
                                <Pencil size={14} aria-hidden />
                              </Button>
                            </Tooltip>
                            <Tooltip content="删除分组">
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`删除 ${group.name}`}
                                onClick={() => void handleGroupDelete(group)}
                              >
                                <Trash2 size={14} aria-hidden />
                              </Button>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 新建服务器 */}
      <AppDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="新建服务器"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button type="submit" form="create-server-form">
              创建
            </Button>
          </>
        }
      >
        <form
          id="create-server-form"
          className="space-y-4"
          noValidate
          onSubmit={(event) => void handleCreate(event)}
        >
          <Field label="服务器名称" required error={serverForm.errors.name}>
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="例如 prod-web-01"
              aria-invalid={serverForm.errors.name ? true : undefined}
            />
          </Field>
          <Field label="分组">
            <Select value={newGroup} onChange={setNewGroup} options={groupOptions} />
          </Field>
        </form>
      </AppDialog>

      {/* 新建或编辑分组 */}
      <AppDialog
        open={groupDialogOpen}
        onOpenChange={(open) => {
          setGroupDialogOpen(open)
          if (!open) {
            setEditingGroup(null)
            setGroupName('')
            setGroupDesc('')
          }
        }}
        title={editingGroup ? '编辑分组' : '新建分组'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setGroupDialogOpen(false)}>
              取消
            </Button>
            <Button type="submit" form="group-form">
              保存
            </Button>
          </>
        }
      >
        <form
          id="group-form"
          className="space-y-4"
          noValidate
          onSubmit={(event) => void handleGroupSubmit(event)}
        >
          <Field label="分组名称" required error={groupForm.errors.name}>
            <Input
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder="例如 生产环境"
              aria-invalid={groupForm.errors.name ? true : undefined}
            />
          </Field>
          <Field label="说明(可选)">
            <Input
              value={groupDesc}
              onChange={(event) => setGroupDesc(event.target.value)}
              placeholder="用途说明"
            />
          </Field>
        </form>
      </AppDialog>

      {/* 安装方式: 脚本命令 / AI Skill */}
      <AppDialog
        open={installCommand !== null}
        onOpenChange={(next) => {
          if (!next) setInstallCommand(null)
        }}
        title="安装 Agent"
        width="min(100% - 2rem, 680px)"
        footer={<Button onClick={() => setInstallCommand(null)}>关闭</Button>}
      >
        {installCommand ? (
          <div className="space-y-3">
            {installCommand.skill ? (
              <Tabs
                value={installTab}
                onChange={setInstallTab}
                ariaLabel="安装方式"
                options={[
                  { value: 'script', label: '脚本' },
                  { value: 'skill', label: 'Skill' },
                ]}
              />
            ) : null}
            {(() => {
              const text =
                installTab === 'skill' && installCommand.skill ? installCommand.skill : installCommand.script
              return (
                <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-slate-900">
                    {text}
                  </pre>
                  <Button
                    size="icon"
                    variant="secondary"
                    aria-label={installTab === 'skill' ? '复制 Skill' : '复制安装命令'}
                    onClick={() => {
                      void navigator.clipboard?.writeText(text)
                      toast({ variant: 'success', title: installTab === 'skill' ? 'Skill 已复制' : '安装命令已复制' })
                    }}
                  >
                    <Copy size={12} aria-hidden />
                  </Button>
                </div>
              )
            })()}
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {installTab === 'skill'
                ? 'Skill 内含该服务器的 Agent Token，等同于登录凭据：只交给可信的 AI 助手，不要分享。'
                : '命令内含该服务器的 Agent Token，等同于登录凭据：只粘贴到目标机器执行，不要分享或留在命令历史里。怀疑泄露时轮换 Token，然后重新执行安装命令。'}
            </p>
          </div>
        ) : null}
      </AppDialog>
      <ConfirmDialog
        open={confirmRequest !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRequest(null)
        }}
        title={confirmRequest?.title ?? ''}
        description={confirmRequest?.description}
        confirmText={confirmRequest?.confirmText}
        danger={confirmRequest?.danger}
        loading={confirmLoading}
        onConfirm={() => void handleConfirm()}
      />
    </div>
  )
}
