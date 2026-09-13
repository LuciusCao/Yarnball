import { useState } from "react";
import type { DayDto } from "@yarnball/shared";
import { useImeEnterGuard } from "../../lib/ime";

/**
 * 每日概要行（M102，issue #9）：天卡片顶部展示 day.summary；
 * summaryAuto=true（服务端兜底生成，非人工撰写）时附「自动」标记。
 * 非只读点击文本进入行内编辑：保存走 PATCH /api/days/:dayId/summary；
 * 清空保存 = 传 null 恢复自动兜底。失焦/Enter 提交，Esc 取消（Enter 带 IME 三重守卫，lib/ime）。
 */
export function DaySummaryRow({
  day,
  readOnly,
  busy,
  onSave,
}: {
  day: DayDto;
  readOnly: boolean;
  busy: boolean;
  onSave: (summary: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ime = useImeEnterGuard();

  function startEdit() {
    // 自动兜底值不作为草稿初值（否则用户容易把兜底文本固化成撰写值）；草稿留空，placeholder 展示当前兜底
    setDraft(day.summaryAuto ? "" : (day.summary ?? ""));
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const next = draft.trim();
    const current = day.summaryAuto ? "" : (day.summary ?? "");
    if (next === current) return;
    void onSave(next === "" ? null : next);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        disabled={busy}
        maxLength={500}
        placeholder={day.summaryAuto ? (day.summary ?? "一句话概括今天（留空恢复自动生成）") : "一句话概括今天（留空恢复自动生成）"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        {...ime.compositionProps}
        onKeyDown={(e) => {
          // IME 组合输入中按 Enter 是确认候选，不触发提交（issue #4 同款三重守卫，lib/ime）
          if (e.key === "Enter" && !ime.isComposingEnter(e)) e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
        className="mb-1.5 w-full rounded-lg border border-slate-300/60 bg-white/80 px-2 py-1 text-[11px] text-slate-600 outline-none focus:border-blue-400 disabled:opacity-50"
      />
    );
  }

  if (day.summary) {
    return (
      <p
        className={`mb-1.5 text-[11px] leading-relaxed text-slate-500 ${readOnly ? "" : "cursor-text rounded px-1 -mx-1 hover:bg-slate-900/5"}`}
        title={readOnly ? undefined : "点击编辑每日概要（清空后恢复自动生成）"}
        onClick={readOnly ? undefined : startEdit}
      >
        {day.summary}
        {day.summaryAuto && !readOnly && (
          <span className="ml-1 rounded bg-slate-900/8 px-1 text-[10px] text-slate-400">自动</span>
        )}
      </p>
    );
  }

  // 无概要（当天无安排，服务端兜底也给不出）：非只读给一个低调入口
  if (!readOnly) {
    return (
      <button
        onClick={startEdit}
        className="mb-1.5 text-[11px] text-slate-300 hover:text-slate-500"
      >
        + 写一句今日概要
      </button>
    );
  }
  return null;
}
