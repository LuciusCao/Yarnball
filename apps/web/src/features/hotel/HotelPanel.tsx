import { useEffect, useState } from "react";
import type { TripBundle } from "@odessey/shared";
import { api } from "../../api/client";

/** 酒店面板：候选卡 + 选择 + 推荐区域 */
export function HotelPanel({
  tripId,
  bundle,
  onDataChanged,
}: {
  tripId: string;
  bundle: TripBundle;
  onDataChanged: () => void;
}) {
  const [area, setArea] = useState<{ center: { lng: number; lat: number }; radiusM: number } | null>(null);
  const placeById = new Map(bundle.places.map((p) => [p.id, p]));

  useEffect(() => {
    void api.hotelArea(tripId).then(({ area }) => setArea(area));
  }, [tripId, bundle.places.length]);

  async function select(candidateId: string | null) {
    await api.selectHotel(tripId, candidateId);
    onDataChanged();
  }

  const selectedId = bundle.trip.selectedHotelCandidateId;

  return (
    <div className="h-full overflow-y-auto p-3">
      {area && (
        <div className="mb-3 rounded-lg border border-red-100 bg-red-50/50 px-3 py-2 text-xs text-slate-600">
          🎯 建议住宿区域：行程地点中位数中心附近（半径 {Math.round(area.radiusM / 1000)} 公里，
          地图上红圈所示）。把这条发给 agent：
          <button
            className="ml-1 text-blue-600 underline"
            onClick={() => {
              void navigator.clipboard?.writeText(
                `帮我在住宿推荐区域（中心坐标 ${area.center.lng},${area.center.lat} 附近）搜索合适的酒店，加入 2-3 个候选`,
              );
            }}
          >
            复制提示词
          </button>
        </div>
      )}

      {bundle.hotelCandidates.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-400">
          还没有酒店候选。把携程的酒店列表粘给 agent，或点上面「复制提示词」。
        </p>
      )}

      <div className="space-y-2">
        {bundle.hotelCandidates.map((cand) => {
          const place = placeById.get(cand.placeId);
          if (!place) return null;
          const isSel = cand.id === selectedId;
          return (
            <div
              key={cand.id}
              className={`rounded-xl border p-3 ${
                isSel ? "border-red-300 bg-red-50/30 ring-1 ring-red-200" : "border-slate-200"
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="text-lg">🏨</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{place.name}</p>
                  <p className="truncate text-xs text-slate-400">{place.address ?? place.location.lng.toFixed(3) + "," + place.location.lat.toFixed(3)}</p>
                  {cand.pricePerNight != null && (
                    <p className="mt-1 text-sm text-orange-600 font-medium">¥{cand.pricePerNight}/晚</p>
                  )}
                  {cand.notes && <p className="mt-1 text-xs text-slate-500">{cand.notes}</p>}
                  {place.sourceUrl && (
                    <a
                      href={place.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-xs text-blue-500 underline"
                    >
                      来源链接
                    </a>
                  )}
                </div>
                <button
                  onClick={() => void select(isSel ? null : cand.id)}
                  className={`shrink-0 rounded-lg px-3 py-1 text-xs font-medium ${
                    isSel
                      ? "bg-red-600 text-white"
                      : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {isSel ? "✓ 已选定" : "选定"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
