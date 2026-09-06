import { useState } from "react";
import {
  BedDouble,
  CalendarCheck,
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
  BOOKING_STATUS_META,
  bookingStatusOf,
  nextBookingStatus,
  openingHoursOf,
} from "./booking";
import {
  getSelectedStays,
  largestFreeSpan,
  type HotelStayRange,
} from "./hotelStays";

/**
 * 候选池面板 —— 所有「未排期」地点的大本营（整合原 HotelPanel 的候选管理 + DiningPanel 的清单）。
 * 按 酒店/景点/美食/其他 分组；每项可加入行程（=确认要去，加入后才排日程）、删除；
 * 酒店组支持加入多家酒店（M10 多酒店）：每家已加入酒店带 入住第N天/离店第M天 选择器，
 * 区间互相冲突的选项禁用并提示（服务端同样校验，见 M9 契约）。
 * 预订状态（M11）：每项显示 无需预订/待预订/已预订 徽章，locked 地点可点选流转；
 * 待预订的已加入地点卡片高亮并在顶部汇总提醒。营业时间（openingHours）有值即展示。
 * M20：UI 话术统一为「加入行程」——酒店「加入行程」即选定住宿区间（select，含入离店天），
 * 底层 locked/select 语义不变；酒店的 locked 状态在 UI 上降级（不再出现「已锁定·未选定住宿天」）。
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

  /** 预订状态点选流转（M11：PATCH /api/places/:id 带 bookingStatus）：无需预订 → 待预订 → 已预订 → 无需预订；仅 locked 地点可操作 */
  async function cycleBooking(place: PlaceDto) {
    setBusy(true);
    try {
      await uxApi.updatePlace(place.id, { bookingStatus: nextBookingStatus(bookingStatusOf(place)) });
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

  /** 加入酒店：默认占未被覆盖的最长连续段；全程已覆盖则提示先调整已有酒店 */
  async function selectHotel(candidateId: string) {
    if (totalDays === 0) {
      toast.warning("还没有行程天数，先让 agent 规划行程再加入酒店");
      return;
    }
    const span = largestFreeSpan(hotelStays, totalDays);
    if (!span) {
      toast.warning("全程已被其他已加入的酒店覆盖，请先调整它们的入离店天");
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

  /** 修改已加入酒店的入离店天（重选即改期）；区间冲突由选择器禁用兜底，服务端拒绝时 toast */
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
  /** 待预订的已加入地点（M11，底层仍是 locked 状态）：顶部汇总提醒 + 卡片高亮 */
  const pendingLockedCount = bundle.places.filter(
    (p) => p.status === "locked" && bookingStatusOf(p) === "pending",
  ).length;

  return (
    <div className="h-full overflow-y-auto p-3">
      {pendingLockedCount > 0 && (
        <div className="mb-3 flex items-center gap-1.5 rounded-xl border border-orange-300/70 bg-orange-100/60 px-3 py-2 text-xs text-orange-700">
          <CalendarCheck className="size-3.5 shrink-0" />
          有 {pendingLockedCount} 个已加入行程的地点待预订，出行前记得完成预订（点徽章可标记已预订）。
        </div>
      )}
      {totalCount === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white/40 py-8 text-center">
          <p className="text-xs text-slate-400">
            候选池是空的。把攻略粘给 agent，它会把想去的地点先放进这里，
            <br />
            你加入行程后再让它排进日程。
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
                const booking = bookingStatusOf(place);
                const pendingLocked = locked && booking === "pending";
                const openingHours = openingHoursOf(place);
                const hotelCand = hotelCandByPlaceId.get(place.id);
                const stay = hotelCand ? stayByCandidateId.get(hotelCand.id) : undefined;
                const isSelectedHotel = stay != null;
                /** 酒店候选（M20）：locked 状态在 UI 上降级——主按钮「加入行程」即含住宿区间，不再单独展示 locked 徽章与锁定开关 */
                const isHotel = key === "hotel" && hotelCand != null;
                const price =
                  key === "hotel"
                    ? (hotelCand?.pricePerNight ?? place.priceCny)
                    : place.priceCny;
                const selected = place.id === selectedPlaceId;

                // 是否有徽章要展示（没有就不渲染徽章行，避免多余间距）
                const showBadges = place.createdBy === "agent" || (locked && !isHotel) || booking !== "none";

                return (
                  <div
                    key={place.id}
                    onClick={() => onSelectPlace(place.id)}
                    className={`cursor-pointer rounded-card border p-3 shadow-card transition-colors ${
                      selected
                        ? "border-scheduled/40 bg-scheduled/8 ring-1 ring-scheduled/30"
                        : isSelectedHotel
                          ? "border-hotelpin/40 bg-hotelpin/8 ring-1 ring-hotelpin/30"
                          : pendingLocked
                            ? "border-orange-400 bg-orange-50/70 ring-1 ring-orange-300"
                            : locked
                              ? "border-locked/30 bg-locked/5"
                              : "border-slate-900/10 bg-white/60"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        {/* 第一行：名称 + 价格右置（价格是最常被扫视的决策信息） */}
                        <div className="flex items-baseline gap-2">
                          <p className="truncate text-sm font-medium text-slate-900">{place.name}</p>
                          {price != null && (
                            <span className="ml-auto shrink-0 text-sm font-semibold text-orange-600">
                              {formatMoney(price, cur)}
                              {key === "hotel" ? "/晚" : place.category === "restaurant" ? "/人" : ""}
                            </span>
                          )}
                        </div>
                        {/* 第二行：地址 · 营业时间 合并一行，truncate 兜底 */}
                        {(place.address || openingHours) && (
                          <p className="truncate text-[11px] text-slate-400">
                            {[place.address, openingHours].filter(Boolean).join(" · ")}
                          </p>
                        )}
                        {/* 徽章行（消费 M13 令牌变体）；预订状态徽章 locked 时可点选流转，候选态仅展示 */}
                        {showBadges && (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {place.createdBy === "agent" && (
                              <Badge variant="blue">
                                <Sparkles className="size-3" />
                                agent 推荐
                              </Badge>
                            )}
                            {locked && !isHotel && <Badge variant="locked">已加入</Badge>}
                            {locked ? (
                              <button
                                title="点击切换预订状态（无需预订 → 待预订 → 已预订）"
                                disabled={busy}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void cycleBooking(place);
                                }}
                                className="shrink-0 disabled:opacity-50"
                              >
                                <Badge
                                  variant={BOOKING_STATUS_META[booking].badgeVariant}
                                  className="cursor-pointer"
                                >
                                  <CalendarCheck className="size-3" />
                                  {BOOKING_STATUS_META[booking].label}
                                </Badge>
                              </button>
                            ) : (
                              booking !== "none" && (
                                <Badge variant={BOOKING_STATUS_META[booking].badgeVariant}>
                                  {BOOKING_STATUS_META[booking].label}
                                </Badge>
                              )
                            )}
                          </div>
                        )}
                        {hotelCand?.notes && (
                          <p className="mt-1 text-xs text-slate-500">{hotelCand.notes}</p>
                        )}
                        {isSelectedHotel && stay && (
                          // 已加入酒店的入离店天（M10 多酒店）；阻止冒泡避免触发卡片选中
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
                            title={
                              isSelectedHotel
                                ? "移出行程：取消该酒店的住宿区间，不再锚定每天首尾"
                                : "加入行程：自动分配未覆盖的最长连续住宿段，可再调整入离店天"
                            }
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void (isSelectedHotel
                                ? unselectHotel(hotelCand.id)
                                : selectHotel(hotelCand.id));
                            }}
                            className={`rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                              isSelectedHotel
                                ? "bg-hotelpin text-white"
                                : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                            }`}
                          >
                            {isSelectedHotel ? "✓ 已加入" : "加入行程"}
                          </button>
                        )}
                        <div className="flex gap-1">
                          {/* POI 的加入/移出开关（M20 话术）；酒店不走这里——主按钮「加入行程」已涵盖 */}
                          {!isHotel && (
                            <button
                              title={locked ? "移出行程（退回候选池，不再必排进日程）" : "加入行程（确认要去，排日程时必排）"}
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                void toggleLock(place);
                              }}
                              className={`flex size-7 items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${
                                locked
                                  ? "bg-locked/10 text-locked hover:bg-locked/20"
                                  : "text-slate-400 hover:bg-slate-900/8 hover:text-locked"
                              }`}
                            >
                              {locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                            </button>
                          )}
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
