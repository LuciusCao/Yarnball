import { randomUUID, randomBytes } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import type {
  Actor,
  AddEntryInput,
  CreateHotelCandidateInput,
  CreatePlaceInput,
  CreateTripInput,
  DayCluster,
  GeoProviderName,
  LngLat,
  PlaceDto,
  PlaceStatus,
  SuggestDayClustersResult,
  TransitSegment,
  TransportMode,
  TripBundle,
  TripStop,
  UpdateEntryInput,
  UpdatePlaceInput,
  UpdateTripInput,
} from "@yarnball/shared";
import { TRIPS_CHANNEL, tripChannel, type EventBus } from "../events.js";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import {
  toDayDto,
  toEntryDto,
  toHotelDto,
  toLegDto,
  toPlaceDto,
  toTripDto,
} from "./mappers.js";
import { amap, currencyForCountry, drivingMatrixBatched, fallbackRoute, getProvider, haversineM, osm } from "./geo.js";
import { insertionIncrements, kMedoids, optimizeLoopOrder, optimizeOrder, optimizePathOrder, orderTotalDuration } from "./routing.js";
import { amapConfigured } from "./settings.js";

const uuid = () => randomUUID();

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 并发限流器：同一时刻最多 concurrency 个任务在执行，其余排队。
 * minIntervalMs > 0 时叠加漏桶限速：任务启动间隔不小于该值——免费 OSRM demo 服按速率限流（429），
 * 只限并发不够（并发 2 时秒级峰值仍可能超窗口），必须把请求速率本身压下来。
 */
function createLimiter(concurrency: number, minIntervalMs = 0) {
  let active = 0;
  let nextStartAt = 0;
  const queue: Array<() => void> = [];
  // 启动队首任务（受并发数 + 最小启动间隔双重约束）；间隔未到位的任务先占住并发槽位再延迟启动，
  // 保证任何时刻窗口内的请求速率都不超限
  const pump = () => {
    while (queue.length > 0 && active < concurrency) {
      const delay = Math.max(0, nextStartAt - Date.now());
      const start = queue.shift()!;
      active++;
      nextStartAt = Date.now() + delay + minIntervalMs;
      if (delay > 0) setTimeout(start, delay);
      else start();
    }
  };
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      pump();
    });
    try {
      return await task();
    } finally {
      active--;
      pump();
    }
  };
}

export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 疑似重复信号（409）：createPlace 的模糊判重（规范化名称相同/互为前缀 + 坐标 ≤200m）
 * 命中已有 place 时抛出——不创建新行、不回填已有行，把已有 place DTO 带回调用方
 * （REST 弹确认框 / MCP 指引 agent 用 update_place 补全或带 allowDuplicate 重试）。
 * amapPoiId 精确匹配不抛此错误（保持幂等返回已有 place）。
 */
export class PossibleDuplicateError extends ServiceError {
  constructor(public existingPlace: PlaceDto) {
    super(409, `疑似与已有地点「${existingPlace.name}」重复（名称相近且坐标距离 ≤200m），未创建新地点。`);
  }
}

/** agent 建点的防编造校验：距城市中心的最大半径（千米），按 provider 放宽 */
const AGENT_PLACE_MAX_CITY_DIST_KM: Record<GeoProviderName, number> = {
  amap: 150,
  osm: 300, // 海外城市间距大（悉尼→蓝山 ~110km，墨尔本→大洋路 ~230km）
};

/**
 * 多城市行程的防编造半径（千米）：距「任一」途经地中心的 min 距离阈值。
 * 单城市行程不用它（退化为上面的单中心阈值，行为与多城市特性前完全一致）；
 * 多城市取 max(单中心阈值, 200)——环线上相邻节点间距可达 350km（大柴旦→敦煌），
 * 200km 覆盖绝大多数中途点位又不至于放进编造坐标。v2.1 可加走廊校验进一步兜底。
 */
const AGENT_PLACE_MULTI_STOP_MIN_DIST_KM = 200;

/** 建点时 cityName 自动填充的归属半径：距最近途经地中心 ≤150km 则归该 stop，否则 null（归属未知不阻断） */
const PLACE_CITY_ASSIGN_MAX_DIST_KM = 150;

/** 建点幂等去重：规范化名称相同（或互为前缀）且坐标距离 ≤200m 视为同一地点（不插新行） */
const PLACE_DEDUP_MAX_DIST_M = 200;

/** 自动交通方式分档（直线距离，米）：< LEG_WALK_MAX_M 步行 */
const LEG_WALK_MAX_M = 2000;
/** 自动交通方式分档：LEG_WALK_MAX_M ~ LEG_TRANSIT_MAX_M 公交（amap 真实公交路由 / osm 估算口径），以上驾车 */
const LEG_TRANSIT_MAX_M = 6000;

/**
 * 名称规范化（去重比较用）：小写 + 去除全部空白（含全角空格）+ 统一全半角括号 +
 * 剥离末尾括号后缀（「外婆家（西湖店）」「Aria (West)」这类分店/方位标注与主名视为同一地点）。
 */
const normalizePlaceName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")")
    .replace(/(\s*\([^)]*\))+\s*$/, "")
    .replace(/[\s　]+/g, "");

/**
 * 去重名称匹配：规范化后完全相等，或一方是另一方的前缀。
 * 前缀分支要求短名 ≥3 字符（≥2 会放进「酒店」⊂「酒店式公寓」这类通用词假合并，
 * 3 字符起才足以携带具体专名语义，如「河坊街」⊂「河坊街小吃城」）；
 * 语义仍不同的相邻点由 ≤200m 距离约束兜底。
 */
const placeNameMatch = (a: string, b: string) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
};

/** "HH:MM" → 当天分钟数；非法输入为 null（与前端 timeline.ts 的 parseHHMM 口径一致） */
function hhmmToMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 当天分钟数 → "HH:MM"（跨零点取模回 24h 内） */
function minToHHMM(minutes: number): string {
  const t = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** transit entry 大交通段时长：depart/arrive 时刻差（跨零点按次日到达计）；缺任一为 null */
function transitDurationS(departTime: string | null, arriveTime: string | null): number | null {
  const parse = (t: string | null) => {
    if (!t) return null;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const d = parse(departTime);
  const a = parse(arriveTime);
  if (d == null || a == null) return null;
  const diff = a >= d ? a - d : a + 24 * 60 - d;
  return diff * 60;
}

export class TripService {
  /**
   * 路由调用的全局限流（跨天/跨段共享），按 provider 分档：
   * 免费 OSRM demo 服按速率限流（429），并发 2 + 最小启动间隔 500ms（≤2 次/秒，实测 2.5 次/秒仍偶发 429）；
   * 高德付费 API 无此约束，保持并发 5。
   */
  private routeLimits: Record<GeoProviderName, ReturnType<typeof createLimiter>> = {
    amap: createLimiter(5),
    osm: createLimiter(2, 500),
  };

  constructor(
    private db: Db,
    private bus: EventBus,
  ) {}

  // ---------- trips ----------

  /**
   * 行程的有序途经地节点（多城市/环线）。stops 列缺省（迁移前旧行）时由镜像字段
   * （destinationCity/cityAdcode/cityCenter）兜底构造 stops[0]，与 toTripDto 的兜底一致。
   */
  private stopsOfTrip(trip: {
    stops: unknown;
    destinationCity: string;
    cityAdcode: string | null;
    cityCenterLng: number | null;
    cityCenterLat: number | null;
  }): TripStop[] {
    const stops = trip.stops as TripStop[] | null;
    if (stops && stops.length > 0) return stops;
    return [
      {
        name: trip.destinationCity,
        adcode: trip.cityAdcode,
        center:
          trip.cityCenterLng != null && trip.cityCenterLat != null
            ? { lng: Number(trip.cityCenterLng), lat: Number(trip.cityCenterLat) }
            : null,
      },
    ];
  }

  /**
   * 目的地解析 + provider 判定（创建与自愈共用）：
   * 1. 高德可用时优先（country=中国 → amap，GCJ-02）
   * 2. 否则走 OSM 栈（Nominatim 优先），按返回的国家判定：
   *    中国目的地 → amap（即使未配 key——数据模型必须正确，否则中文 POI 搜索
   *    会错到别的城市；未配 key 时搜索/路线给出明确配置提示，路线降级直线估算）
   * 判定不出国家（网络失败）→ osm、center null（前端触发自愈重试）。
   */
  private async resolveDestination(
    city: string,
    forced?: GeoProviderName,
  ): Promise<{
    provider: GeoProviderName;
    adcode: string | null;
    center: LngLat | null;
    currency: string;
  }> {
    if (forced === "amap" || (!forced && amapConfigured())) {
      try {
        const geo = await amap.resolveCity(city);
        if (geo?.country === "中国") {
          return { provider: "amap", adcode: geo.adcode, center: geo.center, currency: "CNY" };
        }
      } catch (err) {
        console.warn("[trip] amap resolveCity failed:", (err as Error).message);
      }
      if (forced === "amap") return { provider: "amap", adcode: null, center: null, currency: "CNY" };
    }
    try {
      const geo = await osm.resolveCity(city);
      if (geo) {
        if (geo.country === "中国" || geo.country === "China") {
          return { provider: "amap", adcode: null, center: geo.center, currency: "CNY" };
        }
        return {
          provider: "osm",
          adcode: null,
          center: geo.center,
          currency: currencyForCountry(geo.countryCode),
        };
      }
    } catch (err) {
      console.warn("[trip] osm resolveCity failed:", (err as Error).message);
    }
    return { provider: "osm", adcode: null, center: null, currency: "USD" };
  }

  /**
   * 多城市途经地解析（createTrip / reResolveCity 共用）：
   * stops[0] 走 resolveDestination 判定 provider（沿用全部现有兜底与自愈语义）；
   * 其余节点用同一 provider 逐个 resolveCity 拿中心（高德对「青海湖」「茶卡镇」这类非行政区也能解析）。
   * 同侧校验：任一节点解析到另一侧国家 → 422 提示拆成两个行程（一个行程一个坐标系，跨国混合不支持）。
   * 解析失败（网络/未找到）的节点保留 name-only（center null）：防编造校验跳过它，自愈时重解析。
   */
  private async resolveStops(
    names: string[],
    forced?: GeoProviderName,
  ): Promise<{
    provider: GeoProviderName;
    adcode: string | null;
    center: LngLat | null;
    currency: string;
    stops: TripStop[];
  }> {
    const first = await this.resolveDestination(names[0], forced);
    const stops: TripStop[] = [{ name: names[0], adcode: first.adcode, center: first.center }];
    if (names.length === 1) return { ...first, stops };
    const provider = getProvider(first.provider);
    for (const name of names.slice(1)) {
      let stop: TripStop = { name, adcode: null, center: null };
      try {
        const geo = await provider.resolveCity(name);
        if (geo) {
          const isChina = geo.country === "中国" || geo.country === "China";
          if (first.provider === "amap" && !isChina) {
            throw new ServiceError(
              422,
              `途经地「${name}」解析到海外（${geo.country ?? "国家未知"}），与主目的地「${names[0]}」（国内）不在同一侧：` +
                `一个行程只支持单一坐标系，请拆成两个行程。`,
            );
          }
          if (first.provider === "osm" && isChina) {
            throw new ServiceError(
              422,
              `途经地「${name}」解析到国内，与主目的地「${names[0]}」（海外）不在同一侧：` +
                `一个行程只支持单一坐标系，请拆成两个行程。`,
            );
          }
          stop = { name, adcode: geo.adcode, center: geo.center };
        }
      } catch (err) {
        if (err instanceof ServiceError) throw err;
        console.warn(`[trip] resolve stop「${name}」failed:`, (err as Error).message);
      }
      stops.push(stop);
    }
    return { ...first, stops };
  }

  async createTrip(input: CreateTripInput) {
    const id = uuid();
    const shareToken = randomBytes(16).toString("hex");
    // 有序途经地：缺省 = [destinationCity]（单城市，行为与 stops 特性前完全一致）；
    // 提供 stops 时首元素是主目的地，destinationCity/cityCenter 落成它的兼容镜像
    const stopNames = input.stops?.length ? input.stops : [input.destinationCity];
    const resolved = await this.resolveStops(stopNames, input.geoProvider);
    const [row] = await this.db
      .insert(schema.trips)
      .values({
        id,
        title: input.title,
        destinationCity: stopNames[0],
        cityAdcode: resolved.adcode,
        geoProvider: resolved.provider,
        cityCenterLng: resolved.center ? resolved.center.lng : null,
        cityCenterLat: resolved.center ? resolved.center.lat : null,
        stops: resolved.stops,
        currency: resolved.currency,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        shareToken,
      })
      .returning();
    const dto = toTripDto(row);
    this.bus.publish(TRIPS_CHANNEL, { type: "created", trip: dto });
    return dto;
  }

  /**
   * 重新解析目的城市（自愈：创建时网络失败 / 引擎误判——如国内行程被标成海外）。
   * 允许纠正 provider：错引擎的中文 POI 搜索会错到别的城市（如「西湖」→福建），
   * 危害远大于两坐标系 ~500m 的偏移；切换后用新引擎重算全部天的交通段。
   */
  async reResolveCity(tripId: string) {
    const trip = await this.getTrip(tripId);
    // 重解析全部途经地（stops[0] 即原 destinationCity，单城市行为不变）；镜像列同步 stops[0]
    const resolved = await this.resolveStops(this.stopsOfTrip(trip).map((s) => s.name));
    const providerChanged = resolved.provider !== trip.geoProvider;
    await this.db
      .update(schema.trips)
      .set({
        geoProvider: resolved.provider,
        cityAdcode: resolved.provider === "amap" ? resolved.adcode : null,
        cityCenterLng: resolved.center ? resolved.center.lng : null,
        cityCenterLat: resolved.center ? resolved.center.lat : null,
        stops: resolved.stops,
        currency: resolved.currency,
        updatedAt: new Date(),
      })
      .where(eq(schema.trips.id, tripId));
    if (providerChanged) {
      await this.recalcAllDayLegs(tripId);
    }
    await this.publishBundle(tripId);
    const row = await this.getTrip(tripId);
    return toTripDto(row);
  }

  async listTrips() {
    const rows = await this.db.select().from(schema.trips).orderBy(asc(schema.trips.createdAt));
    return rows.map(toTripDto);
  }

  /**
   * 更新行程字段（PATCH /api/trips/:tripId 与 MCP set_start_date / set_end_date）。
   * startDate（出发日期）/ endDate（结束日期）：null = 清除。天标签由 startDate 驱动（清除退化为「Day N」）。
   * 已知行为（低成本方案，刻意不做联动校验）：startDate 与 endDate 互不联动——不强制 endDate ≥ startDate；
   * 天数口径（getTripDayCount / getBudgetSummary / selectHotel 上界）要求两者同时非空且区间为正才按日期区间计，
   * 只设一个或区间倒置时自动回退到已建天数兜底，不会产生破坏性的天数变化。
   */
  async updateTrip(tripId: string, input: UpdateTripInput) {
    await this.getTrip(tripId);
    const patch: Partial<typeof schema.trips.$inferInsert> = {};
    if (input.startDate !== undefined) patch.startDate = input.startDate ?? null;
    if (input.endDate !== undefined) patch.endDate = input.endDate ?? null;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await this.db.update(schema.trips).set(patch).where(eq(schema.trips.id, tripId));
      await this.publishBundle(tripId);
    }
    return toTripDto(await this.getTrip(tripId));
  }

  async getTrip(tripId: string) {
    const [row] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    if (!row) throw new ServiceError(404, `trip ${tripId} not found`);
    return row;
  }

  async getTripByShareToken(token: string) {
    const [row] = await this.db.select().from(schema.trips).where(eq(schema.trips.shareToken, token));
    if (!row) throw new ServiceError(404, "share link not found");
    return row;
  }

  async deleteTrip(tripId: string) {
    await this.db.delete(schema.trips).where(eq(schema.trips.id, tripId));
    this.bus.publish(tripChannel(tripId), { type: "deleted", tripId });
    this.bus.publish(TRIPS_CHANNEL, { type: "deleted", tripId });
  }

  // ---------- bundle ----------

  async getBundle(tripId: string): Promise<TripBundle> {
    const trip = await this.getTrip(tripId);
    const [days, places, entries, legs, hotels] = await Promise.all([
      this.db.select().from(schema.days).where(eq(schema.days.tripId, tripId)).orderBy(asc(schema.days.dayIndex)),
      this.db.select().from(schema.places).where(eq(schema.places.tripId, tripId)),
      this.db.select().from(schema.entries).where(eq(schema.entries.tripId, tripId)).orderBy(asc(schema.entries.position)),
      this.db.select().from(schema.transportLegs).where(eq(schema.transportLegs.tripId, tripId)),
      this.db.select().from(schema.hotelCandidates).where(eq(schema.hotelCandidates.tripId, tripId)),
    ]);
    return {
      trip: toTripDto(trip),
      days: days.map(toDayDto),
      places: places.map(toPlaceDto),
      entries: entries.map(toEntryDto),
      legs: legs.map(toLegDto),
      hotelCandidates: hotels.map(toHotelDto),
    };
  }

  /** 变更后广播全量 bundle（单机行程数据量小，全量最简单可靠） */
  private async publishBundle(tripId: string) {
    const bundle = await this.getBundle(tripId);
    this.bus.publish(tripChannel(tripId), { type: "bundle", bundle });
  }

  private async touchTrip(tripId: string) {
    await this.db.update(schema.trips).set({ updatedAt: new Date() }).where(eq(schema.trips.id, tripId));
  }

  // ---------- places ----------

  /**
   * 建 POI。actor=agent 时校验坐标必须落在途经地附近（防 LLM 编造经纬度）：
   * 单城市退化为「距 stops[0]（= 目的城市中心）≤ 单中心阈值」，与 stops 特性前完全一致；
   * 多城市改「距任一 stop.center ≤ 多中心阈值（min 距离）」。agent 被拒时应引导其先调 search_poi 拿真实坐标。
   * cityName 自动填充：显式传 > 距最近 stop.center ≤150km 归该 stop > null（归属未知不阻断）。
   * 状态机：agent 建的默认 candidate（候选池）；human 手动建的默认 locked（确认要去）。
   * 判重（REST / MCP 共用此入口）：
   * - amapPoiId 精确匹配 → 幂等返回已有 place，并补齐其缺失的详情字段（不覆盖已有值，不限状态）；
   * - 规范化名称匹配（完全相等 / 互为前缀，见 placeNameMatch）且坐标距离 ≤200m → 抛
   *   PossibleDuplicateError（409 疑似重复信号）：不插新行也不回填，是否同一家交给调用方判断；
   * - input.allowDuplicate=true → 跳过模糊判重，直接创建（amapPoiId 幂等不受其影响）。
   */
  async createPlace(tripId: string, input: CreatePlaceInput, actor: Actor) {
    const trip = await this.getTrip(tripId);
    const stops = this.stopsOfTrip(trip);
    // 距最近途经地中心的距离（无可用中心时为 null：创建时网络失败/自愈前的行程不校验）
    let nearest: { name: string; distKm: number } | null = null;
    for (const stop of stops) {
      if (!stop.center) continue;
      const distKm = haversineM(stop.center, input.location) / 1000;
      if (!nearest || distKm < nearest.distKm) nearest = { name: stop.name, distKm };
    }
    if (actor === "agent" && nearest) {
      const singleMaxKm = AGENT_PLACE_MAX_CITY_DIST_KM[trip.geoProvider as GeoProviderName] ?? 300;
      const maxKm =
        stops.length > 1 ? Math.max(singleMaxKm, AGENT_PLACE_MULTI_STOP_MIN_DIST_KM) : singleMaxKm;
      if (nearest.distKm > maxKm) {
        throw new ServiceError(
          422,
          `坐标距 ${nearest.name} 市中心 ${Math.round(nearest.distKm)} 公里，超出合理范围（${maxKm}km）。` +
            `请先调用 search_poi 查询真实地点，使用返回的 location，不要自行填写或编造经纬度。`,
        );
      }
    }
    const cityName = input.cityName ?? (nearest && nearest.distKm <= PLACE_CITY_ASSIGN_MAX_DIST_KM ? nearest.name : null);
    const existingPlaces = await this.db.select().from(schema.places).where(eq(schema.places.tripId, tripId));
    // amapPoiId 精确匹配 → 幂等返回已有 place 并补齐缺失字段（不插新行、不报疑似重复）
    const exactDup = input.amapPoiId ? existingPlaces.find((p) => p.amapPoiId === input.amapPoiId) : undefined;
    if (exactDup) return this.backfillExistingPlace(tripId, exactDup, input, cityName);
    // 模糊判重（规范化名称相等 / 互为前缀 + 坐标距离 ≤200m）→ 疑似重复信号，不静默合并：
    // 是否同一家由调用方判断（agent 用 update_place 补全 / 人类在确认框里决定）；
    // allowDuplicate=true 跳过此判重强制新建（同名分店、确认过的相邻不同点）
    if (!input.allowDuplicate) {
      const normalizedName = normalizePlaceName(input.name);
      const fuzzyDup = existingPlaces.find(
        (p) =>
          placeNameMatch(normalizePlaceName(p.name), normalizedName) &&
          haversineM({ lng: Number(p.lng), lat: Number(p.lat) }, input.location) <= PLACE_DEDUP_MAX_DIST_M,
      );
      if (fuzzyDup) throw new PossibleDuplicateError(toPlaceDto(fuzzyDup));
    }
    const [row] = await this.db
      .insert(schema.places)
      .values({
        id: uuid(),
        tripId,
        name: input.name,
        category: input.category,
        lng: input.location.lng,
        lat: input.location.lat,
        address: input.address ?? null,
        website: input.website ?? null,
        bookingUrl: input.bookingUrl ?? null,
        phone: input.phone ?? null,
        cityName,
        amapPoiId: input.amapPoiId ?? null,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl ?? null,
        notes: input.notes ?? null,
        durationMin: input.durationMin ?? null,
        visitDurationMin: input.visitDurationMin ?? null,
        priceCny: input.priceCny != null ? Math.round(input.priceCny) : null,
        bookingInfo: input.bookingInfo ?? null,
        openingHours: input.openingHours ?? null,
        bookingStatus: input.bookingStatus ?? "none",
        createdBy: actor,
        status: input.status ?? (actor === "human" ? "locked" : "candidate"),
      })
      .returning();
    await this.touchTrip(tripId);
    await this.publishBundle(tripId);
    return toPlaceDto(row);
  }

  /**
   * 幂等命中（amapPoiId 精确匹配）时复用已有 place：补齐其空字段（绝不覆盖已有值）。
   * 不限 locked：agent 可补全任何地点的信息字段（补官网/改备注等）。
   */
  private async backfillExistingPlace(
    tripId: string,
    dup: typeof schema.places.$inferSelect,
    input: CreatePlaceInput,
    cityName: string | null,
  ) {
    const patch: Partial<typeof schema.places.$inferInsert> = {};
    if (dup.address == null && input.address != null) patch.address = input.address;
    if (dup.website == null && input.website != null) patch.website = input.website;
    if (dup.bookingUrl == null && input.bookingUrl != null) patch.bookingUrl = input.bookingUrl;
    if (dup.phone == null && input.phone != null) patch.phone = input.phone;
    if (dup.cityName == null && cityName != null) patch.cityName = cityName;
    if (dup.amapPoiId == null && input.amapPoiId != null) patch.amapPoiId = input.amapPoiId;
    if (dup.sourceUrl == null && input.sourceUrl != null) patch.sourceUrl = input.sourceUrl;
    if (dup.notes == null && input.notes != null) patch.notes = input.notes;
    if (dup.durationMin == null && input.durationMin != null) patch.durationMin = input.durationMin;
    if (dup.visitDurationMin == null && input.visitDurationMin != null) {
      patch.visitDurationMin = input.visitDurationMin;
    }
    if (dup.priceCny == null && input.priceCny != null) patch.priceCny = Math.round(input.priceCny);
    if (dup.bookingInfo == null && input.bookingInfo != null) patch.bookingInfo = input.bookingInfo;
    if (dup.openingHours == null && input.openingHours != null) patch.openingHours = input.openingHours;
    if (Object.keys(patch).length > 0) {
      const [row] = await this.db
        .update(schema.places)
        .set(patch)
        .where(eq(schema.places.id, dup.id))
        .returning();
      await this.touchTrip(tripId);
      await this.publishBundle(tripId);
      return toPlaceDto(row);
    }
    return toPlaceDto(dup);
  }

  /**
   * 删除兜底（M54 锁定简化）：locked 不再拦截 agent——信息字段随时可改；
   * 仅「已排进行程（有 entry 引用）的地点」agent 不可直接删除，须先移出行程
   * （remove_entry 逐条移出 / 请用户在界面上「移出行程」）。人类（REST 入口）不受限。
   */
  private async assertNotScheduledForAgent(
    place: { id: string; name: string },
    actor: Actor,
  ) {
    if (actor !== "agent") return;
    const refs = await this.db
      .select({ id: schema.entries.id })
      .from(schema.entries)
      .where(
        or(
          eq(schema.entries.placeId, place.id),
          eq(schema.entries.fromPlaceId, place.id),
          eq(schema.entries.toPlaceId, place.id),
        ),
      )
      .limit(1);
    if (refs.length > 0) {
      throw new ServiceError(
        409,
        `「${place.name}」已排进行程，不可直接删除。请先用 remove_entry 移出引用它的日程条目（或请用户在界面上「移出行程」），再删除。`,
      );
    }
  }

  /** 加入/移出行程（用户确认候选 → locked=已加入行程；退回候选池 → candidate）。UI 话术为「加入行程/移出行程」 */
  async setPlaceStatus(placeId: string, status: PlaceStatus) {
    const [existing] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!existing) throw new ServiceError(404, `place ${placeId} not found`);
    const [row] = await this.db
      .update(schema.places)
      .set({ status })
      .where(eq(schema.places.id, placeId))
      .returning();
    await this.touchTrip(existing.tripId);
    await this.publishBundle(existing.tripId);
    return toPlaceDto(row);
  }

  /** M54 锁定简化：agent 可改任何地点（含 locked）的信息字段——补官网/改备注/调价等，不再有锁定拦截 */
  async updatePlace(placeId: string, input: UpdatePlaceInput) {
    const [existing] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!existing) throw new ServiceError(404, `place ${placeId} not found`);
    const patch: Partial<typeof schema.places.$inferInsert> = {};
    if (input.name != null) patch.name = input.name;
    if (input.category != null) patch.category = input.category;
    if (input.location != null) {
      patch.lng = input.location.lng;
      patch.lat = input.location.lat;
    }
    if (input.address !== undefined) patch.address = input.address ?? null;
    if (input.website !== undefined) patch.website = input.website ?? null;
    if (input.bookingUrl !== undefined) patch.bookingUrl = input.bookingUrl ?? null;
    if (input.phone !== undefined) patch.phone = input.phone ?? null;
    if (input.cityName !== undefined) patch.cityName = input.cityName ?? null;
    if (input.amapPoiId !== undefined) patch.amapPoiId = input.amapPoiId ?? null;
    if (input.sourceUrl !== undefined) patch.sourceUrl = input.sourceUrl ?? null;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;
    if (input.durationMin !== undefined) patch.durationMin = input.durationMin ?? null;
    if (input.visitDurationMin !== undefined) patch.visitDurationMin = input.visitDurationMin ?? null;
    if (input.priceCny !== undefined)
      patch.priceCny = input.priceCny != null ? Math.round(input.priceCny) : null;
    if (input.bookingInfo !== undefined) patch.bookingInfo = input.bookingInfo ?? null;
    if (input.openingHours !== undefined) patch.openingHours = input.openingHours ?? null;
    if (input.bookingStatus !== undefined) patch.bookingStatus = input.bookingStatus;
    if (input.status !== undefined) patch.status = input.status;
    const [row] = await this.db.update(schema.places).set(patch).where(eq(schema.places.id, placeId)).returning();
    await this.touchTrip(existing.tripId);
    await this.publishBundle(existing.tripId);
    return toPlaceDto(row);
  }

  async removePlace(placeId: string, actor: Actor = "human") {
    const [existing] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!existing) throw new ServiceError(404, `place ${placeId} not found`);
    await this.assertNotScheduledForAgent(existing, actor);
    const tripId = existing.tripId;
    // 删的是已选定酒店 → 候选行随 place 级联删除，所有天的锚点都要重算
    const linkedHotels = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(eq(schema.hotelCandidates.placeId, placeId));
    const wasSelectedHotel = linkedHotels.some((h) => h.selected);
    // 级联删 entries/legs（placeId 引用 FK on delete cascade；transit 的 from/toPlaceId 引用 set null），受影响的天需要重算 legs
    const affectedDays = await this.db
      .selectDistinct({ dayId: schema.entries.dayId })
      .from(schema.entries)
      .where(
        or(
          eq(schema.entries.placeId, placeId),
          eq(schema.entries.fromPlaceId, placeId),
          eq(schema.entries.toPlaceId, placeId),
        ),
      );
    await this.db.delete(schema.places).where(eq(schema.places.id, placeId));
    await this.touchTrip(tripId);
    if (wasSelectedHotel) {
      await this.syncSelectedHotelMirror(tripId);
      await this.recalcAllDayLegs(tripId);
    } else {
      await Promise.all(affectedDays.map(({ dayId }) => this.recalcDayLegs(tripId, dayId)));
    }
    await this.publishBundle(tripId);
  }

  /**
   * 移出行程（M20：POST /api/places/:id/unschedule）：撤销该地点的全部日程 entry
   * （place 退回候选态，不删 place 本身，transit 起讫点对其的引用保留）。
   * 受影响天 normalizePositions 填洞 + 重算 legs（首尾锚定/交通段按 recalcDayLegs 现有不变式重算）。
   */
  async unschedulePlace(placeId: string) {
    const [existing] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!existing) throw new ServiceError(404, `place ${placeId} not found`);
    const entryRows = await this.db
      .select()
      .from(schema.entries)
      .where(and(eq(schema.entries.placeId, placeId), eq(schema.entries.entryType, "place")));
    const dayIds = [...new Set(entryRows.map((e) => e.dayId))];
    if (entryRows.length > 0) {
      await this.db.delete(schema.entries).where(
        inArray(
          schema.entries.id,
          entryRows.map((e) => e.id),
        ),
      );
    }
    if (existing.status !== "candidate") {
      await this.db.update(schema.places).set({ status: "candidate" }).where(eq(schema.places.id, placeId));
    }
    await this.touchTrip(existing.tripId);
    for (const dayId of dayIds) {
      await this.normalizePositions(dayId);
      await this.recalcDayLegs(existing.tripId, dayId);
    }
    await this.publishBundle(existing.tripId);
    return { removedEntries: entryRows.length };
  }

  // ---------- days & entries ----------

  /** 惰性建 day：首次往某天加 entry 时创建 */
  private async ensureDay(tripId: string, dayIndex: number) {
    const [existing] = await this.db
      .select()
      .from(schema.days)
      .where(and(eq(schema.days.tripId, tripId), eq(schema.days.dayIndex, dayIndex)));
    if (existing) return existing;
    const [row] = await this.db
      .insert(schema.days)
      .values({ id: uuid(), tripId, dayIndex })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [race] = await this.db
      .select()
      .from(schema.days)
      .where(and(eq(schema.days.tripId, tripId), eq(schema.days.dayIndex, dayIndex)));
    return race;
  }

  /**
   * 排入某天。entryType=place（默认）：placeId 必填且必须属于本行程。
   * entryType=transit（大交通节点）：起讫点各给 fromPlaceId/fromName、toPlaceId/toName 之一；
   * 起讫引用 place 时 recalcDayLegs 走真实坐标参与锚定（到达日起点 / 离开日收口），纯文本则不产生交通段。
   * transit 的 startTime 缺省取 departTime（时间轴排序用）。
   */
  async addEntry(tripId: string, input: AddEntryInput) {
    await this.getTrip(tripId);
    const entryType = input.entryType ?? "place";
    if (entryType === "place") {
      if (!input.placeId) throw new ServiceError(422, "entryType=place 时必须提供 placeId");
      // 与 PATCH /entries/:id 对称：place entry 不接受 transit 字段（拒绝而非静默丢弃）
      const transitFields = [
        input.departTime,
        input.arriveTime,
        input.fromPlaceId,
        input.toPlaceId,
        input.fromName,
        input.toName,
        input.transitMode,
      ];
      if (transitFields.some((v) => v != null)) {
        throw new ServiceError(
          422,
          "entryType=place 不接受 departTime/arriveTime/fromPlaceId/toPlaceId/fromName/toName/transitMode",
        );
      }
      const [place] = await this.db
        .select()
        .from(schema.places)
        .where(and(eq(schema.places.id, input.placeId), eq(schema.places.tripId, tripId)));
      if (!place) throw new ServiceError(404, `place ${input.placeId} not found in trip ${tripId}`);
    } else {
      if (!input.fromPlaceId && !input.fromName) {
        throw new ServiceError(422, "transit entry 需要 fromPlaceId 或 fromName（起点）");
      }
      if (!input.toPlaceId && !input.toName) {
        throw new ServiceError(422, "transit entry 需要 toPlaceId 或 toName（讫点）");
      }
      for (const pid of [input.fromPlaceId, input.toPlaceId]) {
        if (!pid) continue;
        const [place] = await this.db
          .select({ id: schema.places.id })
          .from(schema.places)
          .where(and(eq(schema.places.id, pid), eq(schema.places.tripId, tripId)));
        if (!place) throw new ServiceError(404, `place ${pid} not found in trip ${tripId}`);
      }
    }
    const day = await this.ensureDay(tripId, input.dayIndex);
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, day.id))
      .orderBy(asc(schema.entries.position));
    const pos =
      input.position == null ? entries.length : Math.max(0, Math.min(input.position, entries.length));
    const entryId = uuid();
    this.db.transaction((tx) => {
      // (dayId, position) 唯一索引逐行检查，+1 位移会与未更新的行相撞：
      // 先把受影响行挪到安全区（+10001），插入后归一化回 0..n（同 moveEntry 同天分支的模式）
      tx.update(schema.entries)
        .set({ position: sql`${schema.entries.position} + 10001` })
        .where(and(eq(schema.entries.dayId, day.id), sql`${schema.entries.position} >= ${pos}`))
        .run();
      tx.insert(schema.entries).values({
        id: entryId,
        tripId,
        dayId: day.id,
        entryType,
        placeId: entryType === "place" ? input.placeId! : null,
        position: pos,
        startTime: input.startTime ?? (entryType === "transit" ? (input.departTime ?? null) : null),
        note: input.note ?? null,
        departTime: entryType === "transit" ? (input.departTime ?? null) : null,
        arriveTime: entryType === "transit" ? (input.arriveTime ?? null) : null,
        fromPlaceId: entryType === "transit" ? (input.fromPlaceId ?? null) : null,
        toPlaceId: entryType === "transit" ? (input.toPlaceId ?? null) : null,
        fromName: entryType === "transit" ? (input.fromName ?? null) : null,
        toName: entryType === "transit" ? (input.toName ?? null) : null,
        transitMode: entryType === "transit" ? (input.transitMode ?? null) : null,
      }).run();
      this.normalizePositionsTx(tx, day.id);
    });
    await this.touchTrip(tripId);
    await this.recalcDayLegs(tripId, day.id);
    await this.publishBundle(tripId);
    return { entryId, dayId: day.id, position: pos };
  }

  /**
   * 编辑 entry（PATCH /api/entries/:id 与 MCP update_entry）。
   * startTime/durationMin/note 两类通用；transit 时间/起讫字段仅 transit entry 可改。
   * transit 改 departTime 而未显式给 startTime 时同步 startTime（保持时间轴排序语义）。
   */
  async updateEntry(entryId: string, input: UpdateEntryInput) {
    const [entry] = await this.db.select().from(schema.entries).where(eq(schema.entries.id, entryId));
    if (!entry) throw new ServiceError(404, `entry ${entryId} not found`);
    const transitFields = [
      input.departTime,
      input.arriveTime,
      input.fromPlaceId,
      input.toPlaceId,
      input.fromName,
      input.toName,
      input.transitMode,
    ];
    if (entry.entryType !== "transit" && transitFields.some((v) => v !== undefined)) {
      throw new ServiceError(422, "departTime/arriveTime/fromPlaceId/toPlaceId/fromName/toName/transitMode 仅 transit entry 可编辑");
    }
    for (const pid of [input.fromPlaceId, input.toPlaceId]) {
      if (!pid) continue;
      const [place] = await this.db
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(and(eq(schema.places.id, pid), eq(schema.places.tripId, entry.tripId)));
      if (!place) throw new ServiceError(404, `place ${pid} not found in trip ${entry.tripId}`);
    }
    const patch: Partial<typeof schema.entries.$inferInsert> = {};
    if (input.startTime !== undefined) patch.startTime = input.startTime ?? null;
    if (input.note !== undefined) patch.note = input.note ?? null;
    if (input.durationMin !== undefined) patch.durationMin = input.durationMin ?? null;
    if (entry.entryType === "transit") {
      if (input.departTime !== undefined) {
        patch.departTime = input.departTime ?? null;
        if (input.startTime === undefined) patch.startTime = input.departTime ?? null;
      }
      if (input.arriveTime !== undefined) patch.arriveTime = input.arriveTime ?? null;
      if (input.fromPlaceId !== undefined) patch.fromPlaceId = input.fromPlaceId ?? null;
      if (input.toPlaceId !== undefined) patch.toPlaceId = input.toPlaceId ?? null;
      if (input.fromName !== undefined) patch.fromName = input.fromName ?? null;
      if (input.toName !== undefined) patch.toName = input.toName ?? null;
      if (input.transitMode !== undefined) patch.transitMode = input.transitMode ?? null;
      // 起讫不变量与 add 侧一致：patch 合并后起点/讫点各自至少留一个（place 引用或自由文本）
      const effective = <K extends "fromPlaceId" | "toPlaceId" | "fromName" | "toName">(key: K) =>
        key in patch ? (patch[key] as string | null) : entry[key];
      if (!effective("fromPlaceId") && !effective("fromName")) {
        throw new ServiceError(422, "transit entry 的起点不能全清：至少保留 fromPlaceId 或 fromName");
      }
      if (!effective("toPlaceId") && !effective("toName")) {
        throw new ServiceError(422, "transit entry 的讫点不能全清：至少保留 toPlaceId 或 toName");
      }
    }
    if (Object.keys(patch).length === 0) {
      const [row] = await this.db.select().from(schema.entries).where(eq(schema.entries.id, entryId));
      return toEntryDto(row);
    }
    const [row] = await this.db
      .update(schema.entries)
      .set(patch)
      .where(eq(schema.entries.id, entryId))
      .returning();
    await this.touchTrip(entry.tripId);
    await this.recalcDayLegs(entry.tripId, entry.dayId);
    await this.publishBundle(entry.tripId);
    return toEntryDto(row);
  }

  async removeEntry(entryId: string) {
    const [entry] = await this.db.select().from(schema.entries).where(eq(schema.entries.id, entryId));
    if (!entry) throw new ServiceError(404, `entry ${entryId} not found`);
    await this.db.delete(schema.entries).where(eq(schema.entries.id, entryId));
    await this.normalizePositions(entry.dayId);
    await this.touchTrip(entry.tripId);
    await this.recalcDayLegs(entry.tripId, entry.dayId);
    await this.publishBundle(entry.tripId);
  }

  async moveEntry(entryId: string, dayIndex: number, position: number) {
    const [entry] = await this.db.select().from(schema.entries).where(eq(schema.entries.id, entryId));
    if (!entry) throw new ServiceError(404, `entry ${entryId} not found`);
    const day = await this.ensureDay(entry.tripId, dayIndex);
    if (day.id === entry.dayId) {
      this.db.transaction((tx) => {
        // 先挪到安全位置避免唯一约束冲突
        tx.update(schema.entries)
          .set({ position: sql`${schema.entries.position} + 10000` })
          .where(eq(schema.entries.dayId, day.id))
          .run();
        tx.update(schema.entries).set({ position }).where(eq(schema.entries.id, entryId)).run();
        this.normalizePositionsTx(tx, day.id);
      });
    } else {
      await this.db.delete(schema.entries).where(eq(schema.entries.id, entryId));
      await this.normalizePositions(entry.dayId);
      const entries = await this.db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.dayId, day.id))
        .orderBy(asc(schema.entries.position));
      const pos = Math.max(0, Math.min(position, entries.length));
      // 同样的唯一索引撞行问题：事务内先挪安全区再归一化
      this.db.transaction((tx) => {
        tx.update(schema.entries)
          .set({ position: sql`${schema.entries.position} + 10001` })
          .where(and(eq(schema.entries.dayId, day.id), sql`${schema.entries.position} >= ${pos}`))
          .run();
        tx.insert(schema.entries).values({
          id: entryId,
          tripId: entry.tripId,
          dayId: day.id,
          placeId: entry.placeId,
          entryType: entry.entryType,
          position: pos,
          startTime: entry.startTime,
          durationMin: entry.durationMin,
          note: entry.note,
          departTime: entry.departTime,
          arriveTime: entry.arriveTime,
          fromPlaceId: entry.fromPlaceId,
          toPlaceId: entry.toPlaceId,
          fromName: entry.fromName,
          toName: entry.toName,
          transitMode: entry.transitMode,
        }).run();
        this.normalizePositionsTx(tx, day.id);
      });
    }
    await this.touchTrip(entry.tripId);
    // 跨天移动时两天都要重算，并行（外部路由并发由 routeLimits 按 provider 收口）
    await Promise.all([
      this.recalcDayLegs(entry.tripId, day.id),
      day.id !== entry.dayId ? this.recalcDayLegs(entry.tripId, entry.dayId) : Promise.resolve(),
    ]);
    await this.publishBundle(entry.tripId);
  }

  /** 整天重排（人拖拽 or agent reorder_day） */
  async reorderDay(tripId: string, dayIndex: number, entryIds: string[]) {
    const day = await this.ensureDay(tripId, dayIndex);
    const entries = await this.db.select().from(schema.entries).where(eq(schema.entries.dayId, day.id));
    const currentIds = new Set(entries.map((e) => e.id));
    for (const id of entryIds) {
      if (!currentIds.has(id)) throw new ServiceError(422, `entry ${id} 不属于 day ${dayIndex}`);
    }
    if (entryIds.length !== entries.length) {
      throw new ServiceError(422, `entryIds 必须包含 day ${dayIndex} 的全部 ${entries.length} 个 entry`);
    }
    this.db.transaction((tx) => {
      tx.update(schema.entries)
        .set({ position: sql`${schema.entries.position} + 10000` })
        .where(eq(schema.entries.dayId, day.id))
        .run();
      for (let i = 0; i < entryIds.length; i++) {
        tx.update(schema.entries).set({ position: i }).where(eq(schema.entries.id, entryIds[i])).run();
      }
    });
    await this.touchTrip(tripId);
    await this.recalcDayLegs(tripId, day.id);
    await this.publishBundle(tripId);
  }

  private normalizePositions(dayId: string) {
    this.db.transaction((tx) => this.normalizePositionsTx(tx, dayId));
  }

  private normalizePositionsTx(tx: Tx, dayId: string) {
    const rows = tx
      .select({ id: schema.entries.id })
      .from(schema.entries)
      .where(eq(schema.entries.dayId, dayId))
      .orderBy(asc(schema.entries.position))
      .all();
    for (let i = 0; i < rows.length; i++) {
      tx.update(schema.entries).set({ position: i }).where(eq(schema.entries.id, rows[i].id)).run();
    }
  }

  // ---------- transport legs ----------

  /** 某晚（夜 = dayIndex 当晚）住宿的已选定酒店 placeId：checkInDay <= night < checkOutDay */
  private async getHotelPlaceIdForNight(tripId: string, night: number): Promise<string | null> {
    if (night < 1) return null;
    const selected = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(and(eq(schema.hotelCandidates.tripId, tripId), eq(schema.hotelCandidates.selected, true)));
    const hit = selected.find(
      (c) => c.checkInDay != null && c.checkOutDay != null && c.checkInDay <= night && night < c.checkOutDay,
    );
    return hit?.placeId ?? null;
  }

  /**
   * 某天的首/尾酒店锚点（多酒店模型）：
   * - 首锚点 = 前一晚住宿的酒店（缺省回退当晚酒店，如行程第 1 天先到酒店）
   * - 尾锚点 = 当晚住宿的酒店；仅最后一天（离店日不住宿）回退前一晚酒店。
   *   中间空洞夜不回退（不生成「返回酒店」段，避免行程中段凭空折返到已退房的酒店）
   * 换酒店日（旧酒店 checkOutDay = 当天 = 新酒店 checkInDay）：首 = 旧酒店，尾 = 新酒店。
   * 没有任何已选定酒店覆盖时两端都是 null（无锚点，保持现状）。
   */
  private async getDayHotelAnchors(
    tripId: string,
    dayIndex: number,
    lastDayIndex: number,
  ): Promise<{ startPlaceId: string | null; endPlaceId: string | null }> {
    const prev = await this.getHotelPlaceIdForNight(tripId, dayIndex - 1);
    const curr = await this.getHotelPlaceIdForNight(tripId, dayIndex);
    return {
      startPlaceId: prev ?? curr,
      endPlaceId: curr ?? (dayIndex >= lastDayIndex ? prev : null),
    };
  }

  /**
   * 路由调用（经全局限流器）：失败在限流器内退避重试一次（免费 OSRM 服按速率限流返回 429，
   * 需等限流窗口过去再试），仍失败才降级直线估算并告警（可观测：此前静默降级导致 polyline=null 无人察觉）。
   */
  private async routeWithRetry(
    routeLimit: ReturnType<typeof createLimiter>,
    geo: ReturnType<typeof getProvider>,
    a: LngLat,
    b: LngLat,
    mode: TransportMode,
    city?: string,
  ) {
    try {
      return await routeLimit(() => geo.route(a, b, mode, city));
    } catch {
      try {
        await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
        return await routeLimit(() => geo.route(a, b, mode, city));
      } catch (err) {
        console.warn(`[routing] route(${mode}) 重试仍失败，降级直线估算:`, (err as Error).message);
        return fallbackRoute(a, b, mode);
      }
    }
  }

  /**
   * 变更某天 entry / 换酒店后重算该天交通段。
   * 酒店锚点按天解析（见 getDayHotelAnchors）：普通日首尾同为当晚酒店，
   * 换酒店日首 = 旧酒店、尾 = 新酒店；当晚无覆盖的天不生成「返回酒店」段
   * （仅最后一天离店回退前一晚酒店），首尾都无覆盖则完全不锚定（仅景点间移动）。
   * transit entry（大交通）参与锚定：起讫引用行程内 place 时走真实坐标展开成端点节点；
   * 首个 entry 是带坐标的 transit 到达 → 替代酒店首锚点成为当天起点；
   * 末个 entry 是带坐标的 transit 离开 → 替代酒店尾锚点收口当天。
   * 同一 transit entry 的 from→to 节点间是大交通段本身：transitMode=drive（自驾城际段）走真实路由
   * 拿公路 polyline/里程（depart/arrive 时刻差仍是硬锚点时长，只缺时刻时用路由时长）；
   * 其余（航班/高铁/未指定）不调路由 provider，时长取 depart/arrive 差，polyline 为直线两点。
   * 手动 mode 覆盖（modeOverride）按端点配对保留，重算不冲掉。
   */
  async recalcDayLegs(tripId: string, dayId: string) {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    const geo = getProvider(trip?.geoProvider ?? "osm");
    const routeLimit = this.routeLimits[geo.name];
    const [day] = await this.db.select().from(schema.days).where(eq(schema.days.id, dayId));
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, dayId))
      .orderBy(asc(schema.entries.position));
    const anchors =
      day && entries.length > 0
        ? await this.getDayHotelAnchors(
            tripId,
            day.dayIndex,
            trip ? await this.getTripDayCount(trip) : day.dayIndex,
          )
        : { startPlaceId: null, endPlaceId: null };

    const placeIds = [
      ...new Set(
        [
          ...entries.flatMap((e) => [e.placeId, e.fromPlaceId, e.toPlaceId]),
          anchors.startPlaceId,
          anchors.endPlaceId,
        ].filter((x): x is string => x != null),
      ),
    ];
    const places = placeIds.length
      ? await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds))
      : [];
    const placeById = new Map(places.map((p) => [p.id, p]));
    const coordOfPlace = (pid: string | null): LngLat | null => {
      if (!pid) return null;
      const p = placeById.get(pid);
      return p ? { lng: Number(p.lng), lat: Number(p.lat) } : null;
    };

    // 端点链节点：entry（行程内）或 place（酒店首/尾锚点，换酒店日可不同）。
    // transit 节点带 transitEntryId/transitEndpoint 标记，用于识别大交通段本身。
    type ChainNode = {
      entryId: string | null;
      placeId: string | null;
      coord: LngLat;
      transitEntryId?: string;
      transitEndpoint?: "from" | "to";
    };
    const transitNodes = (e: (typeof entries)[number]): ChainNode[] => {
      const from = coordOfPlace(e.fromPlaceId);
      const to = coordOfPlace(e.toPlaceId);
      const nodes: ChainNode[] = [];
      if (from) nodes.push({ entryId: e.id, placeId: null, coord: from, transitEntryId: e.id, transitEndpoint: "from" });
      if (to && e.toPlaceId !== e.fromPlaceId) {
        nodes.push({ entryId: e.id, placeId: null, coord: to, transitEntryId: e.id, transitEndpoint: "to" });
      }
      return nodes;
    };
    const first = entries[0];
    const last = entries[entries.length - 1];
    const skipStartAnchor = first?.entryType === "transit" && transitNodes(first).length > 0;
    const skipEndAnchor = last?.entryType === "transit" && transitNodes(last).length > 0;

    const chain: ChainNode[] = [];
    if (anchors.startPlaceId && !skipStartAnchor) {
      const c = coordOfPlace(anchors.startPlaceId);
      if (c) chain.push({ entryId: null, placeId: anchors.startPlaceId, coord: c });
    }
    for (const e of entries) {
      if (e.entryType === "transit") {
        chain.push(...transitNodes(e));
      } else {
        const c = coordOfPlace(e.placeId);
        if (c) chain.push({ entryId: e.id, placeId: null, coord: c });
      }
    }
    if (anchors.endPlaceId && !skipEndAnchor) {
      const c = coordOfPlace(anchors.endPlaceId);
      if (c) chain.push({ entryId: null, placeId: anchors.endPlaceId, coord: c });
    }

    // 重算前收集手动覆盖：key = 端点配对（entry 或酒店 place）
    const endpointKey = (entryId: string | null, placeId: string | null) =>
      entryId ? `e:${entryId}` : `p:${placeId}`;
    const existingLegs = await this.db
      .select()
      .from(schema.transportLegs)
      .where(eq(schema.transportLegs.dayId, dayId));
    const overrides = new Map<string, TransportMode>();
    for (const leg of existingLegs) {
      if (leg.modeOverride) {
        overrides.set(
          `${endpointKey(leg.fromEntryId, leg.fromPlaceId)}->${endpointKey(leg.toEntryId, leg.toPlaceId)}`,
          leg.modeOverride as TransportMode,
        );
      }
    }

    const entryById = new Map(entries.map((e) => [e.id, e]));
    // 先并行计算所有段的路线（geo.route 走外部 API，是主要耗时；经全局限流器控制并发），
    // 算完再删旧插新——避免串行 await 把 N 段路线变成 N 倍单次延迟，也缩短库内无 legs 的窗口
    const legRows = await Promise.all(
      chain.slice(0, -1).map(async (from, i) => {
        const to = chain[i + 1];
        const a = from.coord;
        const b = to.coord;
        const override =
          overrides.get(`${endpointKey(from.entryId, from.placeId)}->${endpointKey(to.entryId, to.placeId)}`) ?? null;
        // 同一 transit entry 的 from→to：大交通段本身；transitMode=drive 走真实路由，其余不调路由 provider
        const isTransitRide =
          from.transitEntryId != null &&
          from.transitEntryId === to.transitEntryId &&
          from.transitEndpoint === "from" &&
          to.transitEndpoint === "to";
        let mode: TransportMode;
        let distanceM: number | null;
        let durationS: number | null;
        let polyline: LngLat[] | null;
        let transitDetail: TransitSegment[] | null = null;
        if (isTransitRide) {
          const entryRow = entryById.get(from.transitEntryId!);
          const fixedDurationS = transitDurationS(entryRow?.departTime ?? null, entryRow?.arriveTime ?? null);
          if (entryRow?.transitMode === "drive") {
            // 自驾城际段：真实公路 polyline/里程是环线体验本体；时刻差仍是硬锚点时长，缺时刻才用路由时长
            mode = override ?? "drive";
            const result = await this.routeWithRetry(routeLimit, geo, a, b, "drive", trip?.destinationCity);
            distanceM = result.distanceM;
            durationS = fixedDurationS ?? result.durationS;
            // 路由失败降级（polyline=null）时补直线两点，保证自驾段在地图上不消失
            polyline = result.polyline ?? [a, b];
          } else {
            mode = override ?? "transit";
            distanceM = Math.round(haversineM(a, b));
            durationS = fixedDurationS ?? Math.round((distanceM * 1.3) / 8.5);
            polyline = [a, b];
          }
        } else {
          // 自动交通方式三档：<2km 步行；2-6km 公交（amap 走真实公交路由；osm 无免费公交路由，
          // 保持估算口径但 mode 标 transit——市区中段标驾车会与游客实际不符）；>6km 驾车
          const dist = haversineM(a, b);
          mode = override ?? (dist < LEG_WALK_MAX_M ? "walk" : dist <= LEG_TRANSIT_MAX_M ? "transit" : "drive");
          const result = await this.routeWithRetry(routeLimit, geo, a, b, mode, trip?.destinationCity);
          mode = override ?? result.mode;
          distanceM = result.distanceM;
          durationS = result.durationS;
          polyline = result.polyline;
          // 公交分段详情：仅 amap 真实公交路由返回（osm 估算/降级缺省为 undefined → 存 null）
          transitDetail = result.transitDetail ?? null;
        }
        return {
          id: uuid(),
          tripId,
          dayId,
          fromEntryId: from.entryId,
          toEntryId: to.entryId,
          fromPlaceId: from.placeId,
          toPlaceId: to.placeId,
          seq: i,
          mode,
          modeOverride: override,
          distanceM,
          durationS,
          polyline,
          transitDetail,
          computedAt: new Date(),
        };
      }),
    );
    await this.db.delete(schema.transportLegs).where(eq(schema.transportLegs.dayId, dayId));
    for (const row of legRows) {
      await this.db.insert(schema.transportLegs).values(row);
    }
  }

  /**
   * 手动覆盖某段交通方式（mode=null 清除覆盖恢复自动）。
   * 覆盖存在 leg.modeOverride 上，recalcDayLegs 按端点配对保留。
   */
  async setLegMode(legId: string, mode: TransportMode | null) {
    const [leg] = await this.db.select().from(schema.transportLegs).where(eq(schema.transportLegs.id, legId));
    if (!leg) throw new ServiceError(404, `leg ${legId} not found`);
    await this.db
      .update(schema.transportLegs)
      .set({ modeOverride: mode })
      .where(eq(schema.transportLegs.id, legId));
    await this.touchTrip(leg.tripId);
    await this.recalcDayLegs(leg.tripId, leg.dayId);
    await this.publishBundle(leg.tripId);
  }

  /** 行程全部天的 legs 重算（换酒店/删除酒店地点用）。多天并行，外部路由并发由 routeLimits 全局收口 */
  private async recalcAllDayLegs(tripId: string) {
    const dayRows = await this.db
      .select({ id: schema.days.id })
      .from(schema.days)
      .where(eq(schema.days.tripId, tripId));
    await Promise.all(dayRows.map((d) => this.recalcDayLegs(tripId, d.id)));
  }

  // ---------- 顺路分析（MCP / 前端共用） ----------

  /**
   * 构建时长矩阵：优先该行程 provider 的真实驾车矩阵（drivingMatrixBatched 分批拼接，任意点数），
   * 经全局限流器收口；失败才整体降级「直线距离 × 1.3 ÷ 8.5m/s」估算。
   * estimated 标记是否走了估算——旧的 n>10 静默降级已移除，降级必须显式暴露给调用方（结果里标注）。
   */
  private async buildDurationMatrix(
    provider: string,
    points: LngLat[],
  ): Promise<{ matrix: number[][]; estimated: boolean }> {
    const n = points.length;
    if (n === 0) return { matrix: [], estimated: false };
    const geo = getProvider(provider);
    let matrix: number[][] | null = null;
    try {
      matrix = await drivingMatrixBatched(geo, points, (task) => this.routeLimits[geo.name](task));
    } catch (err) {
      console.warn(`[routing] drivingMatrix failed, fallback to haversine:`, (err as Error).message);
    }
    if (matrix && matrix.length === n) return { matrix, estimated: false };
    // 直线距离 × 1.3 道路系数 / 8.5 m/s 车速
    return {
      matrix: points.map((a) => points.map((b) => Math.round((haversineM(a, b) * 1.3) / 8.5))),
      estimated: true,
    };
  }

  /**
   * 重排建议（不落库）：按天取酒店锚点——同酒店往返按环路优化，换酒店日按「旧酒店→…→新酒店」定端路径优化，无锚点保持首点为起点。
   *  硬锚点不参与重排、保持原位：transit entry（大交通时刻固定）+ 带 startTime 的 place entry
   * （定时票/预约餐厅等已确认时间，重排不得打乱）；仅「无 startTime 的 place entry」参与优化。
   *  返回 suggestedStartTimes：按新顺序从 09:00 顺推的重算时间轴（硬锚点保留原时刻），
   *  应用重排（reorder_day）后按它 update_entry 写回 startTime，时间轴才不自相矛盾。
   */
  async suggestDayOrder(tripId: string, dayIndex: number) {
    const trip = await this.getTrip(tripId);
    const day = await this.ensureDay(tripId, dayIndex);
    const allEntries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, day.id))
      .orderBy(asc(schema.entries.position));
    // 可移动 = place entry 且未定 startTime；transit 与定时点为硬锚点
    const isMovable = (e: (typeof allEntries)[number]) =>
      e.entryType !== "transit" && e.placeId != null && e.startTime == null;
    const entries = allEntries.filter(isMovable);
    const pinnedTimedCount = allEntries.filter(
      (e) => e.entryType !== "transit" && e.placeId != null && e.startTime != null,
    ).length;
    if (entries.length < 2) {
      throw new ServiceError(
        422,
        `day ${dayIndex} 只有 ${entries.length} 个可移动地点（<2），无需重排` +
          `（带 startTime 的定时点与大交通为硬锚点，不参与重排）`,
      );
    }
    // place 加载覆盖全部 place entry（含硬锚点）：时间轴顺推需要它们的名称/停留时长/坐标
    const placeIds = [
      ...new Set(
        allEntries.map((e) => e.placeId).filter((x): x is string => x != null),
      ),
    ];
    const places = await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds));
    const placeById = new Map(places.map((p) => [p.id, p]));
    const entryCoords = entries.map((e) => {
      const p = placeById.get(e.placeId!)!;
      return { lng: Number(p.lng), lat: Number(p.lat) };
    });
    const anchors = await this.getDayHotelAnchors(tripId, dayIndex, await this.getTripDayCount(trip));
    const anchorCoord = new Map<string, LngLat>();
    for (const pid of new Set(
      [anchors.startPlaceId, anchors.endPlaceId].filter((x): x is string => x != null),
    )) {
      const p = placeById.get(pid) ?? (await this.db.select().from(schema.places).where(eq(schema.places.id, pid)))[0];
      if (p) anchorCoord.set(pid, { lng: Number(p.lng), lat: Number(p.lat) });
    }
    const startCoord = anchors.startPlaceId ? (anchorCoord.get(anchors.startPlaceId) ?? null) : null;
    const endCoord = anchors.endPlaceId ? (anchorCoord.get(anchors.endPlaceId) ?? null) : null;
    const hotelAnchored = startCoord != null || endCoord != null;
    // 换酒店日：首（旧酒店）≠ 尾（新酒店）；中间空洞夜可能只有首锚点（尾=null），此时按环路优化
    const switchDay =
      anchors.startPlaceId != null && anchors.endPlaceId != null && anchors.startPlaceId !== anchors.endPlaceId;

    let optimizedIdx: number[]; // entries（可移动）数组的下标顺序
    let before: number;
    let after: number;
    // 优化用的坐标/矩阵与可移动 entry 的矩阵下标映射（时间轴顺推时取真实段时长用）
    let matrix: number[][];
    let matrixEstimated = false;
    let matrixIdxOfEntry = new Map<string, number>(); // entryId → matrix 下标
    let anchorStartMatrixIdx: number | null = null; // 酒店首锚点在矩阵里的下标
    if (hotelAnchored && startCoord && endCoord && switchDay) {
      // 定端路径：[旧酒店, ...entries, 新酒店]，下标 0 / n-1 固定
      const coords = [startCoord, ...entryCoords, endCoord];
      ({ matrix, estimated: matrixEstimated } = await this.buildDurationMatrix(trip.geoProvider, coords));
      const path = optimizePathOrder(matrix); // [0, ...perm, n-1]
      optimizedIdx = path.slice(1, -1).map((i) => i - 1);
      const pathCost = (order: number[]): number => {
        let sum = 0;
        const seq = [0, ...order.map((i) => i + 1), coords.length - 1];
        for (let i = 0; i + 1 < seq.length; i++) sum += matrix[seq[i]][seq[i + 1]];
        return sum;
      };
      before = pathCost(entries.map((_, i) => i));
      after = pathCost(optimizedIdx);
      matrixIdxOfEntry = new Map(entries.map((e, i) => [e.id, i + 1]));
      anchorStartMatrixIdx = 0;
    } else if (hotelAnchored && startCoord) {
      // 环路：[酒店, ...entries, 酒店]，下标 0 = 酒店
      const coords = [startCoord, ...entryCoords];
      ({ matrix, estimated: matrixEstimated } = await this.buildDurationMatrix(trip.geoProvider, coords));
      const loop = optimizeLoopOrder(matrix); // [0, ...perm, 0]
      optimizedIdx = loop.slice(1, -1).map((i) => i - 1);
      const loopCost = (order: number[]): number => {
        let sum = 0;
        const seq = [0, ...order.map((i) => i + 1), 0];
        for (let i = 0; i + 1 < seq.length; i++) sum += matrix[seq[i]][seq[i + 1]];
        return sum;
      };
      before = loopCost(entries.map((_, i) => i));
      after = loopCost(optimizedIdx);
      matrixIdxOfEntry = new Map(entries.map((e, i) => [e.id, i + 1]));
      anchorStartMatrixIdx = 0;
    } else {
      ({ matrix, estimated: matrixEstimated } = await this.buildDurationMatrix(trip.geoProvider, entryCoords));
      optimizedIdx = optimizeOrder(matrix);
      before = orderTotalDuration(entries.map((_, i) => i), matrix);
      after = orderTotalDuration(optimizedIdx, matrix);
      matrixIdxOfEntry = new Map(entries.map((e, i) => [e.id, i]));
    }
    const describe = (idx: number[]) =>
      idx.map((i) => ({ entryId: entries[i].id, name: placeById.get(entries[i].placeId!)!.name }));
    // 硬锚点（transit + 定时点）保持原位：优化后的顺序只填回可移动槽位，entryIds 含全部 entry（reorderDay 要求全量）
    const optimizedPlaceIds = optimizedIdx.map((i) => entries[i].id);
    let cursor = 0;
    const mergedEntryIds = allEntries.map((e) => (isMovable(e) ? optimizedPlaceIds[cursor++] : e.id));

    // ---- 按新顺序顺推重算时间轴（与前端 timeline.ts 同口径：09:00 起，停留 + 交通时长累加）----
    // 硬锚点保留原时刻；可移动 entry 得到建议 startTime，供应用重排后写回
    const entryById = new Map(allEntries.map((e) => [e.id, e]));
    const DAY_START_MIN = 9 * 60;
    const stayMinOf = (e: (typeof allEntries)[number]) => {
      const p = e.placeId ? placeById.get(e.placeId) : undefined;
      return e.durationMin ?? p?.durationMin ?? p?.visitDurationMin ?? 90;
    };
    // 节点坐标：place entry 取 place 坐标；transit 取讫点（缺省起点）坐标——跨城大交通不做市内顺推依据
    const coordOfEntry = (e: (typeof allEntries)[number]): LngLat | null => {
      const pid = e.placeId ?? e.toPlaceId ?? e.fromPlaceId;
      const p = pid ? placeById.get(pid) : undefined;
      return p ? { lng: Number(p.lng), lat: Number(p.lat) } : null;
    };
    // 上一节点 → 当前节点的交通分钟：两端都在优化矩阵里取真实时长，否则直线估算（×1.3 ÷ 8.5m/s）
    const travelMin = (
      from: { matrixIdx: number | null; coord: LngLat | null },
      to: { matrixIdx: number | null; coord: LngLat | null },
    ) => {
      if (from.matrixIdx != null && to.matrixIdx != null) {
        const s = matrix[from.matrixIdx][to.matrixIdx];
        if (Number.isFinite(s)) return s / 60;
      }
      if (from.coord && to.coord) return (haversineM(from.coord, to.coord) * 1.3) / 8.5 / 60;
      return 0;
    };
    const suggestedStartTimes: Array<{
      entryId: string;
      name: string;
      startTime: string | null;
      /** true = 硬锚点（transit / 已定 startTime），保留原时刻不参与顺推改写 */
      pinned: boolean;
    }> = [];
    let cur = DAY_START_MIN;
    let prev: { matrixIdx: number | null; coord: LngLat | null } = {
      matrixIdx: anchorStartMatrixIdx,
      coord: startCoord,
    };
    for (const entryId of mergedEntryIds) {
      const e = entryById.get(entryId)!;
      const node = { matrixIdx: matrixIdxOfEntry.get(entryId) ?? null, coord: coordOfEntry(e) };
      if (e.entryType === "transit") {
        // 大交通：depart/arrive 是硬锚点，保留原时刻；到达时间推进顺推游标
        const start = hhmmToMin(e.departTime ?? e.startTime);
        const arrive = hhmmToMin(e.arriveTime);
        let end = arrive ?? start ?? cur;
        if (start != null && arrive != null && arrive < start) end += 1440;
        cur = Math.max(cur, end);
        suggestedStartTimes.push({
          entryId,
          name: `${e.fromName ?? "起点"} → ${e.toName ?? "讫点"}`,
          startTime: e.departTime ?? e.startTime,
          pinned: true,
        });
      } else if (e.startTime != null) {
        // 定时点硬锚点：保留原时刻（即使与顺推游标冲突也不移动），游标推进到其结束
        const start = hhmmToMin(e.startTime) ?? cur;
        cur = Math.max(cur, start) + stayMinOf(e);
        suggestedStartTimes.push({
          entryId,
          name: e.placeId ? (placeById.get(e.placeId)?.name ?? "") : "",
          startTime: e.startTime,
          pinned: true,
        });
      } else {
        cur += travelMin(prev, node);
        const start = cur;
        cur = start + stayMinOf(e);
        suggestedStartTimes.push({
          entryId,
          name: e.placeId ? (placeById.get(e.placeId)?.name ?? "") : "",
          startTime: minToHHMM(start),
          pinned: false,
        });
      }
      prev = node;
    }

    return {
      dayIndex,
      hotelAnchored,
      beforeOrder: describe(entries.map((_, i) => i)),
      afterOrder: describe(optimizedIdx),
      beforeTotalS: before,
      afterTotalS: after,
      savedS: Math.max(0, before - after),
      entryIds: mergedEntryIds,
      alreadyOptimal: before - after < 60,
      /** 硬锚点（带 startTime 的定时点）数量：它们保持原位不参与重排 */
      pinnedCount: pinnedTimedCount,
      /** 按新顺序顺推的建议时间轴；应用 reorder_day 后按它写回 startTime（pinned 的不要动） */
      suggestedStartTimes,
      /** true = 时长矩阵走了直线估算降级（上游不可用），优化质量仅供参考 */
      matrixEstimated,
    };
  }

  /** 顺路度分析（不落库）：把 place 插入某天每个位置的时间增量 + 最优位置。酒店锚点按天解析，换酒店日首尾锚点不同；
   *  中间空洞夜仅首锚点（尾端开放，不假设返回已退房酒店）。
   *  transit entry 不参与插入分析（时间固定、不产生顺路增量），position 语义按 place entry 序列计。 */
  async analyzeDetour(tripId: string, placeId: string, dayIndex: number) {
    const [place] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!place) throw new ServiceError(404, `place ${placeId} not found`);
    const trip = await this.getTrip(tripId);
    const day = await this.ensureDay(tripId, dayIndex);
    const entries = (
      await this.db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.dayId, day.id))
        .orderBy(asc(schema.entries.position))
    ).filter((e) => e.entryType !== "transit" && e.placeId != null);

    const anchors = await this.getDayHotelAnchors(tripId, dayIndex, await this.getTripDayCount(trip));
    const anchorPlaceIds = [
      ...new Set([anchors.startPlaceId, anchors.endPlaceId].filter((x): x is string => x != null)),
    ];
    const hotelAnchored = anchorPlaceIds.length > 0;

    // 无行程且无酒店锚点：插在第一位即可
    if (entries.length === 0 && !hotelAnchored) {
      return {
        dayIndex,
        place: { id: place.id, name: place.name },
        hotelAnchored: false,
        options: [{ position: 0, incrementS: 0 }],
        bestPosition: 0,
        note: "该天还没有行程，插在第一位即可",
      };
    }

    const placeIds = [...new Set([...entries.map((e) => e.placeId!), placeId, ...anchorPlaceIds])];
    const places = await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds));
    const placeById = new Map(places.map((p) => [p.id, p]));
    const target = placeById.get(placeId)!;
    const startHotel = anchors.startPlaceId ? placeById.get(anchors.startPlaceId) : undefined;
    const endHotel = anchors.endPlaceId ? placeById.get(anchors.endPlaceId) : undefined;
    const hotelName = startHotel?.name ?? null;
    const switchDay =
      anchors.startPlaceId != null && anchors.endPlaceId != null && anchors.startPlaceId !== anchors.endPlaceId;

    // 坐标矩阵：同酒店锚点 [酒店, ...entries, 目标]；换酒店日 [旧酒店, ...entries, 新酒店, 目标]；
    // 仅首锚点（中间空洞夜：前一晚有酒店、当晚无住宿）[酒店, ...entries, 目标] 且尾端开放；
    // 无锚点 [...entries, 目标]
    const entryCoords = entries.map((e) => {
      const p = placeById.get(e.placeId!)!;
      return { lng: Number(p.lng), lat: Number(p.lat) };
    });
    const coordOf = (p?: { lng: number; lat: number } | null) =>
      p ? { lng: Number(p.lng), lat: Number(p.lat) } : null;
    const startCoord = coordOf(startHotel);
    const endCoord = coordOf(endHotel);
    const targetCoord = { lng: Number(target.lng), lat: Number(target.lat) };
    const startOnlyAnchored = hotelAnchored && startCoord != null && endCoord == null;
    const points =
      hotelAnchored && startCoord && endCoord
        ? switchDay
          ? [startCoord, ...entryCoords, endCoord, targetCoord]
          : [startCoord, ...entryCoords, targetCoord]
        : startOnlyAnchored
          ? [startCoord, ...entryCoords, targetCoord]
          : [...entryCoords, targetCoord];
    const { matrix } = await this.buildDurationMatrix(trip.geoProvider, points);
    const targetIdx = points.length - 1;
    const hotelIdx = hotelAnchored ? 0 : undefined;
    // 换酒店日的尾锚点（新酒店）在 entries 之后；同酒店时尾锚点 = 首锚点
    const endHotelIdx = hotelAnchored && switchDay ? points.length - 2 : hotelIdx;
    const base = hotelAnchored ? 1 : 0;
    const chain = entries.map((_, i) => base + i);

    // 仅首锚点（中间空洞夜）：酒店钉在链首（本身不是可插入位置），尾端开放——与 recalcDayLegs 一致
    // （当晚无住宿不生成返回段），不能按环路（默认 endAnchorIdx=anchorIdx）也不能按无锚点算。
    // 把酒店作为 chain[0] 走无锚点插入分析，再剔除「插到酒店前」并把 position 平移回 entry 序列
    const increments = startOnlyAnchored
      ? insertionIncrements([0, ...chain], targetIdx, matrix)
          .filter((o) => o.position > 0)
          .map((o) => ({ position: o.position - 1, incrementS: o.incrementS }))
      : insertionIncrements(chain, targetIdx, matrix, hotelIdx, endHotelIdx);
    const options = increments.map((o) => ({
      position: o.position,
      incrementS: o.incrementS,
      // 插在 position k = 跟在原链路第 k-1 个 entry 后面；k=0 时锚定酒店则"从（首锚点）酒店出发后"
      afterEntryName:
        o.position > 0
          ? placeById.get(entries[o.position - 1].placeId!)!.name
          : hotelAnchored
            ? hotelName
            : null,
    }));
    const best = options.reduce((a, b) => (b.incrementS < a.incrementS ? b : a));
    return {
      dayIndex,
      place: { id: place.id, name: place.name },
      hotelAnchored,
      options,
      bestPosition: best.position,
      bestIncrementS: best.incrementS,
    };
  }

  /**
   * 区域聚类建议（只建议不落库）：把未排期的非酒店地点（候选 + 锁定、未进任何一天行程、
   * 也不作为 transit 起讫点）按城市归属分组后，组内按驾车时长矩阵 k-medoids 聚片，建议「每天一片」。
   * 多城市防错配：同城才同簇（cityName 分组，缺失时按最近途经地 ≤150km 归属），跨城地点绝不进同一簇；
   * 簇数按点数自适应（ceil(n/4)，每组 1-4 片），不再被已建天数截断——未建天（dayCount=1）时也能给出多分片建议；
   * 天数分配优先匹配「当天已有该城市 entry」的天，再按负载最轻，簇多于天数时多余的 suggestedDayIndex=null。
   */
  async suggestDayClusters(tripId: string): Promise<SuggestDayClustersResult> {
    const trip = await this.getTrip(tripId);
    const dayCount = await this.getTripDayCount(trip);
    const [places, allEntries, dayRows] = await Promise.all([
      this.db.select().from(schema.places).where(eq(schema.places.tripId, tripId)),
      this.db.select().from(schema.entries).where(eq(schema.entries.tripId, tripId)),
      this.db.select().from(schema.days).where(eq(schema.days.tripId, tripId)).orderBy(asc(schema.days.dayIndex)),
    ]);
    // 未排期 = 未作为任何 entry 的地点、也未作为 transit 起讫点（车站/机场已被大交通占用，不参与聚类）
    const scheduledPlaceIds = new Set(
      allEntries
        .flatMap((e) => [e.placeId, e.fromPlaceId, e.toPlaceId])
        .filter((x): x is string => x != null),
    );
    const unscheduled = places.filter((p) => p.category !== "hotel" && !scheduledPlaceIds.has(p.id));
    if (unscheduled.length < 2) {
      return {
        clusters: [],
        unscheduledCount: unscheduled.length,
        dayCount,
        note: `未排期地点只有 ${unscheduled.length} 个（<2），无需聚类`,
      };
    }

    // ---- 按城市归属分组（同城才同簇）：cityName 优先；缺失时距最近途经地中心 ≤150km 归该 stop；否则「未归属」组 ----
    const stops = this.stopsOfTrip(trip);
    const cityOf = (p: (typeof unscheduled)[number]): string | null => {
      if (p.cityName) return p.cityName.trim();
      const coord = { lng: Number(p.lng), lat: Number(p.lat) };
      let best: { name: string; distKm: number } | null = null;
      for (const stop of stops) {
        if (!stop.center) continue;
        const distKm = haversineM(stop.center, coord) / 1000;
        if (!best || distKm < best.distKm) best = { name: stop.name, distKm };
      }
      return best && best.distKm <= PLACE_CITY_ASSIGN_MAX_DIST_KM ? best.name : null;
    };
    const byCity = new Map<string | null, typeof unscheduled>();
    for (const p of unscheduled) {
      const key = cityOf(p);
      const list = byCity.get(key) ?? [];
      list.push(p);
      byCity.set(key, list);
    }
    // 组顺序跟随 stops 游览顺序（未归属组排最后），输出的簇序与城市游览序一致
    const stopOrder = new Map(stops.map((s, i) => [s.name, i]));
    const cityGroups = [...byCity.entries()].sort(([a], [b]) => {
      const ia = a != null ? (stopOrder.get(a) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const ib = b != null ? (stopOrder.get(b) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      return ia - ib;
    });

    // ---- 组内聚类：簇数按点数自适应 ceil(n/4)，上限 4（与工具描述对齐），不被 dayCount 截断 ----
    let matrixEstimated = false;
    const rawClusters: Array<{ cityName: string | null; members: typeof unscheduled }> = [];
    for (const [cityName, members] of cityGroups) {
      const k = Math.max(1, Math.min(4, Math.ceil(members.length / 4)));
      if (members.length <= k || k === 1) {
        // 单点组 / 单簇：不必跑 k-medoids
        rawClusters.push({ cityName, members });
        continue;
      }
      const coords: LngLat[] = members.map((p) => ({ lng: Number(p.lng), lat: Number(p.lat) }));
      const { matrix, estimated } = await this.buildDurationMatrix(trip.geoProvider, coords);
      matrixEstimated = matrixEstimated || estimated;
      const assignment = kMedoids(matrix, k);
      const groups = new Map<number, typeof unscheduled>();
      assignment.forEach((c, i) => {
        const list = groups.get(c) ?? [];
        list.push(members[i]);
        groups.set(c, list);
      });
      // 组内簇按大小降序（大簇优先分天）
      for (const g of [...groups.values()].sort((a, b) => b.length - a.length)) {
        rawClusters.push({ cityName, members: g });
      }
    }

    // ---- 天数分配：优先「当天已有该城市 entry」的天，再按负载最轻；每天最多一片，溢出为 null ----
    const dayIndexById = new Map(dayRows.map((d) => [d.id, d.dayIndex]));
    const placeCityById = new Map(places.map((p) => [p.id, p.cityName]));
    const loadByDay = new Map<number, number>();
    const cityCountByDay = new Map<number, Map<string, number>>();
    for (const e of allEntries) {
      const di = dayIndexById.get(e.dayId);
      if (di == null) continue;
      loadByDay.set(di, (loadByDay.get(di) ?? 0) + 1);
      const city = e.placeId ? placeCityById.get(e.placeId) : null;
      if (city) {
        const m = cityCountByDay.get(di) ?? new Map<string, number>();
        m.set(city, (m.get(city) ?? 0) + 1);
        cityCountByDay.set(di, m);
      }
    }
    // 各天主导城市（当天 entry 关联地点的 cityName 众数）
    const dominantCityByDay = new Map<number, string>();
    for (const [di, m] of cityCountByDay) {
      const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) dominantCityByDay.set(di, top[0]);
    }
    const assignedDays = new Set<number>();
    const pickDay = (cityName: string | null): number | null => {
      const candidates = Array.from({ length: dayCount }, (_, i) => i + 1).filter(
        (d) => !assignedDays.has(d),
      );
      if (candidates.length === 0) return null;
      // 同城天优先（该天已有这个城市的安排），其余按负载升序、天序号升序
      const matched = cityName != null ? candidates.filter((d) => dominantCityByDay.get(d) === cityName) : [];
      const pool = matched.length > 0 ? matched : candidates;
      pool.sort((a, b) => (loadByDay.get(a) ?? 0) - (loadByDay.get(b) ?? 0) || a - b);
      return pool[0];
    };
    const clusters: DayCluster[] = rawClusters.map((g, clusterIndex) => {
      const members = g.members;
      const centroid = {
        lng: members.reduce((s, p) => s + Number(p.lng), 0) / members.length,
        lat: members.reduce((s, p) => s + Number(p.lat), 0) / members.length,
      };
      const day = pickDay(g.cityName);
      if (day != null) assignedDays.add(day);
      return {
        clusterIndex,
        cityName: g.cityName,
        places: members.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category as DayCluster["places"][number]["category"],
          location: { lng: Number(p.lng), lat: Number(p.lat) },
        })),
        centroid,
        suggestedDayIndex: day,
      };
    });

    const notes: string[] = [];
    if (cityGroups.length > 1) {
      notes.push(`已按途经地分组（${cityGroups.map(([c]) => c ?? "未归属").join("、")}），同一簇不会跨城市`);
    }
    if (clusters.some((c) => c.suggestedDayIndex == null)) {
      notes.push("簇数多于行程天数，多余的簇未分配天（请先建天/设置日期范围，或手动合并分天）");
    }
    if (matrixEstimated) {
      notes.push("时长矩阵走了直线估算降级（上游不可用），分片结果仅供参考");
    }
    return {
      clusters,
      unscheduledCount: unscheduled.length,
      dayCount,
      ...(notes.length > 0 ? { note: notes.join("；") } : {}),
    };
  }

  // ---------- 酒店 ----------

  async addHotelCandidate(tripId: string, input: CreateHotelCandidateInput, actor: Actor) {
    const place = await this.createPlace(tripId, { ...input, category: "hotel" }, actor);
    // createPlace 的 amapPoiId 幂等可能返回已有 place：同一 place 只保留一条酒店候选行，避免重复候选指向同一地点
    // （模糊判重的疑似重复会以 PossibleDuplicateError 传播给调用方，这里收不到）
    const [existing] = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(eq(schema.hotelCandidates.placeId, place.id));
    if (existing) return { candidate: toHotelDto(existing), place };
    const [row] = await this.db
      .insert(schema.hotelCandidates)
      .values({
        id: uuid(),
        tripId,
        placeId: place.id,
        pricePerNight: input.pricePerNight != null ? Math.round(input.pricePerNight) : null,
        notes: input.notes ?? null,
      })
      .returning();
    await this.publishBundle(tripId);
    return { candidate: toHotelDto(row), place };
  }

  async selectHotel(
    tripId: string,
    candidateId: string | null,
    days?: { checkInDay?: number; checkOutDay?: number },
  ) {
    const trip = await this.getTrip(tripId);
    // candidateId=null：取消全部选定（兼容旧单选契约）
    if (candidateId == null) {
      await this.db
        .update(schema.hotelCandidates)
        .set({ selected: false, checkInDay: null, checkOutDay: null })
        .where(eq(schema.hotelCandidates.tripId, tripId));
      await this.syncSelectedHotelMirror(tripId);
      await this.recalcAllDayLegs(tripId);
      await this.publishBundle(tripId);
      return;
    }
    const [cand] = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(and(eq(schema.hotelCandidates.id, candidateId), eq(schema.hotelCandidates.tripId, tripId)));
    if (!cand) throw new ServiceError(404, `hotel candidate ${candidateId} not found`);

    const dayCount = await this.getTripDayCount(trip);
    // 天数边界是否已知：仅当 startDate+endDate 同时有效（日期区间天数）时才把 dayCount 当上界硬校验。
    // 否则 dayCount 退回已建天数（未建天时 =1），若拿它卡 checkOutDay 会与「先定酒店锚点再排天」的
    // 工作流自相矛盾（未建天选酒店被 422）——此时天数可后续增长（建天/设日期），上限不校验。
    const dateRangeDays =
      trip.startDate && trip.endDate
        ? Math.round((new Date(trip.endDate).getTime() - new Date(trip.startDate).getTime()) / 86_400_000) + 1
        : 0;
    const hasDateRange = Number.isFinite(dateRangeDays) && dateRangeDays > 0;
    const others = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(
        and(
          eq(schema.hotelCandidates.tripId, tripId),
          eq(schema.hotelCandidates.selected, true),
          sql`${schema.hotelCandidates.id} <> ${candidateId}`,
        ),
      );

    let checkInDay = days?.checkInDay;
    let checkOutDay = days?.checkOutDay;
    // REST 由 SelectHotelInputSchema 保证同给同缺；MCP 走 shape 注册不跑对象级 refine，这里兜底
    if ((checkInDay == null) !== (checkOutDay == null)) {
      throw new ServiceError(422, "checkInDay 与 checkOutDay 必须同时提供或同时省略（同缺时自动建议未被覆盖的天段）");
    }
    if (checkInDay == null || checkOutDay == null) {
      // 缺省智能建议：尚未被其他已选定酒店覆盖的最长连续天段。
      // horizon：有日期区间时 = dayCount；无日期区间（未建天可继续增长）时取 max(dayCount, 其他酒店最大 checkOutDay)，
      // 保证搜索尾部恒有未覆盖天（覆盖天 < checkOutDay ≤ horizon），不会因为天数未建而把建议压成 [1,2) 一晚。
      const maxOtherCheckOutDay = others.reduce((m, o) => Math.max(m, o.checkOutDay ?? 0), 0);
      const horizon = hasDateRange ? dayCount : Math.max(dayCount, maxOtherCheckOutDay);
      const covered = new Set<number>();
      for (const o of others) {
        if (o.checkInDay == null || o.checkOutDay == null) continue;
        for (let d = o.checkInDay; d < o.checkOutDay; d++) covered.add(d);
      }
      let bestStart = 0;
      let bestLen = 0;
      let runStart = 0;
      for (let d = 1; d <= horizon + 1; d++) {
        if (d <= horizon && !covered.has(d)) {
          if (runStart === 0) runStart = d;
          const len = d - runStart + 1;
          if (len > bestLen) {
            bestStart = runStart;
            bestLen = len;
          }
        } else {
          runStart = 0;
        }
      }
      if (bestLen === 0) {
        // 仅 hasDateRange 时可达（无日期区间时 horizon 尾部恒未覆盖）
        throw new ServiceError(
          422,
          `行程 ${dayCount} 天均已被其他已选定酒店覆盖，请显式指定 checkInDay/checkOutDay（不得重叠）或先取消其他酒店的选定`,
        );
      }
      checkInDay = bestStart;
      checkOutDay = bestStart + bestLen;
    }
    // 入离店天区间校验（闭开区间，checkOutDay 可到 dayCount+1）：
    // 有日期区间时上限硬校验；无日期区间（未建天/未定天数）只要求区间本身非空——允许先选酒店锚点再排天
    if (checkInDay < 1 || checkInDay >= checkOutDay || (hasDateRange && checkOutDay > dayCount + 1)) {
      throw new ServiceError(
        422,
        hasDateRange
          ? `入离店天区间 [${checkInDay}, ${checkOutDay}) 超出行程天数范围（共 ${dayCount} 天）或区间为空`
          : `入离店天区间 [${checkInDay}, ${checkOutDay}) 为空（checkInDay 必须 ≥1 且 < checkOutDay）`,
      );
    }
    // 同一行程已选定酒店的天数区间不得重叠
    for (const o of others) {
      if (o.checkInDay == null || o.checkOutDay == null) continue;
      if (checkInDay < o.checkOutDay && o.checkInDay < checkOutDay) {
        throw new ServiceError(
          422,
          `与已选定酒店的天数区间 [${o.checkInDay}, ${o.checkOutDay}) 重叠；同一晚只能有一家酒店`,
        );
      }
    }

    await this.db
      .update(schema.hotelCandidates)
      .set({ selected: true, checkInDay, checkOutDay })
      .where(eq(schema.hotelCandidates.id, candidateId));
    await this.syncSelectedHotelMirror(tripId);
    // 酒店是每天往返交通的锚点：选定/取消后全量重算各天 legs
    await this.recalcAllDayLegs(tripId);
    await this.publishBundle(tripId);
    return { checkInDay, checkOutDay };
  }

  /** 取消单个酒店的选定 */
  async unselectHotel(tripId: string, candidateId: string) {
    await this.getTrip(tripId);
    const [cand] = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(and(eq(schema.hotelCandidates.id, candidateId), eq(schema.hotelCandidates.tripId, tripId)));
    if (!cand) throw new ServiceError(404, `hotel candidate ${candidateId} not found`);
    await this.db
      .update(schema.hotelCandidates)
      .set({ selected: false, checkInDay: null, checkOutDay: null })
      .where(eq(schema.hotelCandidates.id, candidateId));
    await this.syncSelectedHotelMirror(tripId);
    await this.recalcAllDayLegs(tripId);
    await this.publishBundle(tripId);
  }

  /**
   * 同步 trips.selected_hotel_candidate_id 兼容镜像（deprecated，供旧前端过渡）：
   * 指向 checkInDay 最早的已选定候选，无为 null。权威数据在 hotel_candidates 上。
   */
  private async syncSelectedHotelMirror(tripId: string) {
    const selected = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(and(eq(schema.hotelCandidates.tripId, tripId), eq(schema.hotelCandidates.selected, true)));
    selected.sort((a, b) => (a.checkInDay ?? 0) - (b.checkInDay ?? 0));
    await this.db
      .update(schema.trips)
      .set({ selectedHotelCandidateId: selected[0]?.id ?? null, updatedAt: new Date() })
      .where(eq(schema.trips.id, tripId));
  }

  /** 行程天数：日期范围优先，退回已建天的最大 dayIndex，至少 1 */
  private async getTripDayCount(trip: { id: string; startDate: string | null; endDate: string | null }) {
    let n = 0;
    if (trip.startDate && trip.endDate) {
      const diff =
        Math.round((new Date(trip.endDate).getTime() - new Date(trip.startDate).getTime()) / 86_400_000) + 1;
      if (Number.isFinite(diff) && diff > 0) n = diff;
    }
    const [row] = await this.db
      .select({ max: sql<number | null>`max(${schema.days.dayIndex})` })
      .from(schema.days)
      .where(eq(schema.days.tripId, trip.id));
    if (row?.max != null) n = Math.max(n, row.max);
    return Math.max(n, 1);
  }

  // ---------- 预算 ----------

  /** 设置总预算 / 人数 / 币种 */
  async updateBudget(
    tripId: string,
    input: { budgetCny?: number | null; travelerCount?: number; currency?: string },
  ) {
    await this.getTrip(tripId);
    const patch: Partial<typeof schema.trips.$inferInsert> = { updatedAt: new Date() };
    if (input.budgetCny !== undefined) {
      patch.budgetCny = input.budgetCny != null ? Math.max(0, Math.round(input.budgetCny)) : null;
    }
    if (input.travelerCount !== undefined) {
      patch.travelerCount = Math.max(1, Math.min(20, Math.round(input.travelerCount)));
    }
    if (input.currency !== undefined && /^[A-Z]{3}$/.test(input.currency)) {
      patch.currency = input.currency;
    }
    await this.db.update(schema.trips).set(patch).where(eq(schema.trips.id, tripId));
    await this.publishBundle(tripId);
  }

  /**
   * 预算汇总：住宿（各已选定酒店 × 各自覆盖晚数求和，每晚价 × 晚数，不按人数计）
   * + 美食（已加入餐厅人均 × 人数）+ 门票（已加入景点 × 人数）。
   * 美食/门票只计已加入行程（locked）的地点，候选池里未加入的不计入；
   * 交通费不自动计入（打车/公交成本因人而异，提示用户自行预留）。
   * unpricedCount = 已加入但未填价格的餐厅/景点数 + 已选定但未填每晚价的酒店数（预算低估提醒）。
   */
  async getBudgetSummary(tripId: string) {
    const trip = await this.getTrip(tripId);
    const travelerCount = trip.travelerCount ?? 1;
    const dayRows = await this.db
      .select({ id: schema.days.id })
      .from(schema.days)
      .where(eq(schema.days.tripId, tripId));
    const places = await this.db.select().from(schema.places).where(eq(schema.places.tripId, tripId));

    // 行程天数：日期范围优先（含首尾 = 日期差+1），退回已建天数
    let tripDays = Math.max(dayRows.length, 1);
    if (trip.startDate && trip.endDate) {
      const diff = Math.round(
        (new Date(trip.endDate).getTime() - new Date(trip.startDate).getTime()) / 86_400_000,
      ) + 1;
      if (Number.isFinite(diff) && diff > 0) tripDays = diff;
    }

    // 住宿费：各已选定酒店 × 各自覆盖晚数（checkOutDay - checkInDay）求和（每晚价 × 晚数，不按人数计）。
    // 晚数口径与计费一致：N 天行程 = N-1 晚（最后一天离店不住）；
    // 有已选定酒店时 nights = 覆盖晚数合计，无覆盖时显示 天数-1 供参考。
    // 已选定但未填每晚价的酒店计入 unpricedCount（否则住宿行显示「—」却无任何提醒）。
    const selectedHotels = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(
        and(eq(schema.hotelCandidates.tripId, tripId), eq(schema.hotelCandidates.selected, true)),
      );
    let hotelCny: number | null = null;
    let hotelSelected = false;
    let coveredNightsTotal = 0;
    let unpricedCount = 0;
    for (const cand of selectedHotels) {
      hotelSelected = true;
      const coveredNights =
        cand.checkInDay != null && cand.checkOutDay != null
          ? Math.max(0, cand.checkOutDay - cand.checkInDay)
          : 0;
      coveredNightsTotal += coveredNights;
      if (cand.pricePerNight == null) {
        unpricedCount += 1;
        continue;
      }
      hotelCny = (hotelCny ?? 0) + cand.pricePerNight * coveredNights;
    }
    const nights = hotelSelected ? coveredNightsTotal : Math.max(0, tripDays - 1);

    // 美食/门票：只计已加入行程（locked）的地点——预算辅助决策「已加入项」，
    // 候选池（candidate）里未加入的地点不计入，未定价的计入 unpricedCount 提醒
    let diningCny = 0;
    let ticketsCny = 0;
    for (const p of places) {
      if (p.category === "hotel") continue;
      if (p.status !== "locked") continue;
      if (p.priceCny == null) {
        if (p.category === "restaurant" || p.category === "attraction" || p.category === "activity") {
          unpricedCount += 1;
        }
        continue;
      }
      if (p.category === "restaurant") diningCny += p.priceCny * travelerCount;
      else if (p.category === "attraction" || p.category === "activity") ticketsCny += p.priceCny * travelerCount;
    }

    const totalCny = (hotelCny ?? 0) + diningCny + ticketsCny;
    const budgetCny = trip.budgetCny ?? null;
    return {
      currency: trip.currency ?? "CNY",
      budgetCny,
      travelerCount,
      nights,
      hotelSelected,
      hotelCny,
      diningCny,
      ticketsCny,
      totalCny,
      remainingCny: budgetCny != null ? budgetCny - totalCny : null,
      unpricedCount,
    };
  }

  /** 推荐住宿区域：各天 POI 质心的中位数（前端画圈） */
  async recommendHotelArea(tripId: string): Promise<{ center: LngLat; radiusM: number } | null> {    const places = await this.db.select().from(schema.places).where(eq(schema.places.tripId, tripId));
    const coords = places
      .filter((p) => p.category !== "hotel")
      .map((p) => ({ lng: Number(p.lng), lat: Number(p.lat) }));
    if (coords.length < 3) return null;
    const median = (arr: number[]) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const center = { lng: median(coords.map((c) => c.lng)), lat: median(coords.map((c) => c.lat)) };
    const radiusM = Math.round(
      Math.sqrt(coords.reduce((m, c) => Math.max(m, haversineM(center, c)), 0)),
    );
    return { center, radiusM: Math.min(radiusM, 20000) };
  }
}
