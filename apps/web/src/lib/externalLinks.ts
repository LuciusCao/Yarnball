/**
 * 壳内外链统一出口（issue #15）：Tauri WebView 里点击外部链接是坏的——
 * target=_blank 的新窗口请求被 wry 直接忽略（未注册 new-window handler 时返回 nil，死点击），
 * 无 target 的链接（聊天区 markdown 等）则会把整个 WebView 导航走。
 * 这里在 document 捕获层统一拦截：绝对 http(s) 链接且非应用自身 origin → 交系统默认浏览器。
 *
 * 实现口径与 tauriPdf.ts 的 dialog 一致：按插件命令契约原始 invoke（plugin:opener|open_url），
 * 不引入 @tauri-apps/plugin-opener 的 JS 包。opener 的默认权限集允许 http/https/mailto/tel，
 * capability 已在带 remote.urls 段的 default.json 放行（壳内生产态是 remote 来源，M104 教训）。
 * 浏览器 / vite dev 环境不装拦截，保持原生行为。
 */

const OPENER_COMMAND = "plugin:opener|open_url";

/** 是否需要壳内拦截（注入了 __TAURI_INTERNALS__ 才是 Tauri 壳） */
function shouldInstall(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 动态 import，避免浏览器环境打包进 @tauri-apps/api（虽然 tree-shaking 通常能处理，显式更稳） */
async function openInSystemBrowser(url: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(OPENER_COMMAND, { url });
}

/** 应用自身 origin 之外的绝对 http(s) 链接才外抛（站内路由、锚点、相对链接不动） */
function isExternalHttpLink(a: HTMLAnchorElement): boolean {
  const href = a.getAttribute("href");
  if (!href) return false;
  const url = new URL(href, window.location.href);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin !== window.location.origin;
}

/** 安装 document 捕获层点击拦截。幂等（重复调用只装一次）。 */
export function installExternalLinkHandler(): void {
  if (!shouldInstall()) return;
  if (document.__yarnballExternalLinksInstalled) return;
  document.__yarnballExternalLinksInstalled = true;

  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (!isExternalHttpLink(target)) return;
      e.preventDefault();
      const url = new URL(target.getAttribute("href")!, window.location.href).toString();
      openInSystemBrowser(url).catch((err) => {
        console.error("[yarnball] 打开外部链接失败：", err);
      });
    },
    true,
  );
}

// 给 document 挂安装标记的副作用类型声明（模块私有约定，不进 @types）
declare global {
  interface Document {
    __yarnballExternalLinksInstalled?: boolean;
  }
}
