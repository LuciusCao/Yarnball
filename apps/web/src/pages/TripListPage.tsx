import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { TripDto } from "@odessey/shared";

/** 行程列表页 + 新建 */
export function TripListPage() {
  const [trips, setTrips] = useState<TripDto[]>([]);
  const [title, setTitle] = useState("");
  const [city, setCity] = useState("");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    const { trips } = await api.listTrips();
    setTrips(trips);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create() {
    if (!title.trim() || !city.trim()) return;
    setCreating(true);
    try {
      const { trip } = await api.createTrip({ title: title.trim(), destinationCity: city.trim() });
      window.location.href = `/trip/${trip.id}`;
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-1 text-2xl font-bold">Odessey</h1>
      <p className="mb-6 text-sm text-slate-500">
        基于地图的旅行攻略编辑器 —— 接入你自己的 agent，把攻略文本变成地图上的行程。
      </p>

      <div className="mb-8 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="行程名称，如「杭州 3 日游」"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
        />
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="目的地城市"
          className="w-36 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
        />
        <button
          onClick={create}
          disabled={creating || !title.trim() || !city.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {creating ? "…" : "创建行程"}
        </button>
      </div>

      <div className="space-y-2">
        {trips.map((trip) => (
          <a
            key={trip.id}
            href={`/trip/${trip.id}`}
            className="flex items-center gap-3 rounded-xl border border-slate-200 p-4 hover:border-blue-300 hover:bg-blue-50/30"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{trip.title}</p>
              <p className="text-xs text-slate-400">
                {trip.destinationCity} · 创建于 {new Date(trip.createdAt).toLocaleDateString("zh-CN")}
              </p>
            </div>
            <span className="text-slate-300">→</span>
          </a>
        ))}
        {trips.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">
            还没有行程。创建一个，然后连接你的 agent 开始编排。
          </p>
        )}
      </div>
    </div>
  );
}
