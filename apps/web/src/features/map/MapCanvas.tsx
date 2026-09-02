import { useEffect, useRef } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";
import type { TripBundle } from "@odessey/shared";
import type { LngLat } from "@odessey/shared";

/**
 * AMap JSAPI 2.0 地图画布。
 * - 按天配色 + 天内序号标记
 * - 每天的路线 polyline（真实路径几何）
 * - 酒店候选特殊图标、选定酒店高亮
 * - Day 筛选 / 推荐住宿区域圆
 */

export const DAY_COLORS = [
  "#2563eb", // blue-600
  "#ea580c", // orange-600
  "#16a34a", // green-600
  "#9333ea", // purple-600
  "#db2777", // pink-600
  "#0891b2", // cyan-600
  "#ca8a04", // yellow-600
  "#4f46e5", // indigo-600
];

const CATEGORY_ICONS: Record<string, string> = {
  attraction: "🏛",
  restaurant: "🍜",
  hotel: "🏨",
  activity: "🎯",
  other: "📍",
};

interface MapCanvasProps {
  bundle: TripBundle | null;
  amapJsKey: string;
  amapJsSecret: string;
  /** null = 显示全部天 */
  visibleDayIndex: number | null;
  hotelArea: { center: LngLat; radiusM: number } | null;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
}

export function MapCanvas({
  bundle,
  amapJsKey,
  amapJsSecret,
  visibleDayIndex,
  hotelArea,
  selectedPlaceId,
  onSelectPlace,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const AMapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const fittedRef = useRef<string>("");

  // 加载地图（一次性）
  useEffect(() => {
    if (!amapJsKey || !containerRef.current || mapRef.current) return;
    let disposed = false;
    (window as any)._AMapSecurityConfig = amapJsSecret
      ? { securityJsCode: amapJsSecret }
      : undefined;
    AMapLoader.load({ key: amapJsKey, version: "2.0", plugins: ["AMap.Scale"] })
      .then((AMap) => {
        if (disposed || !containerRef.current) return;
        AMapRef.current = AMap;
        mapRef.current = new AMap.Map(containerRef.current, {
          zoom: 12,
          center: [120.15, 30.27],
          viewMode: "2D",
        });
        mapRef.current.addControl(new AMap.Scale());
      })
      .catch((err) => console.error("[map] AMap load failed:", err));
    return () => {
      disposed = true;
      mapRef.current?.destroy?.();
      mapRef.current = null;
    };
  }, [amapJsKey, amapJsSecret]);

  // 渲染覆盖物（bundle/筛选变化时全量重画——数量小，简单可靠）
  useEffect(() => {
    const map = mapRef.current;
    const AMap = AMapRef.current;
    if (!map || !AMap || !bundle) return;

    for (const overlay of overlaysRef.current) map.remove(overlay);
    overlaysRef.current = [];

    const placeById = new Map(bundle.places.map((p) => [p.id, p]));
    const dayById = new Map(bundle.days.map((d) => [d.id, d]));

    // 天 → entry 列表（按 position 排序）
    const dayEntries = new Map<string, typeof bundle.entries>();
    for (const day of bundle.days) dayEntries.set(day.id, []);
    const sortedEntries = [...bundle.entries].sort((a, b) => a.position - b.position);
    for (const entry of sortedEntries) {
      dayEntries.get(entry.dayId)?.push(entry);
    }

    // 计算酒店候选/选定
    const hotelPlaceIds = new Set(bundle.hotelCandidates.map((h) => h.placeId));
    const selectedHotelPlaceId =
      bundle.trip.selectedHotelCandidateId != null
        ? bundle.hotelCandidates.find((h) => h.id === bundle.trip.selectedHotelCandidateId)
            ?.placeId ?? null
        : null;

    // 未编入任何天的散点（agent 刚建的 / 用户收藏的）
    const scheduledPlaceIds = new Set(bundle.entries.map((e) => e.placeId));

    const addMarker = (
      place: TripBundle["places"][number],
      label: string,
      color: string,
      onClick: () => void,
    ) => {
      const marker = new AMap.Marker({
        position: [place.location.lng, place.location.lat],
        title: place.name,
        label: {
          content: `<div style="padding:1px 5px;font-size:12px;border-radius:6px;background:${color};color:#fff;white-space:nowrap">${label}</div>`,
          direction: "top",
          offset: [0, -4],
        },
        anchor: "bottom-center",
      });
      marker.on("click", onClick);
      map.add(marker);
      overlaysRef.current.push(marker);
    };

    // 各天的 entry 标记 + 路线
    for (const day of bundle.days) {
      if (visibleDayIndex != null && day.dayIndex !== visibleDayIndex) continue;
      const color = DAY_COLORS[(day.dayIndex - 1) % DAY_COLORS.length];
      const entries = dayEntries.get(day.id) ?? [];

      entries.forEach((entry, i) => {
        const place = placeById.get(entry.placeId);
        if (!place) return;
        addMarker(
          place,
          `D${day.dayIndex}·${i + 1} ${place.name}`,
          color,
          () => onSelectPlace(place.id),
        );
      });

      // 路线 polyline：优先真实路径，降级直线
      const legByPair = new Map<string, TripBundle["legs"][number]>();
      for (const leg of bundle.legs) legByPair.set(`${leg.fromEntryId}->${leg.toEntryId}`, leg);
      for (let i = 0; i + 1 < entries.length; i++) {
        const leg = legByPair.get(`${entries[i].id}->${entries[i + 1].id}`);
        if (!leg) continue;
        const from = placeById.get(entries[i].placeId);
        const to = placeById.get(entries[i + 1].placeId);
        if (!from || !to) continue;
        const path =
          leg.polyline && leg.polyline.length > 1
            ? leg.polyline.map((p) => [p.lng, p.lat])
            : [
                [from.location.lng, from.location.lat],
                [to.location.lng, to.location.lat],
              ];
        const line = new AMap.Polyline({
          path,
          strokeColor: color,
          strokeWeight: 4,
          strokeOpacity: 0.8,
          showDir: true,
        });
        map.add(line);
        overlaysRef.current.push(line);
      }
    }

    // 酒店候选（未筛天时显示）
    if (visibleDayIndex == null) {
      for (const cand of bundle.hotelCandidates) {
        const place = placeById.get(cand.placeId);
        if (!place) continue;
        const isSel = cand.placeId === selectedHotelPlaceId;
        addMarker(
          place,
          `${isSel ? "✓ " : ""}🏨 ${place.name}${cand.pricePerNight ? ` ¥${cand.pricePerNight}/晚` : ""}`,
          isSel ? "#dc2626" : "#78716c",
          () => onSelectPlace(place.id),
        );
      }

      // 推荐住宿区域
      if (hotelArea) {
        const circle = new AMap.Circle({
          center: [hotelArea.center.lng, hotelArea.center.lat],
          radius: hotelArea.radiusM,
          strokeColor: "#dc2626",
          strokeWeight: 1,
          strokeOpacity: 0.6,
          fillColor: "#dc2626",
          fillOpacity: 0.06,
        });
        map.add(circle);
        overlaysRef.current.push(circle);
      }
    }

    // 未编排散点
    for (const place of bundle.places) {
      if (scheduledPlaceIds.has(place.id) || hotelPlaceIds.has(place.id)) continue;
      addMarker(place, `${CATEGORY_ICONS[place.category] ?? "📍"} ${place.name}`, "#9ca3af", () =>
        onSelectPlace(place.id),
      );
    }

    // 视野适配：行程地点集合变化时 fitView 一次
    const allPlaces = bundle.places;
    const fitKey = allPlaces.map((p) => p.id).sort().join(",");
    if (allPlaces.length > 0 && fitKey !== fittedRef.current) {
      fittedRef.current = fitKey;
      map.setFitView(overlaysRef.current.filter((o) => o.CLASS_NAME?.includes("Marker")), false, [
        60, 60, 60, 60,
      ]);
    }
  }, [bundle, visibleDayIndex, hotelArea, selectedPlaceId, onSelectPlace]);

  if (!amapJsKey) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-100 p-8 text-center text-sm text-slate-500">
        <div>
          <p className="mb-2 font-medium text-slate-700">未配置高德地图 Key</p>
          <p>
            在 <code className="rounded bg-slate-200 px-1">.env</code> 里填写{" "}
            <code className="rounded bg-slate-200 px-1">AMAP_JS_KEY</code>（Web端 JS API 类型）后重启服务。
            <br />
            申请地址：lbs.amap.com
          </p>
        </div>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
