import AMapLoader from "@amap/amap-jsapi-loader";
import type { LngLat } from "@yarnball/shared";
import {
  categoryIconEmoji,
  circleSignature,
  lineSignature,
  markerSignature,
  stopSignature,
  type OverlaySpecs,
} from "./overlaySpecs";
import type { MapRenderer } from "./MapCanvas";

/**
 * 高德渲染器（国内，GCJ-02）。
 * 注意：服务端 amap provider 返回的坐标已是 GCJ-02，直接画；无需转换。
 * overlay 按 id 增量更新（M53）：同 id 同签名复用，不随 SSE 快照全量重建。
 */

interface OverlayEntry {
  overlay: any;
  sig: string;
}

export class AMapRenderer implements MapRenderer {
  private map: any = null;
  private AMap: any = null;
  /** 已挂载 overlay（按 spec id 键控） */
  private markerOverlays = new Map<string, OverlayEntry>();
  private stopOverlays = new Map<string, OverlayEntry>();
  private lineOverlays = new Map<string, OverlayEntry>();
  private circleOverlay: OverlayEntry | null = null;

  constructor(
    private jsKey: string,
    private jsSecret: string,
    private onSelectPlace: (placeId: string) => void,
  ) {}

  async init(container: HTMLElement, center: LngLat | null): Promise<void> {
    (window as any)._AMapSecurityConfig = this.jsSecret
      ? { securityJsCode: this.jsSecret }
      : undefined;
    this.AMap = await AMapLoader.load({ key: this.jsKey, version: "2.0", plugins: ["AMap.Scale"] });
    this.map = new this.AMap.Map(container, {
      zoom: 12,
      center: center ? [center.lng, center.lat] : [120.15, 30.27],
      viewMode: "2D",
    });
    this.map.addControl(new this.AMap.Scale());
  }

  render(specs: OverlaySpecs, selectedPlaceId: string | null): void {
    if (!this.map || !this.AMap) return;
    this.syncOverlays(
      this.markerOverlays,
      specs.markers.map((marker) => {
        const selected = marker.placeId === selectedPlaceId;
        return {
          id: marker.id,
          sig: markerSignature(marker, selected),
          create: () => this.createMarker(marker, selected),
        };
      }),
    );
    this.syncOverlays(
      this.stopOverlays,
      specs.stops.map((stop) => ({
        // key 用序号而非 name：环线行程首尾同城市时同名 stop 会冲突（review P2）
        id: `stop-${stop.index}`,
        sig: stopSignature(stop),
        create: () => this.createStopMarker(stop),
      })),
    );
    this.syncOverlays(
      this.lineOverlays,
      specs.lines.map((line) => ({
        id: line.id,
        sig: lineSignature(line),
        create: () => this.createPolyline(line),
      })),
    );
    this.syncCircle(specs);
  }

  /** 增量同步：移除消失/签名变化的，新增新出现的；签名不变的复用不动 */
  private syncOverlays(
    current: Map<string, OverlayEntry>,
    desired: Array<{ id: string; sig: string; create: () => any }>,
  ): void {
    const desiredById = new Map(desired.map((d) => [d.id, d]));
    for (const [id, entry] of current) {
      const d = desiredById.get(id);
      if (!d || d.sig !== entry.sig) {
        this.map.remove(entry.overlay);
        current.delete(id);
      }
    }
    for (const d of desired) {
      if (current.has(d.id)) continue;
      const overlay = d.create();
      this.map.add(overlay);
      current.set(d.id, { overlay, sig: d.sig });
    }
  }

  private createMarker(marker: OverlaySpecs["markers"][number], selected: boolean): any {
    const m = new this.AMap.Marker({
      position: [marker.position.lng, marker.position.lat],
      title: marker.label,
      opacity: marker.opacity,
      // 选中态：蓝色高亮环 + 提层（与 maplibre 渲染器视觉一致）
      zIndex: selected ? 120 : 100,
      label: {
        content: `<div style="white-space:nowrap;font-size:12px;font-weight:600;padding:3px 10px;border-radius:9999px;background:linear-gradient(180deg,${marker.color}f2,${marker.color}d9);color:#fff;box-shadow:0 2px 8px rgba(15,23,42,.3),inset 0 1px 0 rgba(255,255,255,.45)${
          selected ? ";outline:3px solid rgba(37,99,235,.45)" : ""
        }">${categoryIconEmoji(marker.category)}${escapeHtml(marker.label)}</div>`,
        direction: "top",
        offset: [0, -6],
      },
      anchor: "bottom-center",
    });
    m.on("click", () => this.onSelectPlace(marker.placeId));
    return m;
  }

  /** 途经地标记（M39 多城市）：深色描边白底胶囊 + 序号，置于地点标记之下（zIndex 90），不可点击 */
  private createStopMarker(stop: OverlaySpecs["stops"][number]): any {
    return new this.AMap.Marker({
      position: [stop.position.lng, stop.position.lat],
      title: `途经地 ${stop.index}：${stop.name}`,
      zIndex: 90,
      label: {
        content: `<div style="white-space:nowrap;font-size:11px;font-weight:600;padding:2px 8px;border-radius:9999px;background:rgba(255,255,255,.92);color:#334155;border:1.5px solid #334155;box-shadow:0 1px 4px rgba(15,23,42,.25)">${stop.index} · ${escapeHtml(stop.name)}</div>`,
        direction: "bottom",
        offset: [0, 6],
      },
      anchor: "top-center",
    });
  }

  private createPolyline(line: OverlaySpecs["lines"][number]): any {
    return new this.AMap.Polyline({
      path: line.path.map((p) => [p.lng, p.lat]),
      strokeColor: line.color,
      strokeWeight: 4,
      strokeOpacity: 0.8,
      showDir: !line.dashed,
      ...(line.dashed ? { strokeStyle: "dashed" } : {}),
    });
  }

  private syncCircle(specs: OverlaySpecs): void {
    if (!specs.circle) {
      if (this.circleOverlay) {
        this.map.remove(this.circleOverlay.overlay);
        this.circleOverlay = null;
      }
      return;
    }
    const sig = circleSignature(specs.circle);
    if (this.circleOverlay?.sig === sig) return;
    if (this.circleOverlay) {
      // 圆心/半径变化：原位更新，不拆除重建
      this.circleOverlay.overlay.setCenter([specs.circle.center.lng, specs.circle.center.lat]);
      this.circleOverlay.overlay.setRadius(specs.circle.radiusM);
      this.circleOverlay.sig = sig;
      return;
    }
    const circle = new this.AMap.Circle({
      center: [specs.circle.center.lng, specs.circle.center.lat],
      radius: specs.circle.radiusM,
      strokeColor: "#dc2626",
      strokeWeight: 1,
      strokeOpacity: 0.6,
      fillColor: "#dc2626",
      fillOpacity: 0.06,
    });
    this.map.add(circle);
    this.circleOverlay = { overlay: circle, sig };
  }

  fit(specs: OverlaySpecs): void {
    if (!this.map) return;
    const markers = [...this.markerOverlays.values(), ...this.stopOverlays.values()].map(
      (e) => e.overlay,
    );
    if (markers.length > 0) this.map.setFitView(markers, false, [60, 60, 60, 60]);
  }

  fitPath(path: LngLat[]): void {
    if (!this.map || !this.AMap || path.length === 0) return;
    const lngs = path.map((p) => p.lng);
    const lats = path.map((p) => p.lat);
    const bounds = new this.AMap.Bounds(
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    );
    this.map.setBounds(bounds, false, [90, 90, 90, 90]);
  }

  flyTo(center: LngLat, zoom = 12): void {
    this.map?.setZoomAndCenter(zoom, [center.lng, center.lat]);
  }

  destroy(): void {
    // map.destroy 会连带移除全部 overlay，这里只需清账本
    this.markerOverlays.clear();
    this.stopOverlays.clear();
    this.lineOverlays.clear();
    this.circleOverlay = null;
    this.map?.destroy?.();
    this.map = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
