import { create } from "zustand";
import type { AccessLinkRole } from "@yarnball/shared";

/**
 * 同伴身份（guest principal）存储，issue #18。
 *
 * 选型说明：zustand + 手动 localStorage 同步（不用 persist 中间件）——
 * - fetch 封装层（lib/http.ts）在 React 外同步取凭证注入 Bearer，zustand 的 getState()
 *   恰好提供「组件外同步读 + 组件内响应式订阅」两种消费形态；
 * - persist 中间件的补水时机在 React 渲染周期内，模块初始化阶段（首个请求可能先于首帧）
 *   读不到数据；手动同步读写让凭证在模块加载时即确定，语义最简单。
 *
 * 数据形态：按 token 关联的凭证列表（最多 MAX_RECENT 条，新的在前，超出淘汰最旧），
 * 支持多链接切换——同一浏览器先加入行程 A 再加入行程 B，两边凭证都在，
 * TripPage 按 tripId 重新激活对应凭证即可；登出按行程清除。
 * localStorage 不可用（隐私模式等）时退化为会话内存，功能不中断（刷新后需重新走 /join）。
 */

/** guest 凭证：链接即身份（token 就是 access-link token，与 Bearer/SSE ?token= 同源） */
export interface GuestCredential {
  /** access-link token（Bearer / SSE ?token= / join URL 三处同值） */
  token: string;
  /** 绑定的行程 id（TripPage 按 tripId 找凭证、进入正确行程） */
  tripId: string;
  /** viewer=只读 / editor=可编辑 */
  role: AccessLinkRole;
  /** 同伴填的昵称（展示与身份感，无鉴权语义） */
  displayName: string;
}

const STORAGE_KEY = "yarnball:guest-credentials";
/** 保留的最近凭证条数上限（每条几十字节，防多链接长年累积） */
const MAX_RECENT = 8;

function isCredential(value: unknown): value is GuestCredential {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.token === "string" && typeof v.tripId === "string" && typeof v.role === "string" &&
    (v.role === "viewer" || v.role === "editor") && typeof v.displayName === "string";
}

/** 读全部已存凭证（新的在前）；解析失败/无存储返回空列表 */
function loadStored(): GuestCredential[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCredential);
  } catch {
    return [];
  }
}

function saveStored(list: GuestCredential[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // 持久化失败不影响会话内使用
  }
}

interface PrincipalStore {
  /**
   * 当前生效的 guest 凭证：仅 guest 上下文页面（JoinPage 激活后 / TripPage 按 tripId
   * 重新激活）非空；API 层据此注入 Bearer。null = 不注入（本机 owner 形态零变化）。
   * 刻意不持久化——直接刷新 /trip/:id 时由 TripPage 挂载时按 tripId 从存储恢复。
   */
  active: GuestCredential | null;
  /** 已存凭证（新的在前；镜像 localStorage，组件渲染用） */
  saved: GuestCredential[];
  /** 激活凭证：写存储（提到最前）+ 设为生效 */
  activate: (credential: GuestCredential) => void;
  /** 取消生效（不删存储）：TripPage 卸载时调用，离开 guest 上下文即停止注入 Bearer */
  deactivate: () => void;
  /** 退出某行程的同伴身份：删该行程的存储凭证；若正是生效凭证则同时取消生效 */
  exitTrip: (tripId: string) => void;
}

export const usePrincipalStore = create<PrincipalStore>((set, get) => ({
  active: null,
  saved: loadStored(),

  activate: (credential) => {
    const next = [credential, ...get().saved.filter((c) => c.token !== credential.token)];
    saveStored(next);
    set({ saved: next, active: credential });
  },

  deactivate: () => set({ active: null }),

  exitTrip: (tripId) => {
    const next = get().saved.filter((c) => c.tripId !== tripId);
    saveStored(next);
    set({
      saved: next,
      active: get().active?.tripId === tripId ? null : get().active,
    });
  },
}));

/** 按 token 取已存凭证（JoinPage「已激活过」识别与昵称预填） */
export function credentialByToken(token: string): GuestCredential | null {
  return usePrincipalStore.getState().saved.find((c) => c.token === token) ?? null;
}

/** 按 tripId 取已存凭证（TripPage 挂载时恢复 guest 身份；owner 无凭证返回 null） */
export function credentialByTripId(tripId: string): GuestCredential | null {
  return usePrincipalStore.getState().saved.find((c) => c.tripId === tripId) ?? null;
}

// ---------- 远程主人身份（issue #32） ----------
//
// owner token 的浏览器侧形态：独立于 guest 凭证（单条、全局生效、无行程绑定）。
// 生效后 apiFetch 注入 Bearer，服务端 resolvePrincipal 识别为 owner——全套 owner
// UI（agent 面板/设置/分享管理）在远程设备可用。本机 loopback 本就是 owner，
// 同一台机器存了 owner 凭证也无害（Bearer owner token = 同一身份）。

const OWNER_STORAGE_KEY = "yarnball:owner-credential";

function loadOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveOwner(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(OWNER_STORAGE_KEY);
    else localStorage.setItem(OWNER_STORAGE_KEY, token);
  } catch {
    // 持久化失败不影响会话内使用
  }
}

interface OwnerAuth {
  /** 生效中的 owner token（远程主人形态）；null = 未登录（本机 owner 形态不受影响） */
  token: string | null;
  /** 登录（/login 页 verify 通过后调用）：存 localStorage + 设为生效 */
  signIn: (token: string) => void;
  /** 退出远程主人身份（设置页入口）：清存储与生效态 */
  signOut: () => void;
}

export const useOwnerAuth = create<OwnerAuth>((set, get) => ({
  token: loadOwner(),

  signIn: (token) => {
    saveOwner(token);
    set({ token });
  },

  signOut: () => {
    saveOwner(null);
    set({ token: null });
  },
}));

/** React 外同步读（apiFetch 注入用）：生效中的 owner token */
export function currentOwnerToken(): string | null {
  return useOwnerAuth.getState().token;
}
