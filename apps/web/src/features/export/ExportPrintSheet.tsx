import type {
  EntryDto,
  PlaceCategory,
  PlaceDto,
  TransportLegDto,
  TransportMode,
  TripBundle,
} from "@yarnball/shared";
import {
  formatDayLabel,
  formatDistance,
  formatDuration,
  formatMoney,
  formatVisitDuration,
} from "@yarnball/shared";
import { buildDayTimeline, formatHHMM } from "../itinerary/timeline";
import {
  TRANSIT_KIND_META,
  TRANSIT_MODE_META,
  transitKindOf,
  transitRouteText,
} from "../itinerary/transit";
import { getSelectedStays, stayCoveringNight, stayNights, type HotelStay } from "../candidates/hotelStays";
import { BOOKING_STATUS_META, bookingStatusOf, openingHoursOf } from "../candidates/booking";
import { groupDaysByStop } from "../itinerary/stops";

/**
 * 行程打印稿（M97，issue #7）：纯展示组件，从 trip bundle 推导四个版块——
 * 行程概览（日期/天数/住宿）、每日时间轴、大交通、关键预订信息。
 * 数据来源与行程面板完全同源（bundle + itinerary/candidates 的推导层），不新造数据通道。
 */

/** 市内交通段方式文案（值与 ItineraryPanel 的 TransportIcon 口径一致） */
const LEG_MODE_LABEL: Record<TransportMode, string> = {
  walk: "步行",
  taxi: "打车/网约车",
  transit: "公交",
  drive: "驾车",
};

/** 地点类别文案（不含图标，打印用） */
const PLACE_CATEGORY_LABEL: Record<PlaceCategory, string> = {
  hotel: "酒店",
  restaurant: "美食",
  attraction: "景点",
  activity: "景点",
  other: "其他",
};

/** 住宿区间里某天的展示标签：有出发日期给「D2 · 9/24 周四」，否则「Day N」 */
function dayLabelOf(trip: TripBundle["trip"], dayIndex: number): string {
  return formatDayLabel(trip.startDate, dayIndex);
}

/** 酒店行：入住/退房日期（退房日为 checkOutDay - 1 的次日概念，闭开区间右端即退房当天） */
function HotelRows({ bundle, stays }: { bundle: TripBundle; stays: HotelStay[] }) {
  const placeById = new Map(bundle.places.map((p) => [p.id, p]));
  if (stays.length === 0) return <p className="ybe-empty">尚未加入住宿</p>;
  return (
    <table className="ybe-table">
      <thead>
        <tr>
          <th>酒店</th>
          <th>入住</th>
          <th>退房</th>
          <th>晚数</th>
          <th>地址 / 电话</th>
        </tr>
      </thead>
      <tbody>
        {stays.map((stay) => {
          const place = placeById.get(stay.placeId);
          return (
            <tr key={stay.candidateId}>
              <td>
                <span className="ybe-entry-name">{place?.name ?? "酒店"}</span>
                {place?.priceCny != null && (
                  <div className="ybe-meta">
                    {formatMoney(place.priceCny, bundle.trip.currency)} /晚
                  </div>
                )}
              </td>
              <td>{dayLabelOf(bundle.trip, stay.checkInDay)}</td>
              {/* 闭开区间 [checkInDay, checkOutDay)：checkOutDay 当天退房 */}
              <td>{dayLabelOf(bundle.trip, stay.checkOutDay)}</td>
              <td>{stayNights(stay)}</td>
              <td>
                {place?.address && <div>{place.address}</div>}
                {place?.phone && <div className="ybe-meta">☎ {place.phone}</div>}
                {!place?.address && !place?.phone && <span className="ybe-empty">—</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 一条日程 entry（地点或大交通节点） */
function EntryRow({
  entry,
  place,
  transit,
  startMin,
  endMin,
  estimated,
  placeById,
}: {
  entry: EntryDto;
  place: PlaceDto | null;
  transit: boolean;
  startMin: number;
  endMin: number;
  estimated: boolean;
  placeById: Map<string, PlaceDto>;
}) {
  const timeRange = `${formatHHMM(startMin)} – ${formatHHMM(endMin)}`;
  if (transit) {
    const mode = entry.transitMode ? TRANSIT_MODE_META[entry.transitMode].label : null;
    const route = transitRouteText(entry, placeById);
    return (
      <div className="ybe-entry">
        <div className="ybe-time">
          {estimated && <span className="ybe-est">~</span>}
          {timeRange}
        </div>
        <div className="ybe-entry-body">
          <span className="ybe-entry-name">{route ?? "大交通"}</span>
          {mode && <span className="ybe-tag ybe-tag-transit">{mode}</span>}
          {entry.note && <div className="ybe-note">{entry.note}</div>}
        </div>
      </div>
    );
  }
  if (!place) return null;
  const opening = openingHoursOf(place);
  const visit = formatVisitDuration(place.visitDurationMin ?? place.durationMin);
  return (
    <div className="ybe-entry">
      <div className="ybe-time">
        {estimated && <span className="ybe-est">~</span>}
        {timeRange}
      </div>
      <div className="ybe-entry-body">
        <span className="ybe-entry-name">{place.name}</span>
        <span className="ybe-tag">{PLACE_CATEGORY_LABEL[place.category]}</span>
        {visit && <span className="ybe-tag">{visit}</span>}
        {place.address && <div className="ybe-meta">📍 {place.address}</div>}
        {opening && <div className="ybe-meta">🕒 {opening}</div>}
        {place.phone && <div className="ybe-meta">☎ {place.phone}</div>}
        {entry.note && <div className="ybe-note">{entry.note}</div>}
        {place.notes && <div className="ybe-note">{place.notes}</div>}
      </div>
    </div>
  );
}

/** entry 之间的市内交通段一行 */
function LegRow({ leg }: { leg: TransportLegDto }) {
  const parts = [
    LEG_MODE_LABEL[leg.mode],
    leg.durationS != null ? formatDuration(leg.durationS) : "",
    leg.distanceM != null ? formatDistance(leg.distanceM) : "",
  ].filter(Boolean);
  return <div className="ybe-leg">→ {parts.join(" · ")}</div>;
}

export function ExportPrintSheet({ bundle }: { bundle: TripBundle }) {
  const { trip } = bundle;
  const placeById = new Map(bundle.places.map((p) => [p.id, p]));
  const sortedDays = [...bundle.days].sort((a, b) => a.dayIndex - b.dayIndex);
  const stays = getSelectedStays(bundle);
  /** 多城市行程按途经地分组（连续同 stop 并组）；单城市为 null 不分组 */
  const stopGroups = groupDaysByStop(bundle, stays, sortedDays);

  const dayEntries = new Map<string, EntryDto[]>();
  for (const day of sortedDays) dayEntries.set(day.id, []);
  for (const entry of [...bundle.entries].sort((a, b) => a.position - b.position)) {
    dayEntries.get(entry.dayId)?.push(entry);
  }
  /** entryId → 其后紧邻交通段（口径同 ItineraryPanel） */
  const legAfter = new Map<string, TransportLegDto>();
  for (const day of sortedDays) {
    const legs = bundle.legs.filter((l) => l.dayId === day.id).sort((a, b) => a.seq - b.seq);
    for (const leg of legs) {
      if (leg.fromEntryId) legAfter.set(leg.fromEntryId, leg);
    }
  }

  /** 大交通汇总：全部 transit entry 按（天序号, position）排序 */
  const dayOrder = new Map(sortedDays.map((d) => [d.id, d.dayIndex]));
  const transitEntries = bundle.entries
    .filter((e) => e.entryType === "transit")
    .sort(
      (a, b) => (dayOrder.get(a.dayId) ?? 0) - (dayOrder.get(b.dayId) ?? 0) || a.position - b.position,
    );

  /** 关键预订信息：已加入行程的非酒店地点中，有待办/已办预订、预订链接/方式或电话的 */
  const bookingPlaces = bundle.places.filter(
    (p) =>
      p.status === "locked" &&
      p.category !== "hotel" &&
      (bookingStatusOf(p) !== "none" || p.bookingUrl || p.bookingInfo || p.phone),
  );

  const dateRange =
    trip.startDate != null
      ? `${trip.startDate} ~ ${trip.endDate ?? "未定"}`
      : "日期待定（可在行程页设置出发日期）";
  const stopsText =
    trip.stops.length > 1 ? trip.stops.map((s) => s.name).join(" → ") : trip.destinationCity;

  /** 渲染一天的区块（多城市时 stopName 由分组头给出，单城市为 null） */
  function renderDay(day: (typeof sortedDays)[number], stopName: string | null) {
    const entries = dayEntries.get(day.id) ?? [];
    const timeline = buildDayTimeline(entries, placeById, legAfter);
    const nightStay = stayCoveringNight(stays, day.dayIndex);
    const nightHotel = nightStay ? placeById.get(nightStay.placeId)?.name : null;
    return (
      <section className="ybe-day" key={day.id}>
        <div className="ybe-day-header">
          {formatDayLabel(trip.startDate, day.dayIndex)}
          {stopName && <span className="ybe-day-stop">📍 {stopName}</span>}
        </div>
        {/* 每日开头段落：本期放当晚住宿；每日概要/天气/强度（issue #5/#6/#9）落地后插在这里 */}
        <div className="ybe-day-intro">
          {nightHotel ? `当晚住宿：${nightHotel}` : day.dayIndex === sortedDays.length ? "行程最后一天" : "当晚住宿：未定"}
        </div>
        {timeline.length === 0 ? (
          <p className="ybe-empty">这一天还没有安排</p>
        ) : (
          timeline.map((item, i) => {
            const leg = legAfter.get(item.entry.id);
            return (
              <div key={item.entry.id}>
                <EntryRow {...item} placeById={placeById} />
                {/* 段是「其后紧邻」：末个 entry 后的返回酒店段也一并展示，作为当天收尾 */}
                {leg && (i < timeline.length - 1 || leg.toPlaceId != null) && <LegRow leg={leg} />}
              </div>
            );
          })
        )}
      </section>
    );
  }

  return (
    <div className="ybe-sheet">
      <h1>{trip.title}</h1>
      <p className="ybe-sub">
        {stopsText}
        {trip.geoProvider === "osm" ? "（海外）" : ""}
      </p>

      {/* 行程概览 */}
      <section className="ybe-section">
        <h2 className="ybe-section-title">行程概览</h2>
        <div className="ybe-overview-grid">
          <div>
            <span className="ybe-k">日期</span>
            {dateRange}
          </div>
          <div>
            <span className="ybe-k">天数</span>
            {sortedDays.length > 0 ? `${sortedDays.length} 天` : "未排天"}
          </div>
          <div>
            <span className="ybe-k">人数</span>
            {trip.travelerCount} 人
          </div>
          <div>
            <span className="ybe-k">途经地</span>
            {stopsText}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <HotelRows bundle={bundle} stays={stays} />
        </div>
      </section>

      {/* 每日时间轴 */}
      <section className="ybe-section">
        <h2 className="ybe-section-title">每日行程</h2>
        {sortedDays.length === 0 ? (
          <p className="ybe-empty">还没有排程，先让 agent 规划行程</p>
        ) : stopGroups ? (
          stopGroups.map((group, gi) => (
            <div key={gi}>
              {group.days.map((day) => renderDay(day, group.stopName))}
            </div>
          ))
        ) : (
          sortedDays.map((day) => renderDay(day, null))
        )}
      </section>

      {/* 大交通信息（值机/过关口径：方式 + 时刻 + 起讫点） */}
      {transitEntries.length > 0 && (
        <section className="ybe-section">
          <h2 className="ybe-section-title">大交通</h2>
          <table className="ybe-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>类别</th>
                <th>方式</th>
                <th>起讫</th>
                <th>出发</th>
                <th>到达</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {transitEntries.map((entry) => {
                const kind = transitKindOf(entry, dayOrder.get(entry.dayId) ?? 0, sortedDays.length);
                return (
                  <tr key={entry.id}>
                    <td>{formatDayLabel(trip.startDate, dayOrder.get(entry.dayId) ?? 0)}</td>
                    <td>{kind ? TRANSIT_KIND_META[kind].label : ""}</td>
                    <td>{entry.transitMode ? TRANSIT_MODE_META[entry.transitMode].label : "—"}</td>
                    <td>{transitRouteText(entry, placeById) ?? "—"}</td>
                    <td>{entry.departTime ?? "—"}</td>
                    <td>{entry.arriveTime ?? "—"}</td>
                    <td>{entry.note ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* 关键预订信息（餐厅/门票等：状态 + 电话 + 预订链接/方式） */}
      {bookingPlaces.length > 0 && (
        <section className="ybe-section">
          <h2 className="ybe-section-title">预订信息</h2>
          <table className="ybe-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类别</th>
                <th>状态</th>
                <th>电话</th>
                <th>预订方式 / 链接</th>
              </tr>
            </thead>
            <tbody>
              {bookingPlaces.map((place) => (
                <tr key={place.id}>
                  <td className="ybe-entry-name">{place.name}</td>
                  <td>{PLACE_CATEGORY_LABEL[place.category]}</td>
                  <td>{BOOKING_STATUS_META[bookingStatusOf(place)].label}</td>
                  <td>{place.phone ?? ""}</td>
                  <td>
                    {place.bookingInfo && <div>{place.bookingInfo}</div>}
                    {place.bookingUrl && <div className="ybe-url">{place.bookingUrl}</div>}
                    {!place.bookingInfo && !place.bookingUrl && "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="ybe-footer">
        <span>毛线团 Yarnball · 行程导出</span>
        <span>带 ~ 的时间是推算值，请以实际预订凭证为准</span>
      </div>
    </div>
  );
}
