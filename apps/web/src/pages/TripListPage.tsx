import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CalendarDays,
  Globe2,
  LogIn,
  MapPin,
  PackageSearch,
  MoreHorizontal,
  Plus,
  Route,
  Settings,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { isDomesticOsmTrip, type TripDto } from "@yarnball/shared";
import { api } from "../api/client";
import { api as uxApi } from "../lib/api";
import { ApiError, GUEST_KICKED_EVENT } from "../lib/http";
import { useOwnerAuth } from "../lib/principal";
import { OnboardingBanner } from "../features/settings/OnboardingBanner";
import { SettingsDrawer, type SettingsSection } from "../features/settings/SettingsDrawer";
import { ImportPackageDialog } from "../features/share/ImportPackageDialog";
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

/** 城市联想/输入的「国内」判定来源：高德返回「中国」，Nominatim（zh）同为「中国」，Photon 后备为英文 */
const CHINA_COUNTRIES = new Set(["中国", "China"]);

/** 国内零配置降级提示（M113）的「不再提示」标记 */
const DOMESTIC_OSM_HINT_KEY = "yarnball:domestic-osm-hint-dismissed";

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
  /**
   * 远程主人未登录态（issue #32）：远程浏览器无凭证访问 / 时 GET /api/trips 是 401
   *（行程列表 owner-only）——此时渲染「需要登录」引导页而不是空列表加一堆报错 toast。
   * 本机 loopback 恒为 owner，不会进入该态。
   */
  const [needLogin, setNeedLogin] = useState(false);
  /** 每个行程的天数/地点数（list 接口不含统计，并行拉 bundle 汇总；本地数据量小可接受） */
  const [stats, setStats] = useState<Record<string, { days: number; places: number }>>({});
  /** 统计拉取失败的行程 id：卡片上显示可重试的错误态，不静默吞掉 */
  const [statErrors, setStatErrors] = useState<Record<string, true>>({});
  const [title, setTitle] = useState("");
  const [city, setCity] = useState("");
  /** 额外途经地（M39 多城市）：自由文本，逗号/顿号分隔；留空 = 单城市行程 */
  const [extraStops, setExtraStops] = useState("");
  /** 出发日期（可选，YYYY-MM-DD）；不填则行程天标签退化为「Day N」 */
  const [startDate, setStartDate] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TripDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 设置抽屉 + 引导条（抽屉关闭后递增 refreshKey 让引导条重新检测）
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 导入行程数据包（issue #34）：.yarnball 文件 + 密码 → 新行程副本 */
  const [importOpen, setImportOpen] = useState(false);
  const [bannerRefreshKey, setBannerRefreshKey] = useState(0);
  // 引导条步骤点击传入，抽屉打开后定位到对应分区
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  // 城市联想
  const [suggestions, setSuggestions] = useState<
    { name: string; country: string | null; center: { lng: number; lat: number } }[]
  >([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const cityDirtyRef = useRef(false); // 用户从联想里选过就不再自动触发
  // 国内零配置降级提示（M113）：高德 key 配置态 + 用户从联想选中目的地时的国家 + 一次性关闭标记
  const [amapConfigured, setAmapConfigured] = useState<boolean | null>(null);
  const [pickedChina, setPickedChina] = useState<boolean | null>(null);
  const [osmHintDismissed, setOsmHintDismissed] = useState(
    () => localStorage.getItem(DOMESTIC_OSM_HINT_KEY) === "1",
  );

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

  function pickSuggestion(s: { name: string; country: string | null }) {
    cityDirtyRef.current = true;
    setCity(s.name);
    setPickedChina(s.country != null && CHINA_COUNTRIES.has(s.country));
    setSuggestOpen(false);
  }

  async function refresh() {
    const { trips } = await api.listTrips();
    // 最近编辑的排前面
    trips.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    setTrips(trips);    // 汇总天数/地点数：失败的行程记入 statErrors（卡片显示可重试的错误态）
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
    refresh().catch((err) => {
      // 远程未登录（401）或凭证不是主人身份（403，如误把协作链接 token 存成了 owner 凭证）：
      // 切登录引导态；其余错误保持原空态（创建时会再报）
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setNeedLogin(true);
    });
  }, []);

  // owner 凭证在会话中失效（主人在本机重置了 token）：apiFetch 广播踢出（tripId=null），
  // 已存的 owner 凭证已被清除——切回登录引导态。登录成功（token 从 null 变有值）则重拉列表。
  const ownerToken = useOwnerAuth((s) => s.token);
  useEffect(() => {
    const onKicked = (e: Event) => {
      const detail = (e as CustomEvent<{ tripId: string | null }>).detail;
      if (detail?.tripId == null) setNeedLogin(true);
    };
    window.addEventListener(GUEST_KICKED_EVENT, onKicked);
    return () => window.removeEventListener(GUEST_KICKED_EVENT, onKicked);
  }, []);
  useEffect(() => {
    if (ownerToken != null && needLogin) {
      setNeedLogin(false);
      void refresh().catch(() => {});
    }
  }, [ownerToken]);

  // 高德 key 配置态（降级提示的展示条件之一；设置抽屉保存后bannerRefreshKey 递增会重挂引导条，这里随行建议输入实时判定即可）
  useEffect(() => {
    void api.config().then((c) => setAmapConfigured(c.amapConfigured)).catch(() => {});
  }, [bannerRefreshKey]);

  /**
   * 国内目的地判定（降级提示用，非阻断）：优先取联想选中/匹配的国家，
   * 无联想数据时退化为「含中文」启发式（东京这类假阳性只是多提示一句，可关闭）。
   */
  const cityText = city.trim();
  const matchedSuggestion = suggestions.find((s) => s.name === cityText);
  const domesticInput =
    cityText.length > 0 &&
    (pickedChina === true ||
      (pickedChina == null &&
        (matchedSuggestion?.country != null
          ? CHINA_COUNTRIES.has(matchedSuggestion.country)
          : /[一-鿿]/.test(cityText))));
  const showOsmFallbackHint = amapConfigured === false && domesticInput && !osmHintDismissed;

  async function create() {
    if (!title.trim() || !city.trim()) return;
    setCreating(true);
    try {
      // 多城市（M39）：途经地按填写顺序排在主目的地之后（stops[0] 恒为主目的地）；留空则不传，保持单城市原行为
      const extra = extraStops
        .split(/[,，、;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const { trip } = await uxApi.createTrip({
        title: title.trim(),
        destinationCity: city.trim(),
        ...(extra.length > 0 ? { stops: [city.trim(), ...extra] } : {}),
        ...(startDate ? { startDate } : {}),
      });
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

  // 远程主人未登录（issue #32）：整页登录引导——远程无凭证访问 / 时 GET /api/trips 401
  //（行程列表 owner-only）。本机 loopback 恒为 owner，不会进入该态。
  if (needLogin) {
    return (
      <div className="flex min-h-full items-center justify-center bg-gradient-to-b from-sky-50 to-slate-100">
        <div className="mx-4 flex max-w-sm flex-col items-center gap-3 rounded-3xl border border-slate-200/80 bg-white/85 px-8 py-10 text-center shadow-xl backdrop-blur">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-blue-600/10">
            <LogIn className="size-6 text-blue-600" />
          </div>
          <h2 className="text-base font-semibold text-slate-900">需要主人身份</h2>
          <p className="text-sm leading-relaxed text-slate-500">
            你正在远程访问毛线团。粘贴「设置 → 远程访问凭证」生成的 owner token
            登录，或使用行程主人发给你的协作链接（/join/…）进入对应行程。
          </p>
          <Button onClick={() => navigate("/login")}>
            <LogIn className="size-4" />
            前往登录
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-gradient-to-b from-slate-50 via-white to-blue-50/40">
      <div className="mx-auto max-w-4xl px-6 py-12">
        {/* 头部 */}
        <header className="relative mb-8">
          <div className="absolute right-0 top-0 flex gap-2">
            {/* 导入行程（issue #34 离线数据包）：选 .yarnball 文件 + 密码 → 新行程副本 */}
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <PackageSearch />
              导入行程
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings />
              设置
            </Button>
          </div>
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

        {/* 新手两步设置引导（agent 未就绪或密钥未配置/未跳过时显示） */}
        <OnboardingBanner
          refreshKey={bannerRefreshKey}
          onOpenSettings={(section) => {
            setSettingsSection(section);
            setSettingsOpen(true);
          }}
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
                  setPickedChina(null);
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
          {/* 出发日期（可选）：设置后行程每天显示真实日期（D1 · 9/23 周三），不填退化为 Day N */}
          <div className="relative mt-2.5">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              title="出发日期（可选）"
              className="h-10 w-full pl-9 text-slate-600"
            />
          </div>
          {/* 多城市（M39）：可选途经地输入，按游览顺序逗号/顿号分隔；环线把首站写回末尾即可 */}
          <div className="relative mt-2.5">
            <Route className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={extraStops}
              onChange={(e) => setExtraStops(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              placeholder="途经地（可选）：多城市/环线按顺序填写，如「青海湖, 茶卡, 大柴旦, 敦煌」"
              className="h-10 w-full pl-9"
              autoComplete="off"
            />
          </div>
          <p className="mt-2.5 text-xs text-slate-400">
            国内目的地在配置高德 Key 后走高德引擎，未配置时自动使用开源引擎（OSM，零配置可用）；
            海外（如澳大利亚）走开源地图引擎。填了途经地即为多城市行程：行程面板按途经地分组，地图标记全部途经地。
          </p>
          {/* 国内零配置降级提示（M113）：选中国内目的地且未配高德 key 时提示数据质量差异；非阻断，可一次性关闭 */}
          {showOsmFallbackHint && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-xs leading-relaxed text-amber-800">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <p className="min-w-0 flex-1">
                未配置高德地图 Key，这个国内行程将使用开源地图引擎（OpenStreetMap）：POI
                搜索覆盖率与公交数据质量低于高德（市内公交为估算）。
                <button
                  type="button"
                  className="mx-0.5 font-medium text-blue-700 underline-offset-2 hover:underline"
                  onClick={() => {
                    setSettingsSection("amap");
                    setSettingsOpen(true);
                  }}
                >
                  去设置页配置 Key
                </button>
                可获得完整体验（仅影响之后新建的行程）。
              </p>
              <button
                type="button"
                aria-label="不再提示"
                title="不再提示"
                className="shrink-0 rounded p-0.5 text-amber-400 transition-colors hover:bg-amber-100 hover:text-amber-600"
                onClick={() => {
                  localStorage.setItem(DOMESTIC_OSM_HINT_KEY, "1");
                  setOsmHintDismissed(true);
                }}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
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
                      {trip.stops.length > 1 && (
                        <span className="rounded-full bg-white/25 px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm">
                          {trip.stops.length} 个途经地
                        </span>
                      )}
                      {trip.geoProvider === "osm" && !isDomesticOsmTrip(trip) && (
                        <span className="rounded-full bg-white/25 px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm">
                          海外
                        </span>
                      )}
                      {/* 国内 + 开源引擎（M113 零配置回退）：与海外区分开，提示数据质量口径不同 */}
                      {isDomesticOsmTrip(trip) && (
                        <span className="rounded-full bg-white/25 px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm">
                          开源引擎
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
      {/* 导入行程数据包（issue #34，portal 挂 body） */}
      <ImportPackageDialog open={importOpen} onOpenChange={setImportOpen} />
      <SettingsDrawer
        open={settingsOpen}
        focusSection={settingsSection}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) {
            setBannerRefreshKey((k) => k + 1);
            setSettingsSection(undefined);
          }
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
