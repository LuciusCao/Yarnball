import { useState } from "react";
import { Info, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  TRIP_NOTE_CATEGORIES,
  TRIP_NOTE_CATEGORY_LABELS,
  type TripBundle,
  type TripNoteCategory,
  type TripNoteDto,
} from "@yarnball/shared";
import { api as libApi } from "../../lib/api";

/**
 * 行程级注意事项面板（M102，issue #11）：按 7 类（通讯/气候/用电/签证/货币/交通/其他）
 * 结构化展示 bundle.notes，支持增删改。数据随 bundle 全量下发（SSE 刷新），
 * 写操作后靠 SSE + 主动 load 兜底（onDataChanged）。
 * agent 侧（add/update/remove_trip_note）与用户编辑同写一张 trip_notes 表，互不覆盖。
 */
export function TripNotesPanel({
  tripId,
  bundle,
  onDataChanged,
  readOnly = false,
}: {
  tripId: string;
  bundle: TripBundle;
  onDataChanged: () => void;
  readOnly?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  /** 新增表单：分类 + 内容 */
  const [newCategory, setNewCategory] = useState<TripNoteCategory>("other");
  const [newContent, setNewContent] = useState("");

  /** 分类 → 注意事项（同类内按 position 再按创建时间，与服务端排序口径一致） */
  const byCategory = new Map<TripNoteCategory, TripNoteDto[]>();
  for (const note of [...bundle.notes].sort(
    (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
  )) {
    const list = byCategory.get(note.category) ?? [];
    list.push(note);
    byCategory.set(note.category, list);
  }
  /** 有内容的分类（按 TRIP_NOTE_CATEGORIES 固定顺序展示） */
  const usedCategories = TRIP_NOTE_CATEGORIES.filter((c) => (byCategory.get(c)?.length ?? 0) > 0);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onDataChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    const content = newContent.trim();
    if (!content) return;
    await run(async () => {
      await libApi.createTripNote(tripId, { category: newCategory, content });
      setNewContent("");
    });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <p className="mb-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-400">
        <Info className="mt-0.5 size-3 shrink-0" />
        目的地出行注意事项，agent 会按目的地/日期预填，也可以手动补充；导出 PDF 时随行程一并输出。
      </p>

      {usedCategories.length === 0 && (
        <p className="py-6 text-center text-xs text-slate-400">
          还没有注意事项。让 agent 按目的地预填，或在下方手动添加。
        </p>
      )}

      {usedCategories.map((category) => (
        <section key={category} className="mb-3">
          <h3 className="mb-1 text-xs font-semibold text-slate-600">
            {TRIP_NOTE_CATEGORY_LABELS[category]}
          </h3>
          <ul className="space-y-1">
            {byCategory.get(category)!.map((note) => (
              <NoteRow
                key={`${note.id}:${note.content}`}
                note={note}
                readOnly={readOnly}
                busy={busy}
                onSave={(content) => run(() => libApi.updateTripNote(note.id, { content }))}
                onRemove={() => run(() => libApi.removeTripNote(note.id))}
              />
            ))}
          </ul>
        </section>
      ))}

      {!readOnly && (
        <div className="mt-auto flex items-center gap-1.5 border-t border-slate-900/8 pt-2.5">
          <select
            value={newCategory}
            disabled={busy}
            onChange={(e) => setNewCategory(e.target.value as TripNoteCategory)}
            className="shrink-0 rounded-lg border border-slate-300/60 bg-white/70 px-1.5 py-1 text-xs text-slate-600 outline-none disabled:opacity-50"
          >
            {TRIP_NOTE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {TRIP_NOTE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <input
            value={newContent}
            disabled={busy}
            maxLength={2000}
            placeholder="添加一条注意事项…"
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => {
              // IME 组合输入中的 Enter 是确认候选，不触发提交（issue #4/#12 同款守卫）
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void addNote();
            }}
            className="min-w-0 flex-1 rounded-lg border border-slate-300/60 bg-white/70 px-2 py-1 text-xs text-slate-700 outline-none focus:border-blue-400 disabled:opacity-50"
          />
          <button
            onClick={() => void addNote()}
            disabled={busy || newContent.trim() === ""}
            title="添加注意事项"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-900/8 text-slate-600 transition-colors hover:bg-slate-900/15 disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** 单条注意事项：点击文本行内编辑（失焦/Enter 提交，Esc 取消），hover 出删除钮 */
function NoteRow({
  note,
  readOnly,
  busy,
  onSave,
  onRemove,
}: {
  note: TripNoteDto;
  readOnly: boolean;
  busy: boolean;
  onSave: (content: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next === "" || next === note.content) return;
    void onSave(next);
  }

  if (editing) {
    return (
      <li>
        <input
          autoFocus
          value={draft}
          disabled={busy}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-full rounded-lg border border-slate-300/60 bg-white/80 px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-blue-400 disabled:opacity-50"
        />
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-1 rounded-lg bg-slate-900/4 px-2 py-1.5">
      <span
        className={`min-w-0 flex-1 text-[11px] leading-relaxed text-slate-600 ${readOnly ? "" : "cursor-text"}`}
        title={readOnly ? undefined : "点击编辑"}
        onClick={readOnly ? undefined : () => setEditing(true)}
      >
        {note.content}
      </span>
      {!readOnly && (
        <button
          title="删除这条注意事项"
          disabled={busy}
          onClick={() => void onRemove()}
          className="hidden shrink-0 rounded p-0.5 text-slate-300 hover:bg-red-100/80 hover:text-red-500 group-hover:block disabled:opacity-40"
        >
          <Trash2 className="size-3" />
        </button>
      )}
    </li>
  );
}
