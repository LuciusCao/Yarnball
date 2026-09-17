import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Link2, Link2Off, Plus, Users, X } from "lucide-react";
import { toast } from "sonner";
import type { AccessLinkRole, TripAccessLinkDto } from "@yarnball/shared";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";
import { usePresence } from "../presence/usePresence";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog";

/**
 * 「分享与协作」面板（issue #17，owner 侧管理面）。
 *
 * 从行程页原「一个只读分享链接」升级为多链接管理：
 * - 只读分享区：老 shareToken 的 /share/:token 直链（现有能力保留），可复制 / 打开 / 吊销；
 *   吊销态权威数据在 trip_access_links（token == shareToken 的那条 viewer 链接）。
 * - 协作链接列表：每条显示备注名 / 角色 / 同伴昵称（#18 同伴入口激活后写入 displayName）/
 *   最近活跃时间 / 复制 / 吊销；last_seen_at 距今 < 90s 显示「在线」小绿点（精确 presence 在 #19）。
 * - 新建入口：选 viewer/editor + 备注名（缺省按角色给默认）。
 *
 * URL 约定（与 #18 同伴入口页的接口契约）：
 * - 老只读链接：location.origin + /share/:token（#17 之前就存在的只读直链）
 * - 协作链接：location.origin + /join/:token（/join 页面由 #18 实现，本面板只生成 URL 字符串）
 *
 * 数据面：全部走 #16 落好的 access-links REST（lib/api.ts 契约齐备，本文件零新增端点）；
 * 面板打开期间每 30s 轮询刷新（在线近似），关闭即停。
 */

/** 在线近似窗口：last_seen_at 距今小于该值显示「在线」绿点（节流写入 60s，见 server auth.ts）。
 *  #19 起作为 presence 不可用时的兜底（SSE 掉线/服务重启时精确名单短暂缺失） */
const ONLINE_WINDOW_MS = 90_000;
/** 面板打开期间的列表轮询间隔（活跃时间 / 在线状态保鲜） */
const REFRESH_INTERVAL_MS = 30_000;

const ROLE_META: Record<AccessLinkRole, { label: string; badge: "outline" | "blue" }> = {
  viewer: { label: "只读", badge: "outline" },
  editor: { label: "可编辑", badge: "blue" },
};

const ROLE_HINT: Record<AccessLinkRole, string> = {
  viewer: "同伴可查看行程与地图，不能修改",
  editor: "同伴还可以编辑地点、日程与预算",
};

/** 协作链接 URL（#18 的同伴入口页消费该路径） */
function joinUrlFor(token: string): string {
  return `${location.origin}/join/${token}`;
}

/** 老只读分享直链（/share/:token，行为与升级前完全一致） */
function shareUrlFor(token: string): string {
  return `${location.origin}/share/${token}`;
}

/** 最近活跃时间的相对展示：刚刚 / N 分钟前 / N 小时前 / M/D（跨年带年份） */
function formatLastSeen(iso: string | null): string {
  if (!iso) return "未使用";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "刚刚";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  const d = new Date(iso);
  const now = new Date();
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/** 在线近似（兜底）：presence 名单缺失时退回 last_seen_at 90s 窗口判定（精确名单见 usePresence） */
function isOnline(link: TripAccessLinkDto, onlineLabels: Set<string>): boolean {
  // 精确 presence：链接昵称（或备注名）出现在在线名单里（owner 自身显示为「主人」，不对应链接）
  if (onlineLabels.size > 0 && (link.displayName || link.label)) {
    if (onlineLabels.has(link.displayName!) || onlineLabels.has(link.label!)) return true;
  }
  if (!link.lastSeenAt) return false;
  return Date.now() - new Date(link.lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

export function ShareCollabDialog({
  tripId,
  shareToken,
  open,
  onOpenChange,
}: {
  tripId: string;
  /** trips.shareToken：老只读分享链接的 token（面板据此在链接列表里识别那条迁移/镜像记录） */
  shareToken: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [links, setLinks] = useState<TripAccessLinkDto[] | null>(null);
  const [creating, setCreating] = useState(false);
  /** 新建表单展开态（issue 方案：新建入口收进一个按钮，点开再填角色 + 备注名） */
  const [formOpen, setFormOpen] = useState(false);
  const [newRole, setNewRole] = useState<AccessLinkRole>("viewer");
  const [labelDraft, setLabelDraft] = useState("");
  /** 行内两步吊销确认：正在确认吊销的 linkId（列表行与只读分享区共用，同时只允许一个） */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 刚创建的链接 id：列表行高亮 + 「新」徽章，帮助用户定位去复制 */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** 最近一次成功复制的对象 key（行级「已复制」反馈，2s 后还原） */
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // 精确在线名单（issue #19 升级 #17 的 90s 近似）：SSE presence 事件驱动，
  // 名单拿不到（SSE 未就绪/断线）时 isOnline 自动退回 last_seen_at 兜底
  const presenceViewers = usePresence(tripId);
  const onlineLabels = new Set(presenceViewers.map((v) => v.label));

  /**
   * 备注名输入的 IME 组合标志位（issue #4/#12 同款修复）：WebKit 下中文输入法确认候选的
   * Enter 会被误判为提交，compositionend 后延迟一个宏任务再复位标志位。
   */
  const labelImeComposingRef = useRef(false);
  const labelImeResetTimerRef = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const { links } = await api.listAccessLinks(tripId);
      setLinks(links);
    } catch (err) {
      toast.error("加载访问链接失败", { description: (err as Error).message });
    }
  }, [tripId]);

  // 打开时拉全量列表并启动轮询（活跃时间/在线状态保鲜）；关闭即停。每次打开重置瞬时状态。
  useEffect(() => {
    if (!open) return;
    setLinks(null);
    setFormOpen(false);
    setConfirmId(null);
    setHighlightId(null);
    setCopiedKey(null);
    void reload();
    const timer = window.setInterval(() => void reload(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, reload]);

  /** 老只读分享链接：token == trips.shareToken 的那条 viewer 记录（建行程落库 / 存量迁移回填） */
  const legacyLink = links?.find((l) => l.token === shareToken) ?? null;
  /** 协作链接 = 除老链接外的全部记录；活跃在前（新建优先）、已吊销沉底，各按创建时间倒序 */
  const collabLinks = (links ?? []).filter((l) => l.id !== legacyLink?.id);
  const activeLinks = collabLinks
    .filter((l) => !l.revokedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const revokedLinks = collabLinks
    .filter((l) => l.revokedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  async function copyText(key: string, text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 2000);
    } catch {
      toast.error(`复制${what}失败，请手动选择复制`);
    }
  }

  async function createLink() {
    if (creating) return;
    setCreating(true);
    const label = labelDraft.trim();
    try {
      const { link } = await api.createAccessLink(tripId, newRole, label || undefined);
      // 本地并入 + 高亮，不整表重拉（30s 轮询会随后对齐服务端状态）
      setLinks((prev) => [...(prev ?? []), link]);
      setFormOpen(false);
      setLabelDraft("");
      setHighlightId(link.id);
      toast.success(
        `已创建${ROLE_META[newRole].label}链接${label ? `「${label}」` : ""}，复制发给同伴即可`,
      );
    } catch (err) {
      toast.error("创建链接失败", { description: (err as Error).message });
    } finally {
      setCreating(false);
    }
  }

  async function revokeLink(link: TripAccessLinkDto) {
    try {
      await api.revokeAccessLink(link.id);
      // 本地置吊销态（客户端时间仅作展示，下一次轮询以服务端为准）
      setLinks((prev) =>
        prev?.map((l) =>
          l.id === link.id ? { ...l, revokedAt: new Date().toISOString() } : l,
        ) ?? prev,
      );
      setConfirmId(null);
      toast.success(
        link.token === shareToken ? "只读分享链接已吊销，原 /share 链接立即失效" : "链接已吊销",
      );
    } catch (err) {
      toast.error("吊销失败", { description: (err as Error).message });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-sm flex-col overflow-hidden p-0">
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <DialogTitle className="text-base font-semibold text-slate-900">分享与协作</DialogTitle>
          <DialogDescription className="sr-only">
            管理本行程的只读分享链接与协作访问链接
          </DialogDescription>
          <DialogClose className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
            <X className="size-4" />
          </DialogClose>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* ---------- 只读分享区：老 shareToken 直链，现有能力保留 ---------- */}
          <section>
            <div className="mb-1 flex items-center gap-2">
              <Link2 className="size-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-800">只读分享</h2>
            </div>
            <p className="mb-2.5 text-xs leading-relaxed text-slate-400">
              任何人打开即可查看行程（无需登录），适合发到群聊；吊销后链接立即失效。
            </p>
            {links == null ? (
              <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-xs text-slate-400">
                加载中…
              </p>
            ) : legacyLink?.revokedAt ? (
              <div className="space-y-1.5 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3 py-2.5">
                <p className="flex items-center gap-2 text-xs text-slate-500">
                  <Link2Off className="size-3.5 shrink-0 text-slate-400" />
                  <span className="truncate font-mono" title={shareUrlFor(shareToken)}>
                    /share/{shareToken}
                  </span>
                  <Badge variant="destructive" className="ml-auto shrink-0">
                    已吊销
                  </Badge>
                </p>
                <p className="text-[11px] leading-relaxed text-slate-400">
                  链接已失效。可在下方新建一条「只读」协作链接重新分享。
                </p>
              </div>
            ) : (
              <div className="space-y-1.5 rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600"
                    title={shareUrlFor(shareToken)}
                  >
                    {shareUrlFor(shareToken)}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 px-2"
                    title="复制只读分享链接"
                    onClick={() => void copyText("legacy", shareUrlFor(shareToken), "链接")}
                  >
                    {copiedKey === "legacy" ? <Check /> : <Copy />}
                    {copiedKey === "legacy" ? "已复制" : "复制"}
                  </Button>
                  <a
                    href={shareUrlFor(shareToken)}
                    target="_blank"
                    rel="noreferrer"
                    title="打开只读分享页"
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white/70 text-slate-500 shadow-sm transition-colors hover:bg-white hover:text-slate-900"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-slate-400">
                    {legacyLink && isOnline(legacyLink, onlineLabels) && (
                      <span title="最近 90 秒内有访问" className="size-1.5 shrink-0 rounded-full bg-available" />
                    )}
                    <span className="truncate">
                      有效
                      {legacyLink?.lastSeenAt && ` · 最近 ${formatLastSeen(legacyLink.lastSeenAt)}有访问`}
                    </span>
                  </span>
                  {confirmId === legacyLink?.id ? (
                    <RevokeConfirm
                      onConfirm={() => legacyLink && void revokeLink(legacyLink)}
                      onCancel={() => setConfirmId(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      title="吊销后已发出的 /share 链接立即失效（不可恢复）"
                      onClick={() => legacyLink && setConfirmId(legacyLink.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-medium text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
                    >
                      <Link2Off className="size-3" />
                      吊销
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* ---------- 协作链接：多链接管理（创建 / 复制 / 吊销） ---------- */}
          <section>
            <div className="mb-1 flex items-center gap-2">
              <Users className="size-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-800">协作链接</h2>
            </div>
            <p className="mb-2.5 text-xs leading-relaxed text-slate-400">
              发给同伴的专属链接：对方打开后填写昵称即可加入。只读可查看，可编辑还能修改行程。
            </p>

            {links == null ? null : (
              <div className="space-y-1.5">
                {activeLinks.length === 0 && revokedLinks.length === 0 && (
                  <p className="rounded-xl border border-dashed border-slate-200 py-4 text-center text-xs text-slate-400">
                    还没有协作链接
                  </p>
                )}
                {[...activeLinks, ...revokedLinks].map((link) => {
                  const revoked = link.revokedAt != null;
                  const confirming = confirmId === link.id;
                  return (
                    <div
                      key={link.id}
                      className={cn(
                        "space-y-1.5 rounded-xl border px-3 py-2.5",
                        revoked
                          ? "border-slate-200/60 bg-slate-50/60 opacity-70"
                          : "border-slate-200/80 bg-white/80",
                        link.id === highlightId && "border-blue-300 bg-blue-50/40 ring-1 ring-blue-200",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {!revoked && isOnline(link, onlineLabels) && (
                          <span
                            title="在线（最近 90 秒内有访问）"
                            className="size-1.5 shrink-0 rounded-full bg-available"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                          {link.label ?? (link.role === "viewer" ? "只读分享" : "可编辑链接")}
                          {link.id === highlightId && (
                            <Badge variant="blue" className="ml-1.5 align-middle">
                              新
                            </Badge>
                          )}
                        </span>
                        <Badge variant={revoked ? "destructive" : ROLE_META[link.role].badge}>
                          {revoked ? "已吊销" : ROLE_META[link.role].label}
                        </Badge>
                        {!revoked && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0 px-2"
                            title="复制协作链接（同伴打开后填写昵称即可加入）"
                            onClick={() => void copyText(link.id, joinUrlFor(link.token), "链接")}
                          >
                            {copiedKey === link.id ? <Check /> : <Copy />}
                            {copiedKey === link.id ? "已复制" : "复制"}
                          </Button>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1 text-[11px] text-slate-400">
                          {link.displayName && (
                            <span className="truncate font-medium text-slate-500" title="同伴昵称">
                              {link.displayName}
                            </span>
                          )}
                          {link.displayName && <span>·</span>}
                          <span className="shrink-0" title="同伴最近一次访问时间">
                            {formatLastSeen(link.lastSeenAt)}
                          </span>
                        </span>
                        {!revoked &&
                          (confirming ? (
                            <RevokeConfirm
                              onConfirm={() => void revokeLink(link)}
                              onCancel={() => setConfirmId(null)}
                            />
                          ) : (
                            <button
                              type="button"
                              title="吊销后持该链接的同伴下次请求即被拒绝（不可恢复）"
                              onClick={() => setConfirmId(link.id)}
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-medium text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
                            >
                              <Link2Off className="size-3" />
                              吊销
                            </button>
                          ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 新建表单（issue 方案：选 viewer/editor + 填备注名） */}
            {formOpen ? (
              <div className="mt-2.5 space-y-3 rounded-xl border border-blue-200/70 bg-blue-50/40 p-3">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-600">角色</p>
                  <div className="flex rounded-full bg-slate-100 p-1">
                    {(Object.keys(ROLE_META) as AccessLinkRole[]).map((role) => (
                      <button
                        key={role}
                        type="button"
                        title={ROLE_HINT[role]}
                        onClick={() => setNewRole(role)}
                        className={`flex-1 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          newRole === role
                            ? "bg-slate-900 text-white shadow-sm"
                            : "text-slate-500 hover:text-slate-800"
                        }`}
                      >
                        {ROLE_META[role].label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{ROLE_HINT[newRole]}</p>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-600">
                    备注名<span className="ml-1 font-normal text-slate-400">（可选，方便区分发给谁）</span>
                  </p>
                  <Input
                    value={labelDraft}
                    maxLength={60}
                    placeholder="如：给小红的"
                    className="h-8 text-xs"
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onCompositionStart={() => {
                      // 新一轮组合开始时取消尚未执行的复位，避免误清标志位
                      if (labelImeResetTimerRef.current !== null) {
                        clearTimeout(labelImeResetTimerRef.current);
                        labelImeResetTimerRef.current = null;
                      }
                      labelImeComposingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      // WebKit 下确认候选的 Enter：compositionend 先于 keydown 且 isComposing
                      // 已为 false，延迟一个宏任务复位（issue #4/#12 同款修复）
                      labelImeResetTimerRef.current = window.setTimeout(() => {
                        labelImeComposingRef.current = false;
                        labelImeResetTimerRef.current = null;
                      }, 0);
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.nativeEvent.isComposing &&
                        e.keyCode !== 229 &&
                        !labelImeComposingRef.current
                      ) {
                        void createLink();
                      }
                      if (e.key === "Escape") setFormOpen(false);
                    }}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
                    取消
                  </Button>
                  <Button size="sm" onClick={() => void createLink()} disabled={creating}>
                    {creating ? "创建中…" : "创建链接"}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="mt-2.5 w-full"
                onClick={() => {
                  setNewRole("viewer");
                  setLabelDraft("");
                  setFormOpen(true);
                }}
              >
                <Plus />
                新建协作链接
              </Button>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 行内两步吊销确认：把「吊销」点一次换成「确认 / 取消」，避免误触不可恢复操作 */
function RevokeConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-[11px] text-red-400">立即失效，确定？</span>
      <button
        type="button"
        onClick={onConfirm}
        className="rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-red-700"
      >
        确认吊销
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
      >
        取消
      </button>
    </span>
  );
}
