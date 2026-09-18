import { usePrincipalStore, type GuestCredential } from "./principal";

/**
 * 功能开关单点推导（issue #20：同伴视角功能边界）。
 *
 * 形状对齐服务端权限矩阵（services/auth.ts 的三个 guard）——前端门控是体验，
 * 后端硬拒才是边界，两端口径必须一致：
 *   canEditTrip     ↔ tripWriteGuard（owner / 本行程 editor）
 *   读能力           ↔ tripReadGuard（viewer+editor 都有，不单列开关：查看类对三种身份全开）
 *   其余 owner 专属  ↔ requireOwner（agent 面板 / 设置 / 分享管理 / 删行程 / 导出）
 *
 * 消费约定：组件只消费本 hook 的布尔值，不各自判断 guest/role（推导单点，
 * 同 stops.ts 的 day→stop 推导惯例）；owner（active=null，loopback/Tauri 壳）
 * 全部能力为 true，本地体验零变化。
 */

/** 功能开关集合：全部只读布尔，由 deriveCapabilities 纯函数推导 */
export interface Capabilities {
  /** 可编辑行程数据（地点/日程/候选/须知/预算/标题/出发日期/城市重定位）：owner 或 editor 同伴 */
  canEditTrip: boolean;
  /** 只读视角（viewer 同伴）：编辑类入口全部隐藏，页面不出现「点了报错」的死按钮 */
  canViewOnly: boolean;
  /** agent 面板（会话创建/对话/权限停靠）：owner 专属——agent 子进程 spawn 在 owner 机器（RCE 面） */
  canUseAgent: boolean;
  /** 分享与协作管理（链接创建/备注/吊销，面板含 token 明文）：owner 专属 */
  canManageShare: boolean;
  /** 全局设置（高德密钥 / agent CLI 注册）：owner 专属 */
  canEditSettings: boolean;
  /** 删除行程：owner 专属（入口在行程列表页，guest 本就不可达，开关保持矩阵口径完整） */
  canDeleteTrip: boolean;
  /** 导出行程 PDF：owner 侧入口（Tauri 壳原生直存 / owner 浏览器打印） */
  canExport: boolean;
}

/** 推导单点：guest=null 即 owner 形态（本机 loopback / Tauri 壳 / owner token），全部能力开 */
export function deriveCapabilities(guest: GuestCredential | null): Capabilities {
  if (guest == null) {
    return {
      canEditTrip: true,
      canViewOnly: false,
      canUseAgent: true,
      canManageShare: true,
      canEditSettings: true,
      canDeleteTrip: true,
      canExport: true,
    };
  }
  // 同伴（access-link 凭证）：编辑能力按角色，owner 专属能力一律关
  const editor = guest.role === "editor";
  return {
    canEditTrip: editor,
    canViewOnly: !editor,
    canUseAgent: false,
    canManageShare: false,
    canEditSettings: false,
    canDeleteTrip: false,
    canExport: false,
  };
}

/**
 * 组件消费口：订阅 principal store 的生效凭证并推导。
 * 凭证只在 TripPage/JoinPage 的 guest 上下文激活（见 principal.ts），
 * 其余页面 active 恒为 null（owner 形态）——hook 可在任意组件安全使用。
 */
export function useCapabilities(): Capabilities {
  const guest = usePrincipalStore((s) => s.active);
  return deriveCapabilities(guest);
}
