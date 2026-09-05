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
import { api as uxApi } from "../../lib/api";
import { Badge } from "../../components/ui/badge";
import { candidatesApi } from "./api";
import { HotelStayRangePicker } from "./HotelStayRangePicker";
import {
  getSelectedStays,
  largestFreeSpan,
  type HotelStayRange,
} from "./hotelStays";

/**
 * 候选池面板 —— 所有「未排期」地点的大本营（整合原 HotelPanel 的候选管理 + DiningPanel 的清单）。
 * 按 酒店/景点/美食/其他 分组；每项可锁定（=确认要去，锁定后才排日程）、删除；
 * 酒店组支持选定多家酒店（M10 多酒店）：每家已选定酒店带 入住第N天/离店第M天 选择器，
 * 区间互相冲突的选项禁用并提示（服务端同样校验，见 M9 契约）。
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
  /** 多酒店（M10）：已选定住宿区间（含 legacy 单选定兜底），candidateId → stay */
  const hotelStays = getSelectedStays(bundle);
  const stayByCandidateId = new Map(hotelStays.map((s) => [s.candidateId, s]));
  const placeNameById = new Map(bundle.places.map((p) => [p.id, p.name]));
  const totalDays = bundle.days.length;

  async function toggleLock(place: PlaceDto) {
    const next = place.status === "locked" ? "candidate" : "locked";
    setBusy(true);
    try {
      await uxApi.setPlaceStatus(place.id, next);
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

  /** 选定酒店：默认占未被覆盖的最长连续段；全程已覆盖则提示先调整已有酒店 */
  async function selectHotel(candidateId: string) {
    if (totalDays === 0) {
      toast.warning("还没有行程天数，先让 agent 规划行程再选定酒店");
      return;
    }
    const span = largestFreeSpan(hotelStays, totalDays);
    if (!span) {
      toast.warning("全程已被其他选定酒店覆盖，请先调整它们的入离店天");
      return;
    }
    setBusy(true);
    try {
      await uxApi.selectHotel(tripId, { candidateId, ...span });
      onDataChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unselectHotel(candidateId: string) {
    setBusy(true);
    try {
      await uxApi.unselectHotel(tripId, candidateId);
      onDataChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 修改已选定酒店的入离店天（重选即改期）；区间冲突由选择器禁用兜底，服务端拒绝时 toast */
  async function updateStay(candidateId: string, range: HotelStayRange) {
    setBusy(true);
    try {
      await uxApi.selectHotel(tripId, { candidateId, ...range });
      onDataChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
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
                const locked = place.status === "locked";
                const hotelCand = hotelCandByPlaceId.get(place.id);
                const stay = hotelCand ? stayByCandidateId.get(hotelCand.id) : undefined;
                const isSelectedHotel = stay != null;
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
                        {isSelectedHotel && stay && (
                          // 已选定酒店的入离店天（M10 多酒店）；阻止冒泡避免触发卡片选中
                          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                            <HotelStayRangePicker
                              totalDays={totalDays}
                              checkInDay={stay.checkInDay}
                              checkOutDay={stay.checkOutDay}
                              otherStays={hotelStays
                                .filter((s) => s.candidateId !== stay.candidateId)
                                .map((s) => ({ ...s, label: placeNameById.get(s.placeId) }))}
                              disabled={busy}
                              onChange={(range) => void updateStay(stay.candidateId, range)}
                            />
                          </div>
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
                              void (isSelectedHotel
                                ? unselectHotel(hotelCand.id)
                                : selectHotel(hotelCand.id));
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
