import { useEffect, useRef, useState } from "react";
import { KeyRound, MapPinOff, RefreshCw } from "lucide-react";
import type { LngLat, TripBundle } from "@yarnball/shared";
import { buildOverlaySpecs, dayColor } from "./overlaySpecs";
import { AMapRenderer } from "./amapRenderer";
import { MapLibreRenderer } from "./maplibreRenderer";

/**
 * 地图画布 —— 双引擎调度器。
 * 国内行程（geoProvider=amap）：高德 JSAPI 2.0（GCJ-02，POI 数据好）。
 * 海外行程（geoProvider=osm）：MapLibre GL + OSM 瓦片（WGS84，零 key）。
 * 两个渲染器消费同一份 overlay specs（数据层在 overlaySpecs.ts）。
 * 坐标系不同，引擎与 provider 一一对应，绝不混用。
 */

export { DAY_COLORS, dayColor } from "./overlaySpecs";

export interface MapRenderer {
  /** 初始化（懒加载引擎后调用一次） */
  init(container: HTMLElement, center: LngLat | null): Promise<void>;
  /** 全量重画 overlays（数据量小，简单可靠） */
  render(specs: ReturnType<typeof buildOverlaySpecs>, selectedPlaceId: string | null): void;
  /** fitView 到标记集合 */
  fit(specs: ReturnType<typeof buildOverlaySpecs>): void;
  /** 飞到指定坐标（城市定位/自愈重定位用） */
  flyTo(center: LngLat, zoom?: number): void;
  destroy(): void;
}

interface MapCanvasProps {
  bundle: TripBundle | null;
  amapJsKey: string;
  amapJsSecret: string;
  visibleDayIndex: number | null;
  hotelArea: { center: LngLat; radiusM: number } | null;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
  /** 打开设置抽屉（缺高德 Key 时引导用户去配置）；未提供时退回 .env 文案 */
  onOpenSettings?: () => void;
}

export function MapCanvas({
  bundle,
  amapJsKey,
  amapJsSecret,
  visibleDayIndex,
  hotelArea,
  selectedPlaceId,
  onSelectPlace,
  onOpenSettings,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const initErrorRef = useRef<string | null>(null);
  const fittedRef = useRef<string>("");
  const [initError, setInitError] = useState<string | null>(null);
  /** 重试计数：+1 触发引擎重挂载（不刷新整页） */
  const [retryCount, setRetryCount] = useState(0);
  /** 最新渲染输入（init 完成晚于 bundle 到达时，init 回调用它补画一帧） */
  const latestRef = useRef<{
    bundle: TripBundle | null;
    visibleDayIndex: number | null;
    hotelArea: { center: LngLat; radiusM: number } | null;
    selectedPlaceId: string | null;
  }>({ bundle: null, visibleDayIndex: null, hotelArea: null, selectedPlaceId: null });
  latestRef.current = { bundle, visibleDayIndex, hotelArea, selectedPlaceId };

  const provider = bundle?.trip.geoProvider ?? "osm";
  const center = bundle?.trip.location ?? null;

  // 城市定位：无地点时飞到城市中心（有地点时 fit 到标记更有用）
  useEffect(() => {
    if (!center || !bundle) return;
    if (bundle.places.length > 0) return;
    rendererRef.current?.flyTo(center, 12);
  }, [center, bundle?.places.length]);

  // 引擎初始化（provider 变化时重建 —— 一个页面只会有一份行程，切换行程=卸载组件）
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bundle) return;

    let disposed = false;
    const renderer: MapRenderer =
      provider === "amap" ? new AMapRenderer(amapJsKey, amapJsSecret, onSelectPlace) : new MapLibreRenderer(onSelectPlace);

    void renderer
      .init(container, center)
      .then(() => {
        if (disposed) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        initErrorRef.current = null;
        setInitError(null);
        // init 可能晚于 bundle 到达：用最新输入补画一帧 + fit + 城市定位，
        // 否则 specs effect 已跑过、地图会空转（竞态修复）
        const latest = latestRef.current;
        if (latest.bundle) {
          const specs = buildOverlaySpecs(latest.bundle, latest.visibleDayIndex, latest.hotelArea);
          renderer.render(specs, latest.selectedPlaceId);
          const fitKey = latest.bundle.places.map((p) => p.id).sort().join(",");
          if (latest.bundle.places.length > 0) {
            renderer.fit(specs);
            fittedRef.current = fitKey;
          } else if (latest.bundle.trip.location) {
            renderer.flyTo(latest.bundle.trip.location, 12);
          }
        }
      })
      .catch((err) => {
        if (disposed) return;
        const message = (err as Error).message ?? String(err);
        initErrorRef.current = message;
        setInitError(message);
      });

    return () => {
      disposed = true;
      renderer.destroy();
      rendererRef.current = null;
      fittedRef.current = "";
    };
    // bundle 不进依赖（初始化一次）；provider/key 变化才重建；retryCount 变化=用户点了重试
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, amapJsKey, amapJsSecret, retryCount]);

  // overlay 重画
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !bundle) return;
    const specs = buildOverlaySpecs(bundle, visibleDayIndex, hotelArea);
    renderer.render(specs, selectedPlaceId);

    // 行程地点集合变化时 fitView 一次
    const fitKey = bundle.places.map((p) => p.id).sort().join(",");
    if (bundle.places.length > 0 && fitKey !== fittedRef.current) {
      fittedRef.current = fitKey;
      renderer.fit(specs);
    }
  }, [bundle, visibleDayIndex, hotelArea, selectedPlaceId]);

  // 兜底一：缺高德 key —— 配置问题，引导去设置（区别于下面的引擎运行失败）
  if (provider === "amap" && !amapJsKey) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-100 p-8 text-center text-sm text-slate-500">
        <div className="max-w-xs">
          <KeyRound className="mx-auto mb-3 size-8 text-slate-300" />
          <p className="mb-1.5 font-medium text-slate-700">国内行程需要高德地图 Key</p>
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className="mb-3 rounded-full bg-scheduled px-4 py-1.5 text-xs font-medium text-white shadow transition-transform hover:scale-105"
            >
              打开设置，填写高德 Key
            </button>
          )}
          <p className="leading-relaxed">
            也可以在 <code className="rounded bg-slate-200 px-1">.env</code> 里填写{" "}
            <code className="rounded bg-slate-200 px-1">AMAP_JS_KEY</code> 后重启服务。
            <br />
            （海外行程使用开源地图，无需任何 Key）
          </p>
        </div>
      </div>
    );
  }

  // 兜底二：引擎加载失败 / WebGL 不可用 —— 可重试，重挂载地图组件而不是刷新整页
  if (initError) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-100 p-8 text-center text-sm text-slate-500">
        <div className="max-w-xs">
          <MapPinOff className="mx-auto mb-3 size-8 text-slate-300" />
          <p className="mb-1.5 font-medium text-slate-700">地图引擎加载失败</p>
          <p className="mb-4 text-xs leading-relaxed text-slate-400">
            通常是浏览器 WebGL 不可用（显卡驱动 / 无痕模式限制）或地图服务暂时不可达。
          </p>
          <button
            onClick={() => {
              setInitError(null);
              setRetryCount((c) => c + 1);
            }}
            className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-scheduled px-4 py-1.5 text-xs font-medium text-white shadow transition-transform hover:scale-105"
          >
            <RefreshCw className="size-3.5" />
            重试
          </button>
          <p className="break-all font-mono text-[11px] leading-relaxed text-slate-400">
            {initError}
          </p>
        </div>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
