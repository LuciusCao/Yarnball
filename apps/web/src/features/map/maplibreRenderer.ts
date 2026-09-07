import maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MlMap, Marker as MlMarker } from "maplibre-gl";
import type { LngLat } from "@yarnball/shared";
import {
  circleSignature,
  lineSignature,
  markerSignature,
  stopSignature,
  type OverlaySpecs,
} from "./overlaySpecs";
import type { MapRenderer } from "./MapCanvas";

/**
 * MapLibre 渲染器（海外，WGS84 + OSM 瓦片，零 key）。
 * marker 用 maplibre Marker + 自定义 DOM（毛玻璃风格的徽标，与整体 UI 一致）。
 * overlay 按 id 增量更新（M53）：同 id 同签名复用，不随 SSE 快照全量重建。
 */

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

interface StyleSpecification {
  version: number;
  sources: Record<string, unknown>;
  layers: Array<Record<string, unknown>>;
}

interface MarkerEntry {
  marker: MlMarker;
  sig: string;
}

export class MapLibreRenderer implements MapRenderer {
  private map: MlMap | null = null;
  /** 已挂载 marker（按 spec id 键控） */
  private markers = new Map<string, MarkerEntry>();
  private stopMarkers = new Map<string, MarkerEntry>();
  /** 已挂载路线：lineId -> 内容签名（layer/source id 由 lineId 派生） */
  private lineSigs = new Map<string, string>();
  private circleSig: string | null = null;

  constructor(private onSelectPlace: (placeId: string) => void) {}

  async init(container: HTMLElement, center: LngLat | null): Promise<void> {
    const map = new maplibregl.Map({
      container,
      style: OSM_STYLE as never,
      center: center ? [center.lng, center.lat] : [151.2, -33.87],
      zoom: 12,
      attributionControl: false,
    });
    this.map = map;
    // 调试暴露（生产无碍：单机自托管）；destroy / 初始化超时时清理，避免悬挂已销毁的 map
    (window as unknown as Record<string, unknown>).__mapDebug = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    // context lost 可见于 UI（WebGL 资源被系统回收时的自愈提示）
    map.getCanvas().addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.warn("[map] WebGL context lost");
    });
    await new Promise<void>((resolve, reject) => {
      // 兜底：8s 内 load/error 都没触发（环境 WebGL 异常时 maplibre 会静默挂起）
      const timer = setTimeout(() => {
        if (this.map !== map) return; // 等待期间已被 destroy
        if (!map.loaded() && !map.isStyleLoaded()) {
          this.clearDebugRef(map);
          map.remove();
          this.map = null;
          reject(new Error("地图初始化超时（WebGL 可能不可用，请尝试刷新页面）"));
        }
      }, 8000);
      map.once("load", () => {
        clearTimeout(timer);
        resolve();
      });
      map.once("error", (e: unknown) => {
        clearTimeout(timer);
        reject(new Error(String((e as { error?: unknown })?.error ?? "map load error")));
      });
    });
  }

  /** __mapDebug 只在还指向这张 map 时清理，避免误删新渲染器刚挂的引用 */
  private clearDebugRef(map: MlMap): void {
    const w = window as unknown as Record<string, unknown>;
    if (w.__mapDebug === map) delete w.__mapDebug;
  }

  render(specs: OverlaySpecs, selectedPlaceId: string | null): void {
    const map = this.map;
    if (!map) return;
    this.syncLines(map, specs);
    this.syncCircle(map, specs);
    this.syncMarkers(
      this.stopMarkers,
      specs.stops.map((stop) => ({
        id: stop.name,
        sig: stopSignature(stop),
        create: () => this.createStopMarker(map, stop),
      })),
    );
    this.syncMarkers(
      this.markers,
      specs.markers.map((spec) => {
        const selected = spec.placeId === selectedPlaceId;
        return {
          id: spec.id,
          sig: markerSignature(spec, selected),
          create: () => this.createMarker(map, spec, selected),
        };
      }),
    );
  }

  /** 增量同步 marker：移除消失/签名变化的，新增新出现的；签名不变的复用不动 */
  private syncMarkers(
    current: Map<string, MarkerEntry>,
    desired: Array<{ id: string; sig: string; create: () => MlMarker }>,
  ): void {
    const desiredById = new Map(desired.map((d) => [d.id, d]));
    for (const [id, entry] of current) {
      const d = desiredById.get(id);
      if (!d || d.sig !== entry.sig) {
        entry.marker.remove();
        current.delete(id);
      }
    }
    for (const d of desired) {
      if (current.has(d.id)) continue;
      current.set(d.id, { marker: d.create(), sig: d.sig });
    }
  }

  /** 路线（GeoJSON source/layer）：layer/source id 由 line.id 派生，按 id 增量增删 */
  private syncLines(map: MlMap, specs: OverlaySpecs): void {
    const desired = new Map(specs.lines.map((l) => [l.id, l]));
    for (const [id, sig] of this.lineSigs) {
      const line = desired.get(id);
      if (!line || lineSignature(line) !== sig) {
        this.removeLine(map, id);
      }
    }
    for (const line of specs.lines) {
      if (this.lineSigs.has(line.id)) continue;
      const srcId = `route-src-${line.id}`;
      map.addSource(srcId, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: line.path.map((p) => [p.lng, p.lat]) },
          properties: {},
        },
      });
      map.addLayer({
        id: `route-${line.id}`,
        type: "line",
        source: srcId,
        paint: {
          "line-color": line.color,
          "line-width": 3.5,
          "line-opacity": 0.85,
          ...(line.dashed
            ? { "line-dasharray": [2, 2] }
            : {}),
        },
      });
      this.lineSigs.set(line.id, lineSignature(line));
    }
  }

  private removeLine(map: MlMap, lineId: string): void {
    const layerId = `route-${lineId}`;
    const srcId = `route-src-${lineId}`;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(srcId)) map.removeSource(srcId);
    this.lineSigs.delete(lineId);
  }

  /** 推荐住宿区域圆（用 GeoJSON polygon 近似，64 段足够圆）；圆心/半径变化时 setData 原位更新 */
  private syncCircle(map: MlMap, specs: OverlaySpecs): void {
    if (!specs.circle) {
      if (this.circleSig != null) {
        for (const id of ["hotel-area", "hotel-area-outline"]) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        if (map.getSource("hotel-area-src")) map.removeSource("hotel-area-src");
        this.circleSig = null;
      }
      return;
    }
    const sig = circleSignature(specs.circle);
    if (sig === this.circleSig) return;
    const { center, radiusM } = specs.circle;
    const ring: [number, number][] = [];
    const latRad = (Math.PI / 180) * center.lat;
    const dx = (radiusM / 111320) / Math.cos(latRad);
    const dy = radiusM / 110540;
    for (let i = 0; i <= 64; i++) {
      const theta = (i / 64) * Math.PI * 2;
      ring.push([center.lng + dx * Math.cos(theta), center.lat + dy * Math.sin(theta)]);
    }
    const data: Parameters<GeoJSONSource["setData"]>[0] = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {},
    };
    const src = map.getSource("hotel-area-src") as GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
    } else {
      map.addSource("hotel-area-src", { type: "geojson", data });
      map.addLayer({
        id: "hotel-area",
        type: "fill",
        source: "hotel-area-src",
        paint: { "fill-color": "#dc2626", "fill-opacity": 0.06 },
      });
      map.addLayer({
        id: "hotel-area-outline",
        type: "line",
        source: "hotel-area-src",
        paint: { "line-color": "#dc2626", "line-width": 1, "line-opacity": 0.6 },
      });
    }
    this.circleSig = sig;
  }

  /** 途经地标记（M39 多城市）：白底深色描边胶囊 + 序号，先渲染使其被地点标记自然压在下面，不可点击 */
  private createStopMarker(map: MlMap, stop: OverlaySpecs["stops"][number]): MlMarker {
    const el = document.createElement("div");
    el.innerHTML = `<div style="white-space:nowrap;font-size:11px;font-weight:600;padding:2px 8px;border-radius:9999px;background:rgba(255,255,255,.92);color:#334155;border:1.5px solid #334155;box-shadow:0 1px 4px rgba(15,23,42,.25)">${stop.index} · ${escapeHtml(stop.name)}</div>`;
    return new maplibregl.Marker({ element: el, anchor: "top" })
      .setLngLat([stop.position.lng, stop.position.lat])
      .addTo(map);
  }

  /** 地点 marker：Tahoe 风玻璃胶囊徽标（选中态高亮环；候选半透明） */
  private createMarker(map: MlMap, spec: OverlaySpecs["markers"][number], selected: boolean): MlMarker {
    const el = document.createElement("button");
    el.className = "border-none bg-transparent p-0 cursor-pointer flex flex-col items-center";
    el.style.opacity = String(spec.opacity);
    el.innerHTML = `
      <div style="white-space:nowrap;font-size:12px;font-weight:600;padding:3px 10px;border-radius:9999px;background:linear-gradient(180deg,${spec.color}f2,${spec.color}d9);color:#fff;box-shadow:0 2px 8px rgba(15,23,42,.3),inset 0 1px 0 rgba(255,255,255,.45)${
        selected ? ";outline:3px solid rgba(37,99,235,.45)" : ""
      }">${escapeHtml(spec.label)}</div>
      <div style="width:10px;height:10px;border-radius:9999px;background:${spec.color};margin:-3px auto 0;box-shadow:0 1px 4px rgba(15,23,42,.4),inset 0 1px 0 rgba(255,255,255,.4)"></div>`;
    el.onclick = () => this.onSelectPlace(spec.placeId);
    return new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([spec.position.lng, spec.position.lat])
      .addTo(map);
  }

  fit(specs: OverlaySpecs): void {
    const map = this.map;
    const points = [
      ...specs.markers.map((m) => m.position),
      ...specs.stops.map((s) => s.position),
    ];
    if (!map || points.length === 0) return;
    const lngs = points.map((p) => p.lng);
    const lats = points.map((p) => p.lat);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 70, maxZoom: 14, duration: 600 },
    );
  }

  fitPath(path: LngLat[]): void {
    const map = this.map;
    if (!map || path.length === 0) return;
    const lngs = path.map((p) => p.lng);
    const lats = path.map((p) => p.lat);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 90, maxZoom: 15, duration: 600 },
    );
  }

  flyTo(center: LngLat, zoom = 12): void {
    this.map?.flyTo({ center: [center.lng, center.lat], zoom, duration: 900 });
  }

  destroy(): void {
    // map.remove 会连带移除 marker/layer/source，这里只需清账本 + 摘调试引用
    const map = this.map;
    this.markers.clear();
    this.stopMarkers.clear();
    this.lineSigs.clear();
    this.circleSig = null;
    if (map) {
      this.clearDebugRef(map);
      map.remove();
    }
    this.map = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
