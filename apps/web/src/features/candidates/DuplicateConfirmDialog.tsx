import { MapPin } from "lucide-react";
import type { PlaceDto } from "@yarnball/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

/**
 * 疑似重复确认框（M43）：人类创建候选收到 409（possible_duplicate）时弹出，
 * 展示已有卡片名称/地址供比对——「仍要创建」由父组件带 allowDuplicate=true 重发，
 * 「取消」放弃本次创建（已有地点保留原样）。
 */
export function DuplicateConfirmDialog({
  pendingName,
  existing,
  busy,
  onConfirm,
  onCancel,
}: {
  /** 本次想创建的地点名 */
  pendingName: string;
  /** 服务端判重命中的已有地点 */
  existing: PlaceDto;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>疑似重复地点</DialogTitle>
          <DialogDescription>
            候选池里已有名称相近且位置很近（≤200m）的地点。确认「{pendingName}」是另一个地点再创建。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-card border border-slate-900/10 bg-white/60 p-3 shadow-card">
          <p className="truncate text-sm font-medium text-slate-900" title={existing.name}>
            {existing.name}
          </p>
          {(existing.address || existing.cityName) && (
            <p
              className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-slate-400"
              title={[existing.address, existing.cityName].filter(Boolean).join(" · ")}
            >
              <MapPin className="size-3 shrink-0" />
              {[existing.address, existing.cityName].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <DialogFooter>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-slate-300/60 bg-white/60 px-3 py-1.5 text-sm text-slate-600 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-slate-800/90 px-3 py-1.5 text-sm text-white shadow disabled:opacity-50"
          >
            {busy ? "创建中…" : "仍要创建"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
