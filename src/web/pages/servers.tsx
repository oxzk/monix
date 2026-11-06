/**
 * 服务器管理页.
 *
 * 两个标签页共用一份数据: 服务器表格与分组表格. 表格行的操作包括
 * 执行命令、打开终端、复制安装命令和删除; 分组通过弹窗新增或编辑.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Copy, Pencil, Plus, Search, SquareTerminal, Terminal, Trash2 } from 'lucide-react'
import { groupsApi, serversApi } from '@/api/resources'
import type { Group, ServerSummary } from '@/api/types'
import { useMonitorStream } from '@/hooks/use-monitor-stream'
import { useToast } from '@/components/toast'
import {
  AppDialog,
  Button,
  Field,
  Input,
  Select,
  Tabs,
  useFieldErrors,
  type SelectOption,
} from '@/components/ui'
import { cn, formatAgo } from '@/lib/utils'

export function ServersPage(): ReactElement {
  const navigate = useNavigate()
  const stream = useMonitorStream()
  const { toast } = useToast()

  const [servers, setServers] = useState<ServerSummary[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

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

  const [installCommand, setInstallCommand] = useState<{ name: string; command: string } | null>(null)

  const serverForm = useFieldErrors<'name'>()
  const groupForm = useFieldErrors<'name'>()

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [list, groupList] = await Promise.all([
        serversApi.list({ limit: 100 }, signal),
        groupsApi.list(signal),
      ])
      setServers(list.items)
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
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const visible = useMemo<ServerSummary[]>(() => {
    return servers.filter((server) => {
      if (statusFilter) {
        const live = stream.snapshots.get(server.id)?.status ?? server.status
        if (live !== statusFilter) return false
      }
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
  }, [servers, stream.snapshots, statusFilter, groupFilter, query])

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
      toast({ variant: 'success', title: '服务器已创建', description: '可在操作列点击“安装命令”复制 Agent 安装脚本。' })
      setNewName('')
      setNewGroup('')
      setCreateOpen(false)
      await load()
    } catch (err) {
      toast({ variant: 'error', title: '创建失败', description: err instanceof Error ? err.message : undefined })
    }
  }

  async function handleInstallCommand(id: string, name: string): Promise<void> {
    try {
      const result = await serversApi.getInstallCommand(id)
      try {
        await navigator.clipboard.writeText(result.command)
        toast({ variant: 'success', title: '安装命令已复制', description: '在目标服务器上粘贴执行即可。' })
      } catch {
        // 剪贴板不可用时回退为弹窗展示, 便于手工复制.
        setInstallCommand({ name, command: result.command })
      }
    } catch (err) {
      toast({ variant: 'error', title: '获取安装命令失败', description: err instanceof Error ? err.message : undefined })
    }
  }

  async function handleDelete(server: ServerSummary): Promise<void> {
    if (!window.confirm(`删除服务器 ${server.name}? 该操作会断开其连接, 且不可恢复。`)) return
    try {
      await serversApi.remove(server.id)
      await load()
    } catch (err) {
      toast({ variant: 'error', title: '删除失败', description: err instanceof Error ? err.message : undefined })
    }
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
      await load()
    } catch (err) {
      toast({ variant: 'error', title: '保存分组失败', description: err instanceof Error ? err.message : undefined })
    }
  }

  async function handleGroupDelete(group: Group): Promise<void> {
    if (!window.confirm(`删除分组 ${group.name}? 组内服务器会解除关联, 但不会被删除。`)) return
    try {
      await groupsApi.remove(group.id)
      await load()
    } catch (err) {
      toast({ variant: 'error', title: '删除分组失败', description: err instanceof Error ? err.message : undefined })
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">服务器</h1>
          <p className="mt-1 text-sm text-slate-500">
            Agent Token 保存在数据库明文列中，可随时查看。数据库访问权限需要严格限制。
          </p>
        </div>
        {tab === 'servers' ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={14} aria-hidden />
            新建服务器
          </Button>
        ) : null}
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
                    <th className="whitespace-nowrap px-4 py-3 font-medium">最近上报</th>
                    <th className="whitespace-nowrap px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                        加载中...
                      </td>
                    </tr>
                  ) : visible.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                        没有匹配的服务器
                      </td>
                    </tr>
                  ) : (
                    visible.map((server) => {
                      const snapshot = stream.snapshots.get(server.id)
                      const online = (snapshot?.status ?? server.status) === 'online'
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
                            {server.ipv4 ?? server.ipv6 ?? '—'}
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
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">
                            {formatAgo(snapshot?.receivedTs ?? null)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`对 ${server.name} 执行命令`}
                                title="执行命令"
                                onClick={() => navigate(`/servers/${encodeURIComponent(server.id)}?action=command`)}
                              >
                                <Terminal size={14} aria-hidden />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`打开 ${server.name} 的终端`}
                                title="打开终端"
                                onClick={() => navigate(`/servers/${encodeURIComponent(server.id)}?action=terminal`)}
                              >
                                <SquareTerminal size={14} aria-hidden />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`复制 ${server.name} 的安装命令`}
                                title="复制安装命令"
                                onClick={() => void handleInstallCommand(server.id, server.name)}
                              >
                                <Copy size={14} aria-hidden />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`删除 ${server.name}`}
                                title="删除"
                                onClick={() => void handleDelete(server)}
                              >
                                <Trash2 size={14} aria-hidden />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
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
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`编辑 ${group.name}`}
                              title="编辑"
                              onClick={() => {
                                setEditingGroup(group)
                                setGroupName(group.name)
                                setGroupDesc(group.description ?? '')
                                setGroupDialogOpen(true)
                              }}
                            >
                              <Pencil size={14} aria-hidden />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`删除 ${group.name}`}
                              title="删除"
                              onClick={() => void handleGroupDelete(group)}
                            >
                              <Trash2 size={14} aria-hidden />
                            </Button>
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

      {/* 安装命令(剪贴板不可用时展示) */}
      <AppDialog
        open={installCommand !== null}
        onOpenChange={(next) => {
          if (!next) setInstallCommand(null)
        }}
        title={installCommand ? `${installCommand.name} 的安装命令` : '安装命令'}
        footer={<Button onClick={() => setInstallCommand(null)}>关闭</Button>}
      >
        {installCommand ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-slate-900">{installCommand.command}</code>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void navigator.clipboard?.writeText(installCommand.command)}
              >
                <Copy size={12} aria-hidden />
                复制
              </Button>
            </div>
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              命令包含 Agent Token, 请勿粘贴到公开位置。Token 以明文保存在数据库中，请限制数据库访问权限。
            </p>
          </div>
        ) : null}
      </AppDialog>
    </div>
  )
}
