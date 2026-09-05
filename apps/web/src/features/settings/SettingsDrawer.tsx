import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, KeyRound, Pencil, Plus, RefreshCw, TerminalSquare, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import {
  settingsApi,
  type AgentCliStatus,
  type AppSettings,
  type UpdateSettingsInput,
} from "./api";

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
  name: string;
  command: string;
  argsText: string; // 空格分隔，提交时拆开
  enabled: boolean;
}

const EMPTY_FORM: AgentFormState = { id: null, name: "", command: "", argsText: "", enabled: true };

/** 设置抽屉：高德密钥 + agent CLI 管理，从右侧滑出 */
export function SettingsDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // 三个 key 的输入值（留空 = 保持不变）；cleared 记录用户点了「清除」的字段
  const [keyInputs, setKeyInputs] = useState<Record<AmapFieldKey, string>>({
    amapJsKey: "",
    amapServerKey: "",
    amapJsSecret: "",
  });
  const [clearedKeys, setClearedKeys] = useState<Set<AmapFieldKey>>(new Set());
  const [savingKeys, setSavingKeys] = useState(false);

  const [agents, setAgents] = useState<AgentCliStatus[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);

  async function reload() {
    const [settingsRes, agentsRes] = await Promise.allSettled([
      settingsApi.getSettings(),
      settingsApi.detectAgents(),
    ]);
    if (settingsRes.status === "fulfilled") {
      setSettings(settingsRes.value.settings);
    } else {
      toast.error("加载设置失败", { description: (settingsRes.reason as Error).message });
    }
    if (agentsRes.status === "fulfilled") {
      setAgents(agentsRes.value.agents);
    } else {
      // detect 失败时退化为纯列表（无可用性圆点）
      try {
        const { agents } = await settingsApi.listAgents();
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
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function redetect() {
    setDetecting(true);
    try {
      const { agents } = await settingsApi.detectAgents();
      setAgents(agents);
    } catch (err) {
      toast.error("检测失败", { description: (err as Error).message });
    } finally {
      setDetecting(false);
    }
  }

  async function saveKeys() {
    const payload: UpdateSettingsInput = {};
    for (const { key } of AMAP_FIELDS) {
      if (clearedKeys.has(key)) payload[key] = "";
      else if (keyInputs[key].trim()) payload[key] = keyInputs[key].trim();
    }
    if (Object.keys(payload).length === 0) {
      toast.info("没有需要保存的改动");
      return;
    }
    setSavingKeys(true);
    try {
      const { settings } = await settingsApi.updateSettings(payload);
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
    if (!form || !form.name.trim() || !form.command.trim()) return;
    setSavingAgent(true);
    const input = {
      name: form.name.trim(),
      command: form.command.trim(),
      args: form.argsText.split(/\s+/).filter(Boolean),
      enabled: form.enabled,
    };
    try {
      if (form.id) {
        await settingsApi.updateAgent(form.id, input);
        toast.success(`已更新「${input.name}」`);
      } else {
        await settingsApi.createAgent(input);
        toast.success(`已添加「${input.name}」`);
      }
      setForm(null);
      await redetect();
    } catch (err) {
      toast.error("保存 agent 失败", { description: (err as Error).message });
    } finally {
      setSavingAgent(false);
    }
  }

  async function toggleAgent(agent: AgentCliStatus, enabled: boolean) {
    // 乐观更新
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled } : a)));
    try {
      await settingsApi.updateAgent(agent.id, { enabled });
    } catch (err) {
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, enabled: !enabled } : a)));
      toast.error("更新失败", { description: (err as Error).message });
    }
  }

  async function removeAgent(agent: AgentCliStatus) {
    try {
      await settingsApi.deleteAgent(agent.id);
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
      toast.success(`已删除「${agent.name}」`);
    } catch (err) {
      toast.error("删除失败", { description: (err as Error).message });
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
            <DialogPrimitive.Close className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5">
            {/* 高德密钥 */}
            <section>
              <div className="mb-1 flex items-center gap-2">
                <KeyRound className="size-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-800">高德地图密钥</h2>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-slate-400">
                仅国内行程需要；海外行程走开源地图引擎，无需配置。保存在服务端数据库，优先级高于环境变量。
              </p>
              <div className="space-y-3.5">
                {AMAP_FIELDS.map(({ key, label, hint }) => {
                  const configured = Boolean(settings?.[key]);
                  const cleared = clearedKeys.has(key);
                  return (
                    <div key={key}>
                      <div className="mb-1 flex items-center justify-between">
                        <Label htmlFor={`settings-${key}`}>{label}</Label>
                        {configured && !cleared ? (
                          <button
                            type="button"
                            onClick={() => setClearedKeys((prev) => new Set(prev).add(key))}
                            className="text-xs text-slate-400 transition-colors hover:text-red-500"
                          >
                            已配置 · 清除
                          </button>
                        ) : (
                          <span className={cn("text-xs", cleared ? "text-red-400" : "text-slate-300")}>
                            {cleared ? "保存后清除" : "未配置"}
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

            {/* Agent CLI */}
            <section>
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
                  <p className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-xs text-slate-400">
                    还没有注册 agent CLI
                  </p>
                )}
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5"
                  >
                    <span
                      title={agent.available ? "命令可用" : "未检测到命令"}
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        agent.available ? "bg-emerald-500" : "bg-slate-300",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{agent.name}</p>
                      <p className="truncate font-mono text-xs text-slate-400">
                        {agent.command} {agent.args.join(" ")}
                      </p>
                    </div>
                    <Switch
                      aria-label={`启用 ${agent.name}`}
                      checked={agent.enabled}
                      onCheckedChange={(enabled) => toggleAgent(agent, enabled)}
                    />
                    <button
                      type="button"
                      aria-label={`编辑 ${agent.name}`}
                      onClick={() =>
                        setForm({
                          id: agent.id,
                          name: agent.name,
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
                      aria-label={`删除 ${agent.name}`}
                      onClick={() => removeAgent(agent)}
                      className="rounded-lg p-1.5 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {/* 新建 / 编辑表单 */}
              {form ? (
                <div className="mt-3 space-y-3 rounded-xl border border-blue-200/70 bg-blue-50/40 p-3.5">
                  <p className="text-xs font-medium text-slate-600">
                    {form.id ? "编辑 agent" : "新建 agent"}
                  </p>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <Label htmlFor="agent-name" className="mb-1 block text-xs">
                        名称
                      </Label>
                      <Input
                        id="agent-name"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
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
                        disabled={savingAgent || !form.name.trim() || !form.command.trim()}
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
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
