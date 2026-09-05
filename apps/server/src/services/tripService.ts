import { randomUUID, randomBytes } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import type {
  Actor,
  CreateHotelCandidateInput,
  CreatePlaceInput,
  CreateTripInput,
  GeoProviderName,
  LngLat,
  PlaceStatus,
  TransportMode,
  TripBundle,
  UpdatePlaceInput,
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
import { amap, currencyForCountry, fallbackRoute, getProvider, haversineM, osm } from "./geo.js";
import { insertionIncrements, optimizeLoopOrder, optimizeOrder, optimizePathOrder, orderTotalDuration } from "./routing.js";
import { amapConfigured } from "./settings.js";

const uuid = () => randomUUID();

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** agent 建点的防编造校验：距城市中心的最大半径（千米），按 provider 放宽 */
const AGENT_PLACE_MAX_CITY_DIST_KM: Record<GeoProviderName, number> = {
  amap: 150,
  osm: 300, // 海外城市间距大（悉尼→蓝山 ~110km，墨尔本→大洋路 ~230km）
};

export class TripService {
  constructor(
    private db: Db,
    private bus: EventBus,
  ) {}

  // ---------- trips ----------

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

  async createTrip(input: CreateTripInput) {
    const id = uuid();
    const shareToken = randomBytes(16).toString("hex");
    const resolved = await this.resolveDestination(
      input.destinationCity,
      input.geoProvider,
    );
    const [row] = await this.db
      .insert(schema.trips)
      .values({
        id,
        title: input.title,
        destinationCity: input.destinationCity,
        cityAdcode: resolved.adcode,
        geoProvider: resolved.provider,
        cityCenterLng: resolved.center ? String(resolved.center.lng) : null,
        cityCenterLat: resolved.center ? String(resolved.center.lat) : null,
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
    const resolved = await this.resolveDestination(trip.destinationCity);
    const providerChanged = resolved.provider !== trip.geoProvider;
    await this.db
      .update(schema.trips)
      .set({
        geoProvider: resolved.provider,
        cityAdcode: resolved.provider === "amap" ? resolved.adcode : null,
        cityCenterLng: resolved.center ? String(resolved.center.lng) : null,
        cityCenterLat: resolved.center ? String(resolved.center.lat) : null,
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
   * 建 POI。actor=agent 时校验坐标必须落在目的城市附近（防 LLM 编造经纬度），
   * agent 被拒时应引导其先调 search_poi 拿真实坐标。
   * 状态机：agent 建的默认 candidate（候选池）；human 手动建的默认 locked（确认要去）。
   */
  async createPlace(tripId: string, input: CreatePlaceInput, actor: Actor) {
    const trip = await this.getTrip(tripId);
    if (actor === "agent" && trip.cityCenterLng && trip.cityCenterLat) {
      const center = { lng: Number(trip.cityCenterLng), lat: Number(trip.cityCenterLat) };
      const distKm = haversineM(center, input.location) / 1000;
      const maxKm = AGENT_PLACE_MAX_CITY_DIST_KM[trip.geoProvider as GeoProviderName] ?? 300;
      if (distKm > maxKm) {
        throw new ServiceError(
          422,
          `坐标距 ${trip.destinationCity} 市中心 ${Math.round(distKm)} 公里，超出合理范围（${maxKm}km）。` +
            `请先调用 search_poi 查询真实地点，使用返回的 location，不要自行填写或编造经纬度。`,
        );
      }
    }
    const [row] = await this.db
      .insert(schema.places)
      .values({
        id: uuid(),
        tripId,
        name: input.name,
        category: input.category,
        lng: String(input.location.lng),
        lat: String(input.location.lat),
        address: input.address ?? null,
        amapPoiId: input.amapPoiId ?? null,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl ?? null,
        notes: input.notes ?? null,
        durationMin: input.durationMin ?? null,
        priceCny: input.priceCny != null ? Math.round(input.priceCny) : null,
        bookingInfo: input.bookingInfo ?? null,
        createdBy: actor,
        status: input.status ?? (actor === "human" ? "locked" : "candidate"),
      })
      .returning();
    await this.touchTrip(tripId);
    await this.publishBundle(tripId);
    return toPlaceDto(row);
  }

  /**
   * 锁定保护：locked = 用户已确认要去的地点，agent 不可改/删，
   * 提示其请用户在界面上解锁。人类（REST 入口）不受限。
   */
  private assertNotLockedForAgent(place: { status: string; name: string }, actor: Actor) {
    if (actor === "agent" && place.status === "locked") {
      throw new ServiceError(
        409,
        `「${place.name}」已被用户锁定，agent 不可修改或删除。请用户在界面上解锁后再试。`,
      );
    }
  }

  /** 锁定/解锁地点（用户确认候选 → locked；退回候选池 → candidate） */
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

  async updatePlace(placeId: string, input: UpdatePlaceInput, actor: Actor = "human") {
    const [existing] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!existing) throw new ServiceError(404, `place ${placeId} not found`);
    this.assertNotLockedForAgent(existing, actor);
    const patch: Partial<typeof schema.places.$inferInsert> = {};
    if (input.name != null) patch.name = input.name;
    if (input.category != null) patch.category = input.category;
    if (input.location != null) {
      patch.lng = String(input.location.lng);
      patch.lat = String(input.location.lat);
    }
    if (input.address !== undefined) patch.address = input.address ?? null;
    if (input.amapPoiId !== undefined) patch.amapPoiId = input.amapPoiId ?? null;
    if (input.sourceUrl !== undefined) patch.sourceUrl = input.sourceUrl ?? null;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;
    if (input.durationMin !== undefined) patch.durationMin = input.durationMin ?? null;
    if (input.priceCny !== undefined)
      patch.priceCny = input.priceCny != null ? Math.round(input.priceCny) : null;
    if (input.bookingInfo !== undefined) patch.bookingInfo = input.bookingInfo ?? null;
    if (input.status !== undefined) patch.status = input.status;
    const [row] = await this.db.update(schema.places).set(patch).where(eq(schema.places.id, placeId)).returning();
    await this.touchTrip(existing.tripId);
    await this.publishBundle(existing.tripId);
    return toPlaceDto(row);
  }

  async removePlace(placeId: string, actor: Actor = "human") {
    const [existing] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!existing) throw new ServiceError(404, `place ${placeId} not found`);
    this.assertNotLockedForAgent(existing, actor);
    const tripId = existing.tripId;
    // 删的是已选定酒店 → 候选行随 place 级联删除，所有天的锚点都要重算
    const linkedHotels = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(eq(schema.hotelCandidates.placeId, placeId));
    const wasSelectedHotel = linkedHotels.some((h) => h.selected);
    // 级联删 entries/legs（FK on delete cascade），受影响的天需要重算 legs
    const affectedDays = await this.db
      .selectDistinct({ dayId: schema.entries.dayId })
      .from(schema.entries)
      .where(eq(schema.entries.placeId, placeId));
    await this.db.delete(schema.places).where(eq(schema.places.id, placeId));
    await this.touchTrip(tripId);
    if (wasSelectedHotel) {
      await this.syncSelectedHotelMirror(tripId);
      await this.recalcAllDayLegs(tripId);
    } else {
      for (const { dayId } of affectedDays) await this.recalcDayLegs(tripId, dayId);
    }
    await this.publishBundle(tripId);
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

  async addEntry(
    tripId: string,
    placeId: string,
    dayIndex: number,
    position: number | null,
    startTime?: string | null,
  ) {
    await this.getTrip(tripId);
    const [place] = await this.db
      .select()
      .from(schema.places)
      .where(and(eq(schema.places.id, placeId), eq(schema.places.tripId, tripId)));
    if (!place) throw new ServiceError(404, `place ${placeId} not found in trip ${tripId}`);
    const day = await this.ensureDay(tripId, dayIndex);
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, day.id))
      .orderBy(asc(schema.entries.position));
    const pos = position == null ? entries.length : Math.max(0, Math.min(position, entries.length));
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.entries)
        .set({ position: sql`${schema.entries.position} + 1` })
        .where(and(eq(schema.entries.dayId, day.id), sql`${schema.entries.position} >= ${pos}`));
      await tx.insert(schema.entries).values({
        id: uuid(),
        tripId,
        dayId: day.id,
        placeId,
        position: pos,
        startTime: startTime ?? null,
      });
    });
    await this.touchTrip(tripId);
    await this.recalcDayLegs(tripId, day.id);
    await this.publishBundle(tripId);
    return { dayId: day.id, position: pos };
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
      await this.db.transaction(async (tx) => {
        // 先挪到安全位置避免唯一约束冲突
        await tx
          .update(schema.entries)
          .set({ position: sql`${schema.entries.position} + 10000` })
          .where(eq(schema.entries.dayId, day.id));
        await tx.update(schema.entries).set({ position }).where(eq(schema.entries.id, entryId));
        await this.normalizePositionsTx(tx, day.id);
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
      await this.db
        .update(schema.entries)
        .set({ position: sql`${schema.entries.position} + 1` })
        .where(and(eq(schema.entries.dayId, day.id), sql`${schema.entries.position} >= ${pos}`));
      await this.db.insert(schema.entries).values({
        id: entryId,
        tripId: entry.tripId,
        dayId: day.id,
        placeId: entry.placeId,
        position: pos,
        startTime: entry.startTime,
        note: entry.note,
      });
    }
    await this.touchTrip(entry.tripId);
    await this.recalcDayLegs(entry.tripId, day.id);
    if (day.id !== entry.dayId) await this.recalcDayLegs(entry.tripId, entry.dayId);
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
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.entries)
        .set({ position: sql`${schema.entries.position} + 10000` })
        .where(eq(schema.entries.dayId, day.id));
      for (let i = 0; i < entryIds.length; i++) {
        await tx.update(schema.entries).set({ position: i }).where(eq(schema.entries.id, entryIds[i]));
      }
    });
    await this.touchTrip(tripId);
    await this.recalcDayLegs(tripId, day.id);
    await this.publishBundle(tripId);
  }

  private async normalizePositions(dayId: string) {
    await this.db.transaction((tx) => this.normalizePositionsTx(tx, dayId));
  }

  private async normalizePositionsTx(tx: Tx, dayId: string) {
    const rows = await tx
      .select({ id: schema.entries.id })
      .from(schema.entries)
      .where(eq(schema.entries.dayId, dayId))
      .orderBy(asc(schema.entries.position));
    for (let i = 0; i < rows.length; i++) {
      await tx.update(schema.entries).set({ position: i }).where(eq(schema.entries.id, rows[i].id));
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
   * - 尾锚点 = 当晚住宿的酒店（缺省回退前一晚酒店，如最后一天不住宿）
   * 换酒店日（旧酒店 checkOutDay = 当天 = 新酒店 checkInDay）：首 = 旧酒店，尾 = 新酒店。
   * 没有任何已选定酒店覆盖时两端都是 null（无锚点，保持现状）。
   */
  private async getDayHotelAnchors(
    tripId: string,
    dayIndex: number,
  ): Promise<{ startPlaceId: string | null; endPlaceId: string | null }> {
    const prev = await this.getHotelPlaceIdForNight(tripId, dayIndex - 1);
    const curr = await this.getHotelPlaceIdForNight(tripId, dayIndex);
    return { startPlaceId: prev ?? curr, endPlaceId: curr ?? prev };
  }

  /**
   * 变更某天 entry / 换酒店后重算该天交通段。
   * 酒店锚点按天解析（见 getDayHotelAnchors）：普通日首尾同为当晚酒店，
   * 换酒店日首 = 旧酒店、尾 = 新酒店；无覆盖酒店的天不锚定（仅景点间移动）。
   * 手动 mode 覆盖（modeOverride）按端点配对保留，重算不冲掉。
   */
  async recalcDayLegs(tripId: string, dayId: string) {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    const geo = getProvider(trip?.geoProvider ?? "osm");
    const [day] = await this.db.select().from(schema.days).where(eq(schema.days.id, dayId));
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, dayId))
      .orderBy(asc(schema.entries.position));
    const anchors =
      day && entries.length > 0
        ? await this.getDayHotelAnchors(tripId, day.dayIndex)
        : { startPlaceId: null, endPlaceId: null };

    const placeIds = [
      ...new Set(
        [
          ...entries.map((e) => e.placeId),
          ...(anchors.startPlaceId ? [anchors.startPlaceId] : []),
          ...(anchors.endPlaceId ? [anchors.endPlaceId] : []),
        ],
      ),
    ];
    const places = placeIds.length
      ? await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds))
      : [];
    const placeById = new Map(places.map((p) => [p.id, p]));

    // 端点链：entry（行程内）或 place（酒店首/尾锚点，换酒店日可不同）
    const chain: Array<{ entryId: string | null; placeId: string }> = [];
    if (anchors.startPlaceId) chain.push({ entryId: null, placeId: anchors.startPlaceId });
    for (const e of entries) chain.push({ entryId: e.id, placeId: e.placeId });
    if (anchors.endPlaceId) chain.push({ entryId: null, placeId: anchors.endPlaceId });

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

    await this.db.delete(schema.transportLegs).where(eq(schema.transportLegs.dayId, dayId));
    for (let i = 0; i + 1 < chain.length; i++) {
      const from = chain[i];
      const to = chain[i + 1];
      const fromPlace = placeById.get(from.placeId);
      const toPlace = placeById.get(to.placeId);
      if (!fromPlace || !toPlace) continue;
      const a = { lng: Number(fromPlace.lng), lat: Number(fromPlace.lat) };
      const b = { lng: Number(toPlace.lng), lat: Number(toPlace.lat) };
      const fromId = from.entryId ? null : from.placeId;
      const toId = to.entryId ? null : to.placeId;
      const override =
        overrides.get(`${endpointKey(from.entryId, fromId)}->${endpointKey(to.entryId, toId)}`) ?? null;
      const mode = override ?? (haversineM(a, b) < 2000 ? ("walk" as const) : ("drive" as const));
      let result;
      try {
        result = await geo.route(a, b, mode, trip?.destinationCity);
      } catch {
        result = fallbackRoute(a, b, mode);
      }
      await this.db.insert(schema.transportLegs).values({
        id: uuid(),
        tripId,
        dayId,
        fromEntryId: from.entryId,
        toEntryId: to.entryId,
        fromPlaceId: fromId,
        toPlaceId: toId,
        seq: i,
        mode: override ?? result.mode,
        modeOverride: override,
        distanceM: result.distanceM,
        durationS: result.durationS,
        polyline: result.polyline,
        computedAt: new Date(),
      });
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

  /** 行程全部天的 legs 重算（换酒店/删除酒店地点用） */
  private async recalcAllDayLegs(tripId: string) {
    const dayRows = await this.db
      .select({ id: schema.days.id })
      .from(schema.days)
      .where(eq(schema.days.tripId, tripId));
    for (const d of dayRows) await this.recalcDayLegs(tripId, d.id);
  }

  // ---------- 顺路分析（MCP / 前端共用） ----------

  /** 构建时长矩阵：优先该行程 provider 的驾车矩阵，失败降级直线距离估算 */
  private async buildDurationMatrix(provider: string, points: LngLat[]): Promise<number[][]> {
    const n = points.length;
    if (n === 0) return [];
    let matrix: number[][] | null = null;
    if (n <= 10) {
      try {
        matrix = await getProvider(provider).drivingMatrix(points);
      } catch (err) {
        console.warn(`[routing] drivingMatrix failed, fallback to haversine:`, (err as Error).message);
      }
    }
    if (matrix && matrix.length === n) return matrix;
    // 直线距离 × 1.3 道路系数 / 8.5 m/s 车速
    return points.map((a) =>
      points.map((b) => Math.round((haversineM(a, b) * 1.3) / 8.5)),
    );
  }

  /** 重排建议（不落库）：按天取酒店锚点——同酒店往返按环路优化，换酒店日按「旧酒店→…→新酒店」定端路径优化，无锚点保持首点为起点 */
  async suggestDayOrder(tripId: string, dayIndex: number) {
    const trip = await this.getTrip(tripId);
    const day = await this.ensureDay(tripId, dayIndex);
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, day.id))
      .orderBy(asc(schema.entries.position));
    if (entries.length < 3) {
      throw new ServiceError(422, `day ${dayIndex} 只有 ${entries.length} 个地点（<3），无需重排`);
    }
    const placeIds = [...new Set(entries.map((e) => e.placeId))];
    const places = await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds));
    const placeById = new Map(places.map((p) => [p.id, p]));
    const entryCoords = entries.map((e) => {
      const p = placeById.get(e.placeId)!;
      return { lng: Number(p.lng), lat: Number(p.lat) };
    });
    const anchors = await this.getDayHotelAnchors(tripId, dayIndex);
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
    // 换酒店日：首（旧酒店）≠ 尾（新酒店）；getDayHotelAnchors 保证要么两端都有、要么都无
    const switchDay =
      anchors.startPlaceId != null && anchors.endPlaceId != null && anchors.startPlaceId !== anchors.endPlaceId;

    let optimizedIdx: number[]; // entries 数组的下标顺序
    let before: number;
    let after: number;
    if (hotelAnchored && startCoord && endCoord && switchDay) {
      // 定端路径：[旧酒店, ...entries, 新酒店]，下标 0 / n-1 固定
      const coords = [startCoord, ...entryCoords, endCoord];
      const matrix = await this.buildDurationMatrix(trip.geoProvider, coords);
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
    } else if (hotelAnchored && startCoord) {
      // 环路：[酒店, ...entries, 酒店]，下标 0 = 酒店
      const coords = [startCoord, ...entryCoords];
      const matrix = await this.buildDurationMatrix(trip.geoProvider, coords);
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
    } else {
      const matrix = await this.buildDurationMatrix(trip.geoProvider, entryCoords);
      optimizedIdx = optimizeOrder(matrix);
      before = orderTotalDuration(entries.map((_, i) => i), matrix);
      after = orderTotalDuration(optimizedIdx, matrix);
    }
    const describe = (idx: number[]) =>
      idx.map((i) => ({ entryId: entries[i].id, name: placeById.get(entries[i].placeId)!.name }));
    return {
      dayIndex,
      hotelAnchored,
      beforeOrder: describe(entries.map((_, i) => i)),
      afterOrder: describe(optimizedIdx),
      beforeTotalS: before,
      afterTotalS: after,
      savedS: Math.max(0, before - after),
      entryIds: optimizedIdx.map((i) => entries[i].id),
      alreadyOptimal: before - after < 60,
    };
  }

  /** 顺路度分析（不落库）：把 place 插入某天每个位置的时间增量 + 最优位置。酒店锚点按天解析，换酒店日首尾锚点不同 */
  async analyzeDetour(tripId: string, placeId: string, dayIndex: number) {
    const [place] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!place) throw new ServiceError(404, `place ${placeId} not found`);
    const trip = await this.getTrip(tripId);
    const day = await this.ensureDay(tripId, dayIndex);
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, day.id))
      .orderBy(asc(schema.entries.position));

    const anchors = await this.getDayHotelAnchors(tripId, dayIndex);
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

    const placeIds = [...new Set([...entries.map((e) => e.placeId), placeId, ...anchorPlaceIds])];
    const places = await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds));
    const placeById = new Map(places.map((p) => [p.id, p]));
    const target = placeById.get(placeId)!;
    const startHotel = anchors.startPlaceId ? placeById.get(anchors.startPlaceId) : undefined;
    const endHotel = anchors.endPlaceId ? placeById.get(anchors.endPlaceId) : undefined;
    const hotelName = startHotel?.name ?? null;
    const switchDay =
      anchors.startPlaceId != null && anchors.endPlaceId != null && anchors.startPlaceId !== anchors.endPlaceId;

    // 坐标矩阵：同酒店锚点 [酒店, ...entries, 目标]；换酒店日 [旧酒店, ...entries, 新酒店, 目标]；无锚点 [...entries, 目标]
    const entryCoords = entries.map((e) => {
      const p = placeById.get(e.placeId)!;
      return { lng: Number(p.lng), lat: Number(p.lat) };
    });
    const coordOf = (p?: { lng: string; lat: string } | null) =>
      p ? { lng: Number(p.lng), lat: Number(p.lat) } : null;
    const startCoord = coordOf(startHotel);
    const endCoord = coordOf(endHotel);
    const targetCoord = { lng: Number(target.lng), lat: Number(target.lat) };
    const points =
      hotelAnchored && startCoord && endCoord
        ? switchDay
          ? [startCoord, ...entryCoords, endCoord, targetCoord]
          : [startCoord, ...entryCoords, targetCoord]
        : [...entryCoords, targetCoord];
    const matrix = await this.buildDurationMatrix(trip.geoProvider, points);
    const targetIdx = points.length - 1;
    const hotelIdx = hotelAnchored ? 0 : undefined;
    // 换酒店日的尾锚点（新酒店）在 entries 之后；同酒店时尾锚点 = 首锚点
    const endHotelIdx = hotelAnchored && switchDay ? points.length - 2 : hotelIdx;
    const base = hotelAnchored ? 1 : 0;
    const chain = entries.map((_, i) => base + i);

    const options = insertionIncrements(chain, targetIdx, matrix, hotelIdx, endHotelIdx).map((o) => ({
      position: o.position,
      incrementS: o.incrementS,
      // 插在 position k = 跟在原链路第 k-1 个 entry 后面；k=0 时锚定酒店则"从（首锚点）酒店出发后"
      afterEntryName:
        o.position > 0
          ? placeById.get(entries[o.position - 1].placeId)!.name
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

  // ---------- 酒店 ----------

  async addHotelCandidate(tripId: string, input: CreateHotelCandidateInput, actor: Actor) {
    const place = await this.createPlace(tripId, { ...input, category: "hotel" }, actor);
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
    if (checkInDay == null || checkOutDay == null) {
      // 缺省智能建议：尚未被其他已选定酒店覆盖的最长连续天段
      const covered = new Set<number>();
      for (const o of others) {
        if (o.checkInDay == null || o.checkOutDay == null) continue;
        for (let d = o.checkInDay; d < o.checkOutDay; d++) covered.add(d);
      }
      let bestStart = 0;
      let bestLen = 0;
      let runStart = 0;
      for (let d = 1; d <= dayCount + 1; d++) {
        if (d <= dayCount && !covered.has(d)) {
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
        throw new ServiceError(
          422,
          `行程 ${dayCount} 天均已被其他已选定酒店覆盖，请显式指定 checkInDay/checkOutDay（不得重叠）或先取消其他酒店的选定`,
        );
      }
      checkInDay = bestStart;
      checkOutDay = bestStart + bestLen;
    }
    // 入离店天必须在行程天数范围内（闭开区间，checkOutDay 可到 dayCount+1）
    if (checkInDay < 1 || checkOutDay > dayCount + 1 || checkInDay >= checkOutDay) {
      throw new ServiceError(
        422,
        `入离店天区间 [${checkInDay}, ${checkOutDay}) 超出行程天数范围（共 ${dayCount} 天）或区间为空`,
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
   * 预算汇总：住宿（各已选定酒店 × 各自覆盖晚数求和）+ 餐饮（餐厅人均 × 人数）+ 门票（景点 × 人数）。
   * 交通费不自动计入（打车/公交成本因人而异，提示用户自行预留）。
   */
  async getBudgetSummary(tripId: string) {
    const trip = await this.getTrip(tripId);
    const travelerCount = trip.travelerCount ?? 1;
    const dayRows = await this.db
      .select({ id: schema.days.id })
      .from(schema.days)
      .where(eq(schema.days.tripId, tripId));
    const places = await this.db.select().from(schema.places).where(eq(schema.places.tripId, tripId));

    // 晚数：日期范围优先，退回天数，至少 1
    let nights = Math.max(dayRows.length, 1);
    if (trip.startDate && trip.endDate) {
      const diff = Math.round(
        (new Date(trip.endDate).getTime() - new Date(trip.startDate).getTime()) / 86_400_000,
      );
      if (Number.isFinite(diff) && diff > 0) nights = diff;
    }

    // 住宿费：各已选定酒店 × 各自覆盖晚数（checkOutDay - checkInDay）求和
    const selectedHotels = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(
        and(eq(schema.hotelCandidates.tripId, tripId), eq(schema.hotelCandidates.selected, true)),
      );
    let hotelCny: number | null = null;
    let hotelSelected = false;
    for (const cand of selectedHotels) {
      hotelSelected = true;
      if (cand.pricePerNight == null) continue;
      const coveredNights =
        cand.checkInDay != null && cand.checkOutDay != null
          ? Math.max(0, cand.checkOutDay - cand.checkInDay)
          : nights;
      hotelCny = (hotelCny ?? 0) + cand.pricePerNight * coveredNights;
    }

    let diningCny = 0;
    let ticketsCny = 0;
    let unpricedCount = 0;
    for (const p of places) {
      if (p.category === "hotel") continue;
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
