import AMapLoader from "@amap/amap-jsapi-loader";
import type { LngLat } from "@odessey/shared";
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

  render(specs: OverlaySpecs, _selectedPlaceId: string | null): void {
    if (!this.map || !this.AMap) return;
    for (const overlay of this.overlays) this.map.remove(overlay);
    this.overlays = [];
    for (const l of this.clickListeners) l();
    this.clickListeners = [];

    for (const marker of specs.markers) {
      const m = new this.AMap.Marker({
        position: [marker.position.lng, marker.position.lat],
        title: marker.label,
        label: {
          content: `<div style="padding:1px 5px;font-size:12px;border-radius:6px;background:${marker.color};color:#fff;white-space:nowrap">${escapeHtml(marker.label)}</div>`,
          direction: "top",
          offset: [0, -4],
        },
        anchor: "bottom-center",
      });
      m.on("click", () => this.onSelectPlace(marker.placeId));
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
