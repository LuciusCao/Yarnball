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
  TripBundle,
  UpdatePlaceInput,
} from "@odessey/shared";
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
import { amap, fallbackRoute, getProvider, haversineM, osm } from "./geo.js";
import { insertionIncrements, optimizeLoopOrder, optimizeOrder, orderTotalDuration } from "./routing.js";
import { env } from "../env.js";

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
   * 高德可用时先试（country=中国 → amap，GCJ-02）；否则走 OSM 栈
   * （Nominatim 优先，中文城市名如「悉尼」也能正确命中）。
   * 都失败 → provider osm、center null（前端触发自愈重试）。
   */
  private async resolveDestination(
    city: string,
    forced?: GeoProviderName,
  ): Promise<{ provider: GeoProviderName; adcode: string | null; center: LngLat | null }> {
    if (!forced || forced === "amap") {
      if (env.amapConfigured) {
        try {
          const geo = await amap.resolveCity(city);
          if (geo?.country === "中国") {
            return { provider: "amap", adcode: geo.adcode, center: geo.center };
          }
        } catch (err) {
          console.warn("[trip] amap resolveCity failed:", (err as Error).message);
        }
      }
      if (forced === "amap") return { provider: "amap", adcode: null, center: null };
    }
    try {
      const geo = await osm.resolveCity(city);
      if (geo) return { provider: "osm", adcode: null, center: geo.center };
    } catch (err) {
      console.warn("[trip] osm resolveCity failed:", (err as Error).message);
    }
    return { provider: "osm", adcode: null, center: null };
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
   * 重新解析目的城市（自愈：创建时网络失败 / 旧数据定位错误）。
   * 坐标系安全：行程已有地点时禁止切换 provider（WGS84/GCJ-02 混用会整体错位），
   * 只更新与当前 provider 一致的解析结果。
   */
  async reResolveCity(tripId: string) {
    const trip = await this.getTrip(tripId);
    const resolved = await this.resolveDestination(trip.destinationCity);
    const hasPlaces =
      (
        await this.db
          .select({ id: schema.places.id })
          .from(schema.places)
          .where(eq(schema.places.tripId, tripId))
          .limit(1)
      ).length > 0;
    const currentProvider = trip.geoProvider as GeoProviderName;
    const provider = hasPlaces ? currentProvider : resolved.provider;
    // 解析来源与（保持的）provider 不一致时不动 center，避免坐标系污染
    if (hasPlaces && resolved.provider !== provider) {
      return toTripDto(trip);
    }
    await this.db
      .update(schema.trips)
      .set({
        geoProvider: provider,
        cityAdcode: provider === "amap" ? resolved.adcode : null,
        cityCenterLng: resolved.center ? String(resolved.center.lng) : null,
        cityCenterLat: resolved.center ? String(resolved.center.lat) : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.trips.id, tripId));
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
        createdBy: actor,
      })
      .returning();
    await this.touchTrip(tripId);
    await this.publishBundle(tripId);
    return toPlaceDto(row);
  }

  async updatePlace(placeId: string, input: UpdatePlaceInput) {
    const [existing] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!existing) throw new ServiceError(404, `place ${placeId} not found`);
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
    const [row] = await this.db.update(schema.places).set(patch).where(eq(schema.places.id, placeId)).returning();
    await this.touchTrip(existing.tripId);
    await this.publishBundle(existing.tripId);
    return toPlaceDto(row);
  }

  async removePlace(placeId: string) {
    const [existing] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!existing) throw new ServiceError(404, `place ${placeId} not found`);
    const tripId = existing.tripId;
    // 删的是选定酒店 → 先解除选定，避免悬空引用
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    if (trip?.selectedHotelCandidateId) {
      const [cand] = await this.db
        .select()
        .from(schema.hotelCandidates)
        .where(eq(schema.hotelCandidates.id, trip.selectedHotelCandidateId));
      if (cand?.placeId === placeId) {
        await this.db
          .update(schema.trips)
          .set({ selectedHotelCandidateId: null })
          .where(eq(schema.trips.id, tripId));
      }
    }
    // 级联删 entries/legs（FK on delete cascade），受影响的天需要重算 legs
    const affectedDays = await this.db
      .selectDistinct({ dayId: schema.entries.dayId })
      .from(schema.entries)
      .where(eq(schema.entries.placeId, placeId));
    await this.db.delete(schema.places).where(eq(schema.places.id, placeId));
    await this.touchTrip(tripId);
    for (const { dayId } of affectedDays) await this.recalcDayLegs(tripId, dayId);
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

  async addEntry(tripId: string, placeId: string, dayIndex: number, position: number | null) {
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

  /** 当前选定酒店的 placeId（未选为 null） */
  private async getSelectedHotelPlaceId(tripId: string): Promise<string | null> {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    if (!trip?.selectedHotelCandidateId) return null;
    const [cand] = await this.db
      .select()
      .from(schema.hotelCandidates)
      .where(eq(schema.hotelCandidates.id, trip.selectedHotelCandidateId));
    return cand?.placeId ?? null;
  }

  /**
   * 变更某天 entry / 换酒店后重算该天交通段。
   * 选定酒店时链路为 [酒店, ...entries, 酒店]——每天自动计算往返交通；
   * 未选酒店时为 [...entries]（景点间移动）。
   */
  async recalcDayLegs(tripId: string, dayId: string) {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    const geo = getProvider(trip?.geoProvider ?? "osm");
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, dayId))
      .orderBy(asc(schema.entries.position));
    const hotelPlaceId = entries.length > 0 ? await this.getSelectedHotelPlaceId(tripId) : null;

    const placeIds = [...new Set([...entries.map((e) => e.placeId), ...(hotelPlaceId ? [hotelPlaceId] : [])])];
    const places = placeIds.length
      ? await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds))
      : [];
    const placeById = new Map(places.map((p) => [p.id, p]));

    // 端点链：entry（行程内）或 place（酒店）
    const chain: Array<{ entryId: string | null; placeId: string }> = [];
    if (hotelPlaceId) chain.push({ entryId: null, placeId: hotelPlaceId });
    for (const e of entries) chain.push({ entryId: e.id, placeId: e.placeId });
    if (hotelPlaceId) chain.push({ entryId: null, placeId: hotelPlaceId });

    await this.db.delete(schema.transportLegs).where(eq(schema.transportLegs.dayId, dayId));
    for (let i = 0; i + 1 < chain.length; i++) {
      const from = chain[i];
      const to = chain[i + 1];
      const fromPlace = placeById.get(from.placeId);
      const toPlace = placeById.get(to.placeId);
      if (!fromPlace || !toPlace) continue;
      const a = { lng: Number(fromPlace.lng), lat: Number(fromPlace.lat) };
      const b = { lng: Number(toPlace.lng), lat: Number(toPlace.lat) };
      const mode = haversineM(a, b) < 2000 ? ("walk" as const) : ("drive" as const);
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
        fromPlaceId: from.entryId ? null : from.placeId,
        toPlaceId: to.entryId ? null : to.placeId,
        seq: i,
        mode: result.mode,
        distanceM: result.distanceM,
        durationS: result.durationS,
        polyline: result.polyline,
        computedAt: new Date(),
      });
    }
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

  /** 重排建议（不落库）：选定酒店时按「酒店出发→…→返回酒店」环路优化，否则保持首点为起点 */
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
    const hotelPlaceId = await this.getSelectedHotelPlaceId(tripId);
    const hotelPlace = hotelPlaceId
      ? (await this.db.select().from(schema.places).where(eq(schema.places.id, hotelPlaceId)))[0]
      : null;
    const hotelAnchored = !!hotelPlace;
    const hotelCoord = hotelPlace
      ? { lng: Number(hotelPlace.lng), lat: Number(hotelPlace.lat) }
      : null;

    let optimizedIdx: number[]; // entries 数组的下标顺序
    let before: number;
    let after: number;
    if (hotelAnchored && hotelCoord) {
      // 环路：[酒店, ...entries, 酒店]，下标 0 = 酒店
      const coords = [hotelCoord, ...entryCoords];
      const matrix = await this.buildDurationMatrix(trip.geoProvider, coords);
      const loop = optimizeLoopOrder(matrix); // [0, ...perm, 0]
      optimizedIdx = loop.slice(1, -1).map((i) => i - 1);
      const loopCost = (order: number[]): number => {
        let sum = 0;
        const seq = [0, ...order, 0];
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

  /** 顺路度分析（不落库）：把 place 插入某天每个位置的时间增量 + 最优位置。选定酒店时按往返闭环计算 */
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

    const hotelPlaceId = await this.getSelectedHotelPlaceId(tripId);
    const hotelPlace = hotelPlaceId
      ? (await this.db.select().from(schema.places).where(eq(schema.places.id, hotelPlaceId)))[0]
      : null;
    const hotelAnchored = !!hotelPlace;

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

    const placeIds = [...new Set([...entries.map((e) => e.placeId), placeId, ...(hotelPlaceId ? [hotelPlaceId] : [])])];
    const places = await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds));
    const placeById = new Map(places.map((p) => [p.id, p]));
    const target = placeById.get(placeId)!;
    const hotelName = hotelPlace?.name ?? null;

    // 坐标矩阵：酒店锚点时 [酒店, ...entries, 目标]，否则 [...entries, 目标]
    const entryCoords = entries.map((e) => {
      const p = placeById.get(e.placeId)!;
      return { lng: Number(p.lng), lat: Number(p.lat) };
    });
    const hotelCoord = hotelPlace
      ? { lng: Number(hotelPlace.lng), lat: Number(hotelPlace.lat) }
      : null;
    const targetCoord = { lng: Number(target.lng), lat: Number(target.lat) };
    const points = hotelAnchored && hotelCoord
      ? [hotelCoord, ...entryCoords, targetCoord]
      : [...entryCoords, targetCoord];
    const matrix = await this.buildDurationMatrix(trip.geoProvider, points);
    const targetIdx = points.length - 1;
    const hotelIdx = hotelAnchored ? 0 : undefined;
    const base = hotelAnchored ? 1 : 0;
    const chain = entries.map((_, i) => base + i);

    const options = insertionIncrements(chain, targetIdx, matrix, hotelIdx).map((o) => ({
      position: o.position,
      incrementS: o.incrementS,
      // 插在 position k = 跟在原链路第 k-1 个 entry 后面；k=0 时锚定酒店则"从酒店出发后"
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

  async selectHotel(tripId: string, candidateId: string | null) {
    await this.getTrip(tripId);
    if (candidateId != null) {
      const [cand] = await this.db
        .select()
        .from(schema.hotelCandidates)
        .where(and(eq(schema.hotelCandidates.id, candidateId), eq(schema.hotelCandidates.tripId, tripId)));
      if (!cand) throw new ServiceError(404, `hotel candidate ${candidateId} not found`);
    }
    await this.db
      .update(schema.trips)
      .set({ selectedHotelCandidateId: candidateId, updatedAt: new Date() })
      .where(eq(schema.trips.id, tripId));
    // 酒店是每天往返交通的锚点：选定/取消后全量重算各天 legs
    await this.recalcAllDayLegs(tripId);
    await this.publishBundle(tripId);
  }

  /** 推荐住宿区域：各天 POI 质心的中位数（前端画圈） */
  async recommendHotelArea(tripId: string): Promise<{ center: LngLat; radiusM: number } | null> {
    const places = await this.db.select().from(schema.places).where(eq(schema.places.tripId, tripId));
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
