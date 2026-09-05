import { useState } from "react";
import {
  BedDouble,
  Landmark,
  Lock,
  LockOpen,
  Package,
  Sparkles,
  Trash2,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { formatMoney, type PlaceCategory, type PlaceDto, type TripBundle } from "@yarnball/shared";
import { api } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { candidatesApi } from "./api";
import { getPlaceStatus } from "./placeStatus";

/**
 * 候选池面板 —— 所有「未排期」地点的大本营（整合原 HotelPanel 的候选管理 + DiningPanel 的清单）。
 * 按 酒店/景点/美食/其他 分组；每项可锁定（=确认要去，锁定后才排日程）、删除；
 * 酒店组保留「选定酒店」语义（trips.selectedHotelCandidateId 逻辑不变）。
 * 数据刷新：操作后走 SSE bundle 全量快照 + 主动 load 兜底，不做本地增量。
 */

interface CandidatesPanelProps {
  tripId: string;
  bundle: TripBundle;
  /** 推荐住宿区域（TripPage 已为地图拉取，这里复用展示提示） */
  hotelArea: { center: { lng: number; lat: number }; radiusM: number } | null;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
  onDataChanged: () => void;
}

type GroupKey = "hotel" | "attraction" | "dining" | "other";

const GROUP_META: Record<GroupKey, { label: string; Icon: LucideIcon; categories: PlaceCategory[] }> = {
  hotel: { label: "酒店", Icon: BedDouble, categories: ["hotel"] },
  attraction: { label: "景点", Icon: Landmark, categories: ["attraction", "activity"] },
  dining: { label: "美食", Icon: UtensilsCrossed, categories: ["restaurant"] },
  other: { label: "其他", Icon: Package, categories: ["other"] },
};

const GROUP_ORDER: GroupKey[] = ["hotel", "attraction", "dining", "other"];

export function CandidatesPanel({
  tripId,
  bundle,
  hotelArea,
  selectedPlaceId,
  onSelectPlace,
  onDataChanged,
}: CandidatesPanelProps) {
  const [busy, setBusy] = useState(false);
  const cur = bundle.trip.currency;
  const scheduledPlaceIds = new Set(bundle.entries.map((e) => e.placeId));

  /** 未排期地点按组归桶（酒店走 hotelCandidates 以拿到候选 id 与每晚价） */
  const grouped: Record<GroupKey, PlaceDto[]> = { hotel: [], attraction: [], dining: [], other: [] };
  for (const place of bundle.places) {
    if (scheduledPlaceIds.has(place.id)) continue;
    for (const key of GROUP_ORDER) {
      if (GROUP_META[key].categories.includes(place.category)) {
        grouped[key].push(place);
        break;
      }
    }
  }
  const hotelCandByPlaceId = new Map(bundle.hotelCandidates.map((h) => [h.placeId, h]));

  async function toggleLock(place: PlaceDto) {
    const next = getPlaceStatus(place) === "locked" ? "candidate" : "locked";
    setBusy(true);
    try {
      await candidatesApi.setPlaceStatus(place.id, next);
      onDataChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(place: PlaceDto) {
    if (!confirm(`删除「${place.name}」？已排入的日程也会一并移除。`)) return;
    setBusy(true);
    try {
      await candidatesApi.deletePlace(place.id);
      toast.success(`已删除「${place.name}」`);
      onDataChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function selectHotel(candidateId: string | null) {
    await api.selectHotel(tripId, candidateId).catch((err) => toast.error((err as Error).message));
    onDataChanged();
  }

  const totalCount = GROUP_ORDER.reduce((n, key) => n + grouped[key].length, 0);

  return (
    <div className="h-full overflow-y-auto p-3">
      {totalCount === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white/40 py-8 text-center">
          <p className="text-xs text-slate-400">
            候选池是空的。把攻略粘给 agent，它会把想去的地点先放进这里，
            <br />
            你锁定后再让它排进日程。
          </p>
        </div>
      )}

      {GROUP_ORDER.map((key) => {
        const { label, Icon } = GROUP_META[key];
        const places = grouped[key];
        if (key !== "hotel" && places.length === 0) return null;

        // 预算小计：酒店按每晚价合计（候选互为备选，仅供参考），其余按单价合计
        const subtotal = places.reduce((sum, p) => {
          if (key === "hotel") return sum + (hotelCandByPlaceId.get(p.id)?.pricePerNight ?? p.priceCny ?? 0);
          return sum + (p.priceCny ?? 0);
        }, 0);

        return (
          <section key={key} className="mb-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <Icon className="size-4 text-slate-400" /> {label}
              <span className="text-xs font-normal text-slate-400">{places.length} 个</span>
              {subtotal > 0 && (
                <span className="ml-auto text-xs font-medium text-orange-600">
                  小计 {formatMoney(subtotal, cur)}
                  {key === "hotel" ? "/晚" : ""}
                </span>
              )}
            </h3>

            {key === "hotel" && hotelArea && (
              <div className="mb-2 rounded-lg border border-red-200/60 bg-red-100/50 px-3 py-2 text-xs text-slate-600">
                建议住宿区域：行程地点中位数中心附近（半径 {Math.round(hotelArea.radiusM / 1000)} 公里，
                地图上红圈所示）。把这条发给 agent：
                <button
                  className="ml-1 text-blue-600 underline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(
                      `帮我在住宿推荐区域（中心坐标 ${hotelArea.center.lng},${hotelArea.center.lat} 附近）搜索合适的酒店，加入 2-3 个候选`,
                    );
                  }}
                >
                  复制提示词
                </button>
              </div>
            )}

            {key === "hotel" && places.length === 0 && (
              <p className="rounded-xl border border-dashed border-slate-300 bg-white/40 py-4 text-center text-xs text-slate-400">
                还没有酒店候选。把携程的酒店列表粘给 agent，或点上面「复制提示词」。
              </p>
            )}

            <div className="space-y-2">
              {places.map((place) => {
                const status = getPlaceStatus(place);
                const locked = status === "locked";
                const hotelCand = hotelCandByPlaceId.get(place.id);
                const isSelectedHotel =
                  hotelCand != null && bundle.trip.selectedHotelCandidateId === hotelCand.id;
                const price =
                  key === "hotel"
                    ? (hotelCand?.pricePerNight ?? place.priceCny)
                    : place.priceCny;
                const selected = place.id === selectedPlaceId;

                return (
                  <div
                    key={place.id}
                    onClick={() => onSelectPlace(place.id)}
                    className={`cursor-pointer rounded-xl border p-3 shadow-sm transition-colors ${
                      selected
                        ? "border-blue-300 bg-blue-50/60 ring-1 ring-blue-200"
                        : isSelectedHotel
                          ? "border-red-300 bg-red-100/40 ring-1 ring-red-200"
                          : locked
                            ? "border-amber-300/70 bg-amber-50/50"
                            : "border-slate-900/10 bg-white/60"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-medium text-slate-900">{place.name}</p>
                          {place.createdBy === "agent" && (
                            <Badge variant="blue" className="shrink-0">
                              <Sparkles className="size-3" />
                              agent 推荐
                            </Badge>
                          )}
                          {locked && (
                            <Badge variant="orange" className="shrink-0">
                              已锁定
                            </Badge>
                          )}
                        </div>
                        <p className="truncate text-[11px] text-slate-400">{place.address ?? ""}</p>
                        {price != null && (
                          <p className="mt-1 text-sm font-semibold text-orange-600">
                            {formatMoney(price, cur)}
                            {key === "hotel" ? " /晚" : place.category === "restaurant" ? " /人" : ""}
                          </p>
                        )}
                        {hotelCand?.notes && (
                          <p className="mt-1 text-xs text-slate-500">{hotelCand.notes}</p>
                        )}
                        {place.sourceUrl && (
                          <a
                            href={place.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1 inline-block text-xs text-blue-500 underline"
                          >
                            来源链接
                          </a>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        {hotelCand && (
                          <button
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void selectHotel(isSelectedHotel ? null : hotelCand.id);
                            }}
                            className={`rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                              isSelectedHotel
                                ? "bg-red-600 text-white"
                                : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                            }`}
                          >
                            {isSelectedHotel ? "✓ 已选定" : "选定"}
                          </button>
                        )}
                        <div className="flex gap-1">
                          <button
                            title={locked ? "解锁（退回候选）" : "锁定（确认要去）"}
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void toggleLock(place);
                            }}
                            className={`flex size-7 items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${
                              locked
                                ? "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25"
                                : "text-slate-400 hover:bg-slate-900/8 hover:text-amber-600"
                            }`}
                          >
                            {locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                          </button>
                          <button
                            title="删除"
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void remove(place);
                            }}
                            className="flex size-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-100/80 hover:text-red-500 disabled:opacity-50"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
