import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Globe2, MapPin, MoreHorizontal, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { TripDto } from "@odessey/shared";
import { api } from "../api/client";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
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

/** 行程列表页：创建 + 管理（删除） */
export function TripListPage() {
  const navigate = useNavigate();
  const [trips, setTrips] = useState<TripDto[]>([]);
  const [title, setTitle] = useState("");
  const [city, setCity] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TripDto | null>(null);
  const [deleting, setDeleting] = useState(false);

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
      <div className="mx-auto max-w-3xl px-6 py-14">
        {/* 头部 */}
        <header className="mb-10">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-blue-200/70 bg-blue-100/60 px-3 py-1 text-xs font-medium text-blue-700">
            <Sparkles className="size-3.5" />
            Agent-native 行程编辑器
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Odessey</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            把攻略文本变成地图上的行程 —— 连接你自己的 agent，粘贴小红书 / 博客 / 酒店候选，
            它来解析地点、编排路线、分析顺路。
          </p>
        </header>

        {/* 创建 */}
        <section className="mb-10 rounded-2xl border border-slate-200/80 bg-white/80 p-5 shadow-sm backdrop-blur">
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
                onChange={(e) => setCity(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void create()}
                placeholder="目的地（Sydney / 杭州…）"
                className="h-10 w-56 pl-9"
              />
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
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white/50 py-16 text-center">
            <Globe2 className="mx-auto mb-3 size-10 text-slate-300" />
            <p className="text-sm font-medium text-slate-500">还没有行程</p>
            <p className="mt-1 text-xs text-slate-400">创建一个，然后连接你的 agent 开始编排。</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {trips.map((trip) => (
              <div
                key={trip.id}
                className="group relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white/80 shadow-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg"
              >
                {/* 顶部装饰条 */}
                <div className="h-1.5 w-full bg-gradient-to-r from-blue-500 via-cyan-400 to-emerald-400 opacity-70" />
                <Link to={`/trip/${trip.id}`} className="block p-4 pr-11">
                  <p className="truncate font-semibold text-slate-900">{trip.title}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Badge variant="blue">{trip.destinationCity}</Badge>
                    {trip.geoProvider === "osm" && <Badge variant="success">海外</Badge>}
                  </div>
                  <p className="mt-2 text-xs text-slate-400">
                    创建于 {new Date(trip.createdAt).toLocaleDateString("zh-CN")}
                  </p>
                </Link>
                {/* 更多菜单 */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label="行程操作"
                      className="absolute right-2.5 top-3.5 rounded-lg p-1.5 text-slate-300 opacity-0 transition-all hover:bg-slate-100 hover:text-slate-600 focus:opacity-100 group-hover:opacity-100"
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
