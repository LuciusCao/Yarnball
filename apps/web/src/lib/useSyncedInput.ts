import { useEffect, useRef, useState } from "react";

/**
 * 外部值同步的受控输入草稿（issue #19 防冲突）。
 *
 * 问题：SSE bundle 是「服务端全量快照、前端整包替换」（AGENTS.md 钉死的模式），多人协作时
 * 任何同伴的写操作都会推新 bundle，父组件重渲染把外部值（external）灌回正在编辑的 input ——
 * 编辑中途被冲掉。单人时代就存在（自己写完等 SSE 回包时），多人场景被放大。
 *
 * 方案：受控草稿 + 焦点守卫——
 * - input 聚焦（正在编辑）或 IME 组合中：外部值变化被忽略（草稿保持用户的输入）；
 * - 失焦且未组合：外部值变化照常同步（后台刷新、别人改了别的字段都能对齐）；
 * - 进入编辑（focus）时以当时的外部值为初值，语义与「点击进入行内编辑」一致。
 * - 失焦补漏同步（Codex P2）：聚焦期间被跳过的外部值，在 blur 时补一次判定——
 *   若用户没有实际编辑（草稿 == 进入编辑时的初值），直接采纳最新外部值。否则（真正
 *   编辑过）保留草稿：这防止「没动过的字段在 blur 保存时把同伴刚写的值用过期草稿
 *   覆盖回去」的破坏性场景（transit 时刻输入是实例），同时不牺牲编辑中的意图。
 *
 * 这不是字段级合并（v1 边界明确不做 CRDT）：提交仍是 last-write-wins，只保证「编辑中的
 * 输入不被无关刷新冲掉」「没编辑的字段不被过期值覆盖」这两个最小体验目标。
 */
export function useSyncedInput(external: string) {
  const [draft, setDraft] = useState(external);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  /** 焦点态：focus/blur 由组件接线（onFocus/onBlur），不依赖 document.activeElement 轮询 */
  const focusedRef = useRef(false);
  /** IME 组合态：compositionstart/end 接线（组合中的同步会打断候选框，必须一并守卫） */
  const composingRef = useRef(false);
  /** 进入编辑（focus）时的草稿初值：blur 补漏判定「用户是否实际编辑过」的基准 */
  const focusBaselineRef = useRef<string | null>(null);
  /** 聚焦期间外部值是否变化过（跳过的同步需要在 blur 时补判定） */
  const externalChangedWhileFocusedRef = useRef(false);
  /** 最新外部值的镜像：blur 回调里同步读（避免闭包过期） */
  const externalRef = useRef(external);
  externalRef.current = external;

  useEffect(() => {
    if (focusedRef.current || composingRef.current) {
      // 焦点/组合中跳过外部同化——但记住发生过，blur 时补判定
      externalChangedWhileFocusedRef.current = true;
      return;
    }
    setDraft(external);
  }, [external]);

  return {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setDraft(e.target.value),
    onFocus: () => {
      focusedRef.current = true;
      focusBaselineRef.current = draft;
      externalChangedWhileFocusedRef.current = false;
    },
    onBlur: () => {
      focusedRef.current = false;
      // 补漏同步：聚焦期间外部值变过且用户没有实际编辑（草稿仍是进入时的初值）——
      // 采纳最新外部值，避免随后的 blur 保存把同伴的修改用过期草稿覆盖回去
      if (externalChangedWhileFocusedRef.current && focusBaselineRef.current === draft) {
        setDraft(externalRef.current);
      }
    },
    ref,
    /** IME 组合守卫（spread 到 input 上）：compositionstart 置位、compositionend 复位 */
    compositionGuard: {
      onCompositionStart: () => {
        composingRef.current = true;
      },
      onCompositionEnd: () => {
        // 延迟一个宏任务复位：WebKit 下确认候选的 Enter 事件先于组合态生效（issue #4 同根因）
        setTimeout(() => {
          composingRef.current = false;
        }, 0);
      },
    },
    /** 手动重置（提交/取消编辑后调用）：以最新外部值对齐草稿 */
    reset: (next?: string) => setDraft(next ?? external),
  };
}
