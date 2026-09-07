import AMapLoader from "@amap/amap-jsapi-loader";
import type { LngLat } from "@yarnball/shared";
import type { OverlaySpecs } from "./overlaySpecs";
import type { MapRenderer } from "./MapCanvas";

/**
 * 高德渲染器（国内，GCJ-02）。
 * 注意：服务端 amap provider 返回的坐标已是 GCJ-02，直接画；无需转换。
 */

export class AMapRenderer implements MapRenderer {
  private map: any = null;
  private AMap: any = null;
  private overlays: any[] = [];
  private clickListeners: Array<() => void> = [];

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
    for (const overlay of this.overlays) this.map.remove(overlay);
    this.overlays = [];
    for (const l of this.clickListeners) l();
    this.clickListeners = [];

    for (const marker of specs.markers) {
      const selected = marker.placeId === selectedPlaceId;
      const m = new this.AMap.Marker({
        position: [marker.position.lng, marker.position.lat],
        title: marker.label,
        opacity: marker.opacity,
        // 选中态：蓝色高亮环 + 提层（与 maplibre 渲染器视觉一致）
        zIndex: selected ? 120 : 100,
        label: {
          content: `<div style="white-space:nowrap;font-size:12px;font-weight:600;padding:3px 10px;border-radius:9999px;background:linear-gradient(180deg,${marker.color}f2,${marker.color}d9);color:#fff;box-shadow:0 2px 8px rgba(15,23,42,.3),inset 0 1px 0 rgba(255,255,255,.45)${
            selected ? ";outline:3px solid rgba(37,99,235,.45)" : ""
          }">${escapeHtml(marker.label)}</div>`,
          direction: "top",
          offset: [0, -6],
        },
        anchor: "bottom-center",
      });
      m.on("click", () => this.onSelectPlace(marker.placeId));
      this.map.add(m);
      this.overlays.push(m);
    }

    // 途经地标记层（M39 多城市）：深色描边白底胶囊 + 序号，置于地点标记之下（zIndex 90），不可点击
    for (const stop of specs.stops) {
      const m = new this.AMap.Marker({
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
      this.map.add(m);
      this.overlays.push(m);
    }

    for (const line of specs.lines) {
      const poly = new this.AMap.Polyline({
        path: line.path.map((p) => [p.lng, p.lat]),
        strokeColor: line.color,
        strokeWeight: 4,
        strokeOpacity: 0.8,
        showDir: !line.dashed,
        ...(line.dashed ? { strokeStyle: "dashed" } : {}),
      });
      this.map.add(poly);
      this.overlays.push(poly);
    }

    if (specs.circle) {
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
      this.overlays.push(circle);
    }
  }

  fit(specs: OverlaySpecs): void {
    if (!this.map) return;
    const markers = this.overlays.filter((o) => o.CLASS_NAME?.includes("Marker"));
    if (markers.length > 0) this.map.setFitView(markers, false, [60, 60, 60, 60]);
  }

  flyTo(center: LngLat, zoom = 12): void {
    this.map?.setZoomAndCenter(zoom, [center.lng, center.lat]);
  }

  destroy(): void {
    this.map?.destroy?.();
    this.map = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
