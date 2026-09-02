import {
  Map as MlMap,
  Marker as MlMarker,
  AttributionControl,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { LngLat } from "@odessey/shared";
import type { OverlaySpecs } from "./overlaySpecs";
import type { MapRenderer } from "./MapCanvas";

/**
 * MapLibre 渲染器（海外，WGS84 + OSM 瓦片，零 key）。
 * marker 用 maplibre Marker + 自定义 DOM（毛玻璃风格的徽标，与整体 UI 一致）。
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

export class MapLibreRenderer implements MapRenderer {
  private map: MlMap | null = null;
  private markers: MlMarker[] = [];
  private routeLayerIds: string[] = [];
  private circleLayerIds: string[] = [];
  private sourceIds: string[] = [];

  constructor(private onSelectPlace: (placeId: string) => void) {}

  async init(container: HTMLElement, center: LngLat | null): Promise<void> {
    const map = new MapLibreMap({
      container,
      style: OSM_STYLE as never,
      center: center ? [center.lng, center.lat] : [151.2, -33.87],
      zoom: 12,
      attributionControl: false,
    });
    this.map = map;
    map.addControl(new AttributionControl({ compact: true }));
    await new Promise<void>((resolve, reject) => {
      map.once("load", () => resolve());
      map.once("error", (e: unknown) =>
        reject(new Error(String((e as { error?: unknown })?.error ?? "map load error"))),
      );
    });
  }

  render(specs: OverlaySpecs, selectedPlaceId: string | null): void {
    const map = this.map;
    if (!map) return;

    // 清理旧 overlay
    for (const m of this.markers) m.remove();
    this.markers = [];
    for (const id of [...this.routeLayerIds, ...this.circleLayerIds]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    this.routeLayerIds = [];
    this.circleLayerIds = [];
    for (const id of this.sourceIds) {
      if (map.getSource(id)) map.removeSource(id);
    }
    this.sourceIds = [];

    // 路线（GeoJSON source/layer）
    specs.lines.forEach((line, i) => {
      const srcId = `route-src-${i}`;
      const layerId = `route-${i}`;
      map.addSource(srcId, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: line.path.map((p) => [p.lng, p.lat]) },
          properties: {},
        },
      });
      map.addLayer({
        id: layerId,
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
      this.routeLayerIds.push(layerId);
      this.sourceIds.push(srcId);
    });

    // 推荐住宿区域圆（用 GeoJSON polygon 近似，64 段足够圆）
    if (specs.circle) {
      const { center, radiusM } = specs.circle;
      const ring: [number, number][] = [];
      const latRad = (Math.PI / 180) * center.lat;
      const dx = (radiusM / 111320) / Math.cos(latRad);
      const dy = radiusM / 110540;
      for (let i = 0; i <= 64; i++) {
        const theta = (i / 64) * Math.PI * 2;
        ring.push([center.lng + dx * Math.cos(theta), center.lat + dy * Math.sin(theta)]);
      }
      map.addSource("hotel-area-src", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: {},
        },
      });
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
      this.circleLayerIds.push("hotel-area", "hotel-area-outline");
      this.sourceIds.push("hotel-area-src");
    }

    // markers：引脚 DOM（毛玻璃卡片风格，选中态高亮）
    for (const spec of specs.markers) {
      const selected = spec.placeId === selectedPlaceId;
      const el = document.createElement("button");
      el.className =
        "border-none bg-transparent p-0 cursor-pointer flex flex-col items-center group";
      el.innerHTML = `
        <div style="white-space:nowrap;font-size:12px;padding:2px 8px;border-radius:9999px;background:${spec.color};color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)${
          selected ? ";outline:3px solid rgba(37,99,235,.5)" : ""
        }">${escapeHtml(spec.label)}</div>
        <div style="width:9px;height:9px;border-radius:9999px;background:${spec.color};margin:-2px auto 0;box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>`;
      el.onclick = () => this.onSelectPlace(spec.placeId);
      const marker = new MlMarker({ element: el, anchor: "bottom" })
        .setLngLat([spec.position.lng, spec.position.lat])
        .addTo(map);
      this.markers.push(marker);
    }
  }

  fit(specs: OverlaySpecs): void {
    const map = this.map;
    if (!map || specs.markers.length === 0) return;
    const lngs = specs.markers.map((m) => m.position.lng);
    const lats = specs.markers.map((m) => m.position.lat);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 70, maxZoom: 14, duration: 600 },
    );
  }

  flyTo(center: LngLat, zoom = 12): void {
    this.map?.flyTo({ center: [center.lng, center.lat], zoom, duration: 900 });
  }

  destroy(): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
    this.map?.remove();
    this.map = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
