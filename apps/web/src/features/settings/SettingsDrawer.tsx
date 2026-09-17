import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, Copy, KeyRound, Link2Off, Pencil, Plus, RefreshCw, TerminalSquare, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { AgentAvailability, SettingsDto, UpdateSettingsInput } from "@yarnball/shared";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";
import { useOwnerAuth } from "../../lib/principal";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

/** 高德三个 key 的表单字段定义 */
const AMAP_FIELDS = [
  { key: "amapJsKey", label: "JS API Key", hint: "前端地图渲染（AMAP_JS_KEY）" },
  { key: "amapServerKey", label: "Web 服务 Key", hint: "POI 搜索 / 路线规划（AMAP_SERVER_KEY）" },
  { key: "amapJsSecret", label: "JS API 安全密钥", hint: "安全密钥（AMAP_JS_SECRET）" },
] as const;

type AmapFieldKey = (typeof AMAP_FIELDS)[number]["key"];

/** agent 编辑表单状态（id 为空表示新建） */
interface AgentFormState {
  id: string | null;
  label: string;
  command: string;
  argsText: string; // 空格分隔，提交时拆开
  enabled: boolean;
}

const EMPTY_FORM: AgentFormState = { id: null, label: "", command: "", argsText: "", enabled: true };

/** 设置抽屉内的分区锚点：引导条点击步骤时定位 */
export type SettingsSection = "amap" | "agents";

/** 设置抽屉：高德密钥 + agent CLI 管理，从右侧滑出 */
export function SettingsDrawer({
  open,
  onOpenChange,
  focusSection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开后滚动定位到的分区（来自引导条步骤点击） */
  focusSection?: SettingsSection;
}) {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  // 三个 key 的输入值（留空 = 保持不变）；cleared 记录用户点了「清除」的字段
  const [keyInputs, setKeyInputs] = useState<Record<AmapFieldKey, string>>({
    amapJsKey: "",
    amapServerKey: "",
    amapJsSecret: "",
  });
  const [clearedKeys, setClearedKeys] = useState<Set<AmapFieldKey>>(new Set());
  const [savingKeys, setSavingKeys] = useState(false);

  const [agents, setAgents] = useState<AgentAvailability[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentAvailability | null>(null);
  const [deleting, setDeleting] = useState(false);

  // owner token（issue #16）：配置态 + 生成/重置后的一次性明文展示
  const [ownerTokenConfigured, setOwnerTokenConfigured] = useState<boolean | null>(null);
  const [ownerToken, setOwnerToken] = useState<string | null>(null);
  const [ownerTokenBusy, setOwnerTokenBusy] = useState(false);
  const [confirmResetOwnerToken, setConfirmResetOwnerToken] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  // 远程主人登录态（issue #32）：本浏览器是否以 owner token 登录（本机 loopback 恒可用，无需登录）
  const remoteOwnerSignedIn = useOwnerAuth((s) => s.token != null);
  const signOutOwner = useOwnerAuth((s) => s.signOut);

  const amapSectionRef = useRef<HTMLElement>(null);
  const agentsSectionRef = useRef<HTMLElement>(null);

  // 引导条步骤点击：抽屉打开后滚动到对应分区
  useEffect(() => {
    if (!open || !focusSection) return;
    const el = focusSection === "amap" ? amapSectionRef.current : agentsSectionRef.current;
    const timer = window.setTimeout(
      () => el?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
    return () => window.clearTimeout(timer);
  }, [open, focusSection]);

  async function reload() {
    const [settingsRes, agentsRes, ownerTokenRes] = await Promise.allSettled([
      api.getSettings(),
      api.detectAgents(),
      api.getOwnerTokenStatus(),
    ]);
    if (settingsRes.status === "fulfilled") {
      setSettings(settingsRes.value.settings);
    } else {
      toast.error("加载设置失败", { description: (settingsRes.reason as Error).message });
    }
    if (ownerTokenRes.status === "fulfilled") {
      setOwnerTokenConfigured(ownerTokenRes.value.configured);
    } else {
      setOwnerTokenConfigured(null);
    }
    if (agentsRes.status === "fulfilled") {
      setAgents(agentsRes.value.agents);
    } else {
      // detect 失败时退化为纯列表（无可用性圆点）
      try {
        const { agents } = await api.listAgents();
        setAgents(agents.map((a) => ({ ...a, available: false })));
      } catch (err) {
        toast.error("加载 agent 列表失败", { description: (err as Error).message });
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    setKeyInputs({ amapJsKey: "", amapServerKey: "", amapJsSecret: "" });
    setClearedKeys(new Set());
    setForm(null);
    setOwnerToken(null);
    setConfirmResetOwnerToken(false);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function redetect() {
    setDetecting(true);
    try {
      const { agents } = await api.detectAgents();
      setAgents(agents);
    } catch (err) {
      toast.error("检测失败", { description: (err as Error).message });
    } finally {
      setDetecting(false);
    }
  }

  /** 生成/重置 owner token：明文仅此一次展示（DB 只存 hash，之后无法找回，只能再重置） */
  async function resetOwnerToken() {
    setOwnerTokenBusy(true);
    try {
      const { token } = await api.resetOwnerToken();
      setOwnerToken(token);
      setOwnerTokenConfigured(true);
      setConfirmResetOwnerToken(false);
      setCopiedToken(false);
    } catch (err) {
      toast.error("生成失败", { description: (err as Error).message });
    } finally {
      setOwnerTokenBusy(false);
    }
  }

  async function copyOwnerToken() {
    if (!ownerToken) return;
    try {
      await navigator.clipboard.writeText(ownerToken);
      setCopiedToken(true);
      window.setTimeout(() => setCopiedToken(false), 2000);
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  }

  async function saveKeys() {
    const payload: UpdateSettingsInput = {};
    for (const { key } of AMAP_FIELDS) {
      // null = 清除 DB 覆盖回退环境变量（契约语义）
      if (clearedKeys.has(key)) payload[key] = null;
      else if (keyInputs[key].trim()) payload[key] = keyInputs[key].trim();
    }
    if (Object.keys(payload).length === 0) {
      toast.info("没有需要保存的改动");
      return;
    }
    setSavingKeys(true);
    try {
      const { settings } = await api.updateSettings(payload);
      setSettings(settings);
      setKeyInputs({ amapJsKey: "", amapServerKey: "", amapJsSecret: "" });
      setClearedKeys(new Set());
      toast.success("密钥已保存");
    } catch (err) {
      toast.error("保存失败", { description: (err as Error).message });
    } finally {
      setSavingKeys(false);
    }
  }

  async function saveAgent() {
    if (!form || !form.label.trim() || !form.command.trim()) return;
    setSavingAgent(true);
    const input = {
      label: form.label.trim(),
      command: form.command.trim(),
      args: form.argsText.split(/\s+/).filter(Boolean),
      enabled: form.enabled,
    };
    try {
      if (form.id) {
        await api.updateAgent(form.id, input);
        toast.success(`已更新「${input.label}」`);
      } else {
        await api.createAgent(input);
        toast.success(`已添加「${input.label}」`);
      }
      setForm(null);
      await redetect();
    } catch (err) {
      toast.error("保存 agent 失败", { description: (err as Error).message });
    } finally {
      setSavingAgent(false);
    }
  }

  async function toggleAgent(agent: AgentAvailability, enabled: boolean) {
    // 乐观更新
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled } : a)));
    try {
      await api.updateAgent(agent.id, { enabled });
    } catch (err) {
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled: !enabled } : a)));
      toast.error("更新失败", { description: (err as Error).message });
    }
  }

  async function confirmRemoveAgent() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { disabled } = await api.deleteAgent(deleteTarget.id);
      if (disabled) {
        // 有历史会话引用：服务端只停用不删除，刷新列表同步状态
        toast.success(`「${deleteTarget.label}」有历史会话引用，已改为停用`);
        await redetect();
      } else {
        setAgents((prev) => prev.filter((a) => a.id !== deleteTarget.id));
        toast.success(`已删除「${deleteTarget.label}」`);
      }
      setDeleteTarget(null);
    } catch (err) {
      toast.error("删除失败", { description: (err as Error).message });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-slate-200/80 bg-white shadow-2xl focus:outline-none">
          {/* 头部 */}
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <DialogPrimitive.Title className="text-base font-semibold text-slate-900">
              设置
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              管理高德地图密钥与 agent CLI
            </DialogPrimitive.Description>
            <DialogPrimitive.Close className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5">
            {/* 高德密钥 */}
            <section ref={amapSectionRef}>
              <div className="mb-1 flex items-center gap-2">
                <KeyRound className="size-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-800">高德地图密钥</h2>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-slate-400">
                国内行程的可选增强：配置后新建国内行程走高德（POI 搜索与公交数据更准）；未配置时国内行程自动使用开源地图引擎（OSM），海外行程始终零配置。保存在服务端数据库，优先级高于环境变量；清除后回退环境变量。
              </p>
              <div className="space-y-3.5">
                {AMAP_FIELDS.map(({ key, label, hint }) => {
                  const configured = Boolean(settings?.[key]);
                  // 只有 DB 覆盖的值才能从界面上清除；env 兜底值清除无意义
                  const overridden = Boolean(settings?.overridden[key]);
                  const cleared = clearedKeys.has(key);
                  return (
                    <div key={key}>
                      <div className="mb-1 flex items-center justify-between">
                        <Label htmlFor={`settings-${key}`}>{label}</Label>
                        {cleared ? (
                          <button
                            type="button"
                            onClick={() =>
                              setClearedKeys((prev) => {
                                const next = new Set(prev);
                                next.delete(key);
                                return next;
                              })
                            }
                            className="text-xs text-red-400 underline-offset-2 transition-colors hover:text-slate-600 hover:underline"
                          >
                            保存后清除 · 撤销
                          </button>
                        ) : overridden ? (
                          <button
                            type="button"
                            onClick={() => setClearedKeys((prev) => new Set(prev).add(key))}
                            className="inline-flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-red-500"
                          >
                            <span className="size-1.5 rounded-full bg-available" />
                            已配置 · 清除
                          </button>
                        ) : configured ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                            <span className="size-1.5 rounded-full bg-available" />
                            来自环境变量
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                            <span className="size-1.5 rounded-full bg-slate-300" />
                            未配置
                          </span>
                        )}
                      </div>
                      <Input
                        id={`settings-${key}`}
                        type="password"
                        autoComplete="off"
                        disabled={cleared}
                        value={keyInputs[key]}
                        onChange={(e) =>
                          setKeyInputs((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        placeholder={configured && !cleared ? "••••••••（输入以覆盖）" : hint}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex justify-end">
                <Button variant="primary" size="sm" onClick={saveKeys} disabled={savingKeys}>
                  {savingKeys ? "保存中…" : "保存密钥"}
                </Button>
              </div>
            </section>

            <hr className="my-6 border-slate-100" />

            {/* owner token（issue #16：远程访问凭证；链接管理面板在后续 issue） */}
            <section>
              <div className="mb-1 flex items-center gap-2">
                <Link2Off className="size-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-800">远程访问凭证</h2>
              </div>
              <p className="mb-3 text-xs leading-relaxed text-slate-400">
                owner token 用于在局域网 / 公网远程访问时证明「行程主人」身份（本机访问无需它）。
                在其他设备上打开 <code className="rounded bg-slate-100 px-1 py-0.5 font-mono">/login</code> 粘贴
                token 即可登录获得完整功能（issue #32）；也可凭 API 请求头
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono"> Authorization: Bearer &lt;token&gt;</code> 携带。
                仅在生成时展示一次，之后无法找回，只能重置（旧 token 立即失效，远程已登录设备全部掉线）。
              </p>
              {ownerToken ? (
                <div className="space-y-2.5 rounded-box border border-blue-200/70 bg-blue-50/40 p-3.5">
                  <p className="text-xs font-medium text-slate-600">
                    新 token 已生成（仅此一次展示，请立即复制保存）：
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-mono text-xs text-slate-700">
                      {ownerToken}
                    </code>
                    <Button variant="outline" size="sm" onClick={copyOwnerToken}>
                      {copiedToken ? <Check /> : <Copy />}
                      {copiedToken ? "已复制" : "复制"}
                    </Button>
                  </div>
                </div>
              ) : confirmResetOwnerToken ? (
                <div className="space-y-2.5 rounded-box border border-red-200/70 bg-red-50/40 p-3.5">
                  <p className="text-xs leading-relaxed text-slate-600">
                    {ownerTokenConfigured
                      ? "重置会立即使旧 token 失效，正在用它远程访问的设备将全部掉线。确定重置？"
                      : "确定生成 owner token？"}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setConfirmResetOwnerToken(false)}>
                      取消
                    </Button>
                    <Button variant="destructive" size="sm" onClick={resetOwnerToken} disabled={ownerTokenBusy}>
                      {ownerTokenBusy ? "生成中…" : ownerTokenConfigured ? "确认重置" : "生成"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        ownerTokenConfigured ? "bg-available" : "bg-slate-300",
                      )}
                    />
                    {ownerTokenConfigured ? "已生成" : "未生成"}
                    {remoteOwnerSignedIn && (
                      <span className="ml-1 rounded-full bg-blue-500/12 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                        本浏览器已登录
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    {remoteOwnerSignedIn && (
                      <Button variant="ghost" size="sm" onClick={signOutOwner}>
                        退出远程主人身份
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmResetOwnerToken(true)}
                      disabled={ownerTokenBusy}
                    >
                      <RefreshCw className={cn("size-3", ownerTokenBusy && "animate-spin")} />
                      {ownerTokenConfigured ? "重置" : "生成"}
                    </Button>
                  </span>
                </div>
              )}
            </section>

            <hr className="my-6 border-slate-100" />

            {/* Agent CLI */}
            <section ref={agentsSectionRef}>
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TerminalSquare className="size-4 text-slate-400" />
                  <h2 className="text-sm font-semibold text-slate-800">Agent CLI</h2>
                </div>
                <button
                  type="button"
                  onClick={redetect}
                  disabled={detecting}
                  className="inline-flex items-center gap-1 text-xs text-slate-400 transition-colors hover:text-slate-600 disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3", detecting && "animate-spin")} />
                  重新检测
                </button>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-slate-400">
                通过 ACP 协议接入的命令行 agent（如 kimi acp、gemini acp）。绿点表示命令在 PATH 中可用。
              </p>

              <div className="space-y-2">
                {agents.length === 0 && form == null && (
                  <p className="rounded-box border border-dashed border-slate-200 py-6 text-center text-xs text-slate-400">
                    还没有注册 agent CLI
                  </p>
                )}
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 rounded-box border border-slate-200/80 bg-white/80 px-3.5 py-3"
                  >
                    <span
                      title={agent.available ? "命令可用" : "未检测到命令"}
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        agent.available ? "bg-available" : "bg-slate-300",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{agent.label}</p>
                      <p className="truncate font-mono text-xs text-slate-400">
                        {agent.command} {agent.args.join(" ")}
                      </p>
                    </div>
                    <Switch
                      aria-label={`启用 ${agent.label}`}
                      checked={agent.enabled}
                      onCheckedChange={(enabled) => toggleAgent(agent, enabled)}
                    />
                    <button
                      type="button"
                      aria-label={`编辑 ${agent.label}`}
                      onClick={() =>
                        setForm({
                          id: agent.id,
                          label: agent.label,
                          command: agent.command,
                          argsText: agent.args.join(" "),
                          enabled: agent.enabled,
                        })
                      }
                      className="rounded-lg p-1.5 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`删除 ${agent.label}`}
                      onClick={() => setDeleteTarget(agent)}
                      className="rounded-lg p-1.5 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {/* 新建 / 编辑表单 */}
              {form ? (
                <div className="mt-3 space-y-3 rounded-box border border-blue-200/70 bg-blue-50/40 p-3.5">
                  <p className="text-xs font-medium text-slate-600">
                    {form.id ? "编辑 agent" : "新建 agent"}
                  </p>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <Label htmlFor="agent-label" className="mb-1 block text-xs">
                        名称
                      </Label>
                      <Input
                        id="agent-label"
                        value={form.label}
                        onChange={(e) => setForm({ ...form, label: e.target.value })}
                        placeholder="Kimi Code"
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label htmlFor="agent-command" className="mb-1 block text-xs">
                        命令
                      </Label>
                      <Input
                        id="agent-command"
                        value={form.command}
                        onChange={(e) => setForm({ ...form, command: e.target.value })}
                        placeholder="kimi"
                        className="h-8 font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="agent-args" className="mb-1 block text-xs">
                      参数（空格分隔）
                    </Label>
                    <Input
                      id="agent-args"
                      value={form.argsText}
                      onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                      placeholder="acp"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Switch
                        id="agent-enabled"
                        checked={form.enabled}
                        onCheckedChange={(enabled) => setForm({ ...form, enabled })}
                      />
                      <Label htmlFor="agent-enabled" className="text-xs">
                        启用
                      </Label>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                        取消
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={saveAgent}
                        disabled={savingAgent || !form.label.trim() || !form.command.trim()}
                      >
                        <Check />
                        {savingAgent ? "保存中…" : "保存"}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => setForm(EMPTY_FORM)}
                >
                  <Plus />
                  添加 agent CLI
                </Button>
              )}
            </section>

            <hr className="my-6 border-slate-100" />

            {/* 数据源署名（transitous usage policy 硬性义务：UI 可见处署名链接） */}
            <section>
              <p className="text-xs leading-relaxed text-slate-400">
                海外公共交通数据由{" "}
                <a
                  href="https://transitous.org"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 transition-colors hover:text-slate-600"
                >
                  transitous.org
                </a>{" "}
                （MOTIS 2，全球 GTFS 聚合）提供；海外地图数据 © OpenStreetMap contributors。
              </p>
            </section>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      {/* 删除 agent 确认（嵌套 Dialog，与行程删除确认同一模式） */}
      <Dialog open={deleteTarget != null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除 agent？</DialogTitle>
            <DialogDescription>
              「{deleteTarget?.label}」（{deleteTarget?.command}）将从注册列表中移除；若有历史会话引用则改为停用。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmRemoveAgent} disabled={deleting}>
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DialogPrimitive.Root>
  );
}
