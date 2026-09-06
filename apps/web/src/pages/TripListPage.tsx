import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CalendarDays,
  Globe2,
  MapPin,
  MoreHorizontal,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { TripDto } from "@yarnball/shared";
import { api } from "../api/client";
import { OnboardingBanner } from "../features/settings/OnboardingBanner";
import { SettingsDrawer } from "../features/settings/SettingsDrawer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

/** 卡片封面渐变池：按行程 id 稳定取色，保证同一行程每次渲染色调一致 */
const COVER_GRADIENTS = [
  "from-sky-500 via-blue-500 to-indigo-600",
  "from-amber-400 via-orange-400 to-rose-500",
  "from-emerald-400 via-teal-500 to-cyan-600",
  "from-fuchsia-400 via-purple-500 to-indigo-600",
  "from-rose-400 via-pink-500 to-orange-400",
  "from-cyan-400 via-sky-500 to-blue-600",
];

function coverGradient(tripId: string): string {
  let hash = 0;
  for (const ch of tripId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COVER_GRADIENTS[Math.abs(hash) % COVER_GRADIENTS.length];
}

/** 最近编辑的相对时间（「x 分钟前」，超过一周落回日期） */
function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

/** 卡片统计值：加载中静默「—」；拉取失败给错误态（title 提示 + 点击重试），不永久显示「—」 */
function StatValue({
  value,
  unit,
  failed,
  onRetry,
}: {
  value: number | undefined;
  unit: string;
  failed: boolean;
  onRetry: () => void;
}) {
  if (value != null) return <>{`${value} ${unit}`}</>;
  if (!failed) return <>{`— ${unit}`}</>;
  return (
    <span
      role="button"
      tabIndex={0}
      title="统计加载失败，点击重试"
      className="cursor-pointer text-amber-600 underline decoration-dotted underline-offset-2"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRetry();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onRetry();
        }
      }}
    >
      {`— ${unit}`}
    </span>
  );
}

/** 行程列表页：创建 + 管理（删除） */
export function TripListPage() {
  const navigate = useNavigate();
  const [trips, setTrips] = useState<TripDto[]>([]);
  /** 每个行程的天数/地点数（list 接口不含统计，并行拉 bundle 汇总；本地数据量小可接受） */
  const [stats, setStats] = useState<Record<string, { days: number; places: number }>>({});
  /** 统计拉取失败的行程 id：卡片上显示可重试的错误态，不静默吞掉 */
  const [statErrors, setStatErrors] = useState<Record<string, true>>({});
  const [title, setTitle] = useState("");
  const [city, setCity] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TripDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 设置抽屉 + 引导条（抽屉关闭后递增 refreshKey 让引导条重新检测）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bannerRefreshKey, setBannerRefreshKey] = useState(0);
  // 城市联想
  const [suggestions, setSuggestions] = useState<
    { name: string; country: string | null; center: { lng: number; lat: number } }[]
  >([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const cityDirtyRef = useRef(false); // 用户从联想里选过就不再自动触发

  useEffect(() => {
    if (!city.trim() || cityDirtyRef.current || city.length < 1) {
      setSuggestions([]);
      setSuggestOpen(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const { suggestions } = await api.citySuggest(city.trim());
        setSuggestions(suggestions);
        setSuggestOpen(suggestions.length > 0);
      } catch {
        /* 静默 */
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [city]);

  function pickSuggestion(s: { name: string }) {
    cityDirtyRef.current = true;
    setCity(s.name);
    setSuggestOpen(false);
  }

  async function refresh() {
    const { trips } = await api.listTrips();
    // 最近编辑的排前面
    trips.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    setTrips(trips);
    // 汇总天数/地点数：失败的行程记入 statErrors（卡片显示可重试的错误态）
    const results = await Promise.allSettled(trips.map((t) => api.getBundle(t.id)));
    const next: Record<string, { days: number; places: number }> = {};
    const errors: Record<string, true> = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        next[trips[i].id] = { days: r.value.bundle.days.length, places: r.value.bundle.places.length };
      } else {
        errors[trips[i].id] = true;
      }
    });
    setStats(next);
    setStatErrors(errors);
  }

  /** 单个行程统计重试（失败保持错误态，可再次点击） */
  async function retryStats(tripId: string) {
    try {
      const { bundle } = await api.getBundle(tripId);
      setStats((prev) => ({
        ...prev,
        [tripId]: { days: bundle.days.length, places: bundle.places.length },
      }));
      setStatErrors((prev) => {
        const next = { ...prev };
        delete next[tripId];
        return next;
      });
    } catch {
      /* 保持错误态 */
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create() {
    if (!title.trim() || !city.trim()) return;
    setCreating(true);
    try {
      const { trip } = await api.createTrip({ title: title.trim(), destinationCity: city.trim() });
      navigate(`/trip/${trip.id}`);
    } catch (err) {
      toast.error("创建失败", { description: (err as Error).message });
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteTrip(deleteTarget.id);
      toast.success(`已删除「${deleteTarget.title}」`);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      toast.error("删除失败", { description: (err as Error).message });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="min-h-full bg-gradient-to-b from-slate-50 via-white to-blue-50/40">
      <div className="mx-auto max-w-4xl px-6 py-12">
        {/* 头部 */}
        <header className="relative mb-8">
          <Button
            variant="outline"
            size="sm"
            className="absolute right-0 top-0"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings />
            设置
          </Button>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-blue-200/70 bg-blue-100/60 px-3 py-1 text-xs font-medium text-blue-700">
            <Sparkles className="size-3.5" />
            Agent-native 行程编辑器
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">毛线团 Yarnball</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-500">
            把攻略文本变成地图上的行程 —— 连接你自己的 agent，粘贴小红书 / 博客 / 酒店候选，
            它来解析地点、编排路线、分析顺路。
          </p>
        </header>

        {/* 首次使用引导（未配置密钥或无可用 agent 时显示） */}
        <OnboardingBanner
          refreshKey={bannerRefreshKey}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* 创建 */}
        <section className="mb-8 rounded-card border border-slate-200/80 bg-white/80 p-4 shadow-card backdrop-blur">
          <div className="flex flex-wrap gap-2.5">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              placeholder="行程名称，如「悉尼 5 日游」"
              className="h-10 min-w-52 flex-1"
            />
            <div className="relative">
              <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input
                value={city}
                onChange={(e) => {
                  cityDirtyRef.current = false;
                  setCity(e.target.value);
                }}
                onKeyDown={(e) => e.key === "Enter" && void create()}
                onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
                placeholder="目的地（Sydney / 杭州…）"
                className="h-10 w-56 pl-9"
                autoComplete="off"
              />
              {suggestOpen && suggestions.length > 0 && (
                <div className="absolute left-0 top-full z-20 mt-1.5 w-72 overflow-hidden rounded-box border border-white/60 bg-white/95 p-1.5 shadow-xl backdrop-blur-2xl">
                  {suggestions.map((s, i) => (
                    <button
                      key={`${s.name}-${i}`}
                      type="button"
                      onClick={() => pickSuggestion(s)}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-700 transition-colors hover:bg-blue-50"
                    >
                      <span className="font-medium">{s.name}</span>
                      {s.country && (
                        <span className="text-xs text-slate-400">{s.country}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              variant="primary"
              size="lg"
              onClick={create}
              disabled={creating || !title.trim() || !city.trim()}
            >
              <Plus />
              {creating ? "创建中…" : "创建行程"}
            </Button>
          </div>
          <p className="mt-2.5 text-xs text-slate-400">
            国内目的地自动走高德引擎；海外（如澳大利亚）走开源地图引擎，无需任何配置。
          </p>
        </section>

        {/* 列表 */}
        {trips.length === 0 ? (
          <div className="rounded-card border border-dashed border-slate-300 bg-white/50 py-16 text-center">
            <Globe2 className="mx-auto mb-3 size-10 text-slate-300" />
            <p className="text-sm font-medium text-slate-500">还没有行程</p>
            <p className="mt-1 text-xs text-slate-400">创建一个，然后连接你的 agent 开始编排。</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {trips.map((trip) => (
              <div
                key={trip.id}
                className="group relative overflow-hidden rounded-card border border-slate-200/80 bg-white shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover"
              >
                {/* 渐变封面：目的地色条 + 城市名，顶替「admin 列表」观感 */}
                <Link to={`/trip/${trip.id}`} className="block">
                  <div
                    className={`relative flex h-20 items-end bg-gradient-to-br ${coverGradient(trip.id)} px-4 pb-2.5`}
                  >
                    <div className="flex items-center gap-2 text-white">
                      <MapPin className="size-4 opacity-80" />
                      <span className="text-sm font-semibold tracking-wide drop-shadow-sm">
                        {trip.destinationCity}
                      </span>
                      {trip.geoProvider === "osm" && (
                        <span className="rounded-full bg-white/25 px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm">
                          海外
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="p-4 pr-11">
                    <p className="truncate font-semibold text-slate-900">{trip.title}</p>
                    <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="size-3.5 text-slate-400" />
                        <StatValue
                          value={stats[trip.id]?.days}
                          unit="天"
                          failed={statErrors[trip.id] === true}
                          onRetry={() => void retryStats(trip.id)}
                        />
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3.5 text-slate-400" />
                        <StatValue
                          value={stats[trip.id]?.places}
                          unit="个地点"
                          failed={statErrors[trip.id] === true}
                          onRetry={() => void retryStats(trip.id)}
                        />
                      </span>
                    </div>
                    <p className="mt-2.5 text-xs text-slate-400">
                      最近编辑 · {formatRelativeTime(trip.updatedAt)}
                    </p>
                  </div>
                </Link>
                {/* 更多菜单 */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label="行程操作"
                      className="absolute right-2.5 top-2.5 rounded-lg bg-black/15 p-1.5 text-white/90 opacity-0 backdrop-blur-sm transition-all hover:bg-black/30 focus:opacity-100 group-hover:opacity-100"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(trip)}>
                      <Trash2 />
                      删除行程
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 设置抽屉 */}
      <SettingsDrawer
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setBannerRefreshKey((k) => k + 1);
        }}
      />

      {/* 删除确认 */}
      <Dialog open={deleteTarget != null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除行程？</DialogTitle>
            <DialogDescription>
              「{deleteTarget?.title}」及其全部地点、日程、对话记录将被永久删除，此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
