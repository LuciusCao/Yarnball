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
import { amap, fallbackRoute, haversineM } from "./geo.js";
import { insertionIncrements, optimizeOrder, orderTotalDuration } from "./routing.js";

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

/** agent 建点的防编造校验：距城市中心不超过这个半径（千米） */
const AGENT_PLACE_MAX_CITY_DIST_KM = 150;

export class TripService {
  constructor(
    private db: Db,
    private bus: EventBus,
  ) {}

  // ---------- trips ----------

  async createTrip(input: CreateTripInput) {
    const id = uuid();
    const shareToken = randomBytes(16).toString("hex");
    let adcode: string | null = null;
    let center: LngLat | null = null;
    try {
      const city = await amap.resolveCity(input.destinationCity);
      if (city) {
        adcode = city.adcode;
        center = city.center;
      }
    } catch (err) {
      console.warn("[trip] resolveCity failed (amap not configured?):", (err as Error).message);
    }
    const [row] = await this.db
      .insert(schema.trips)
      .values({
        id,
        title: input.title,
        destinationCity: input.destinationCity,
        cityAdcode: adcode,
        cityCenterLng: center ? String(center.lng) : null,
        cityCenterLat: center ? String(center.lat) : null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        shareToken,
      })
      .returning();
    const dto = toTripDto(row);
    this.bus.publish(TRIPS_CHANNEL, { type: "created", trip: dto });
    return dto;
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
      if (distKm > AGENT_PLACE_MAX_CITY_DIST_KM) {
        throw new ServiceError(
          422,
          `坐标距 ${trip.destinationCity} 市中心 ${Math.round(distKm)} 公里，超出合理范围。` +
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

  /** 变更某天 entry 后重算该天连续点对的交通段 */
  async recalcDayLegs(tripId: string, dayId: string) {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, dayId))
      .orderBy(asc(schema.entries.position));
    const placeIds = [...new Set(entries.map((e) => e.placeId))];
    const places = placeIds.length
      ? await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds))
      : [];
    const placeById = new Map(places.map((p) => [p.id, p]));

    await this.db.delete(schema.transportLegs).where(eq(schema.transportLegs.dayId, dayId));
    for (let i = 0; i + 1 < entries.length; i++) {
      const from = placeById.get(entries[i].placeId);
      const to = placeById.get(entries[i + 1].placeId);
      if (!from || !to) continue;
      const a = { lng: Number(from.lng), lat: Number(from.lat) };
      const b = { lng: Number(to.lng), lat: Number(to.lat) };
      const mode = haversineM(a, b) < 2000 ? ("walk" as const) : ("drive" as const);
      let result;
      try {
        result = await amap.route(a, b, mode, trip?.destinationCity);
      } catch {
        result = fallbackRoute(a, b, mode);
      }
      await this.db.insert(schema.transportLegs).values({
        id: uuid(),
        tripId,
        dayId,
        fromEntryId: entries[i].id,
        toEntryId: entries[i + 1].id,
        mode: result.mode,
        distanceM: result.distanceM,
        durationS: result.durationS,
        polyline: result.polyline,
        computedAt: new Date(),
      });
    }
  }

  // ---------- 顺路分析（MCP / 前端共用） ----------

  /** 构建时长矩阵：优先高德驾车距离矩阵，降级直线距离估算 */
  private async buildDurationMatrix(points: LngLat[]): Promise<number[][]> {
    const n = points.length;
    if (n === 0) return [];
    let matrix: number[][] | null = null;
    if (n <= 10) {
      try {
        matrix = await amap.drivingMatrix(points);
      } catch (err) {
        console.warn("[routing] drivingMatrix failed, fallback to haversine:", (err as Error).message);
      }
    }
    if (matrix && matrix.length === n) return matrix;
    // 直线距离 × 1.3 道路系数 / 8.5 m/s 车速
    return points.map((a) =>
      points.map((b) => Math.round((haversineM(a, b) * 1.3) / 8.5)),
    );
  }

  /** 重排建议（不落库）：返回优化后顺序与前后对比 */
  async suggestDayOrder(tripId: string, dayIndex: number) {
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
    const coords = entries.map((e) => {
      const p = placeById.get(e.placeId)!;
      return { lng: Number(p.lng), lat: Number(p.lat) };
    });
    const matrix = await this.buildDurationMatrix(coords);
    const optimizedIdx = optimizeOrder(matrix);
    const currentOrder = entries.map((_, i) => i);
    const before = orderTotalDuration(currentOrder, matrix);
    const after = orderTotalDuration(optimizedIdx, matrix);
    const describe = (idx: number[]) =>
      idx.map((i) => ({ entryId: entries[i].id, name: placeById.get(entries[i].placeId)!.name }));
    return {
      dayIndex,
      beforeOrder: describe(currentOrder),
      afterOrder: describe(optimizedIdx),
      beforeTotalS: before,
      afterTotalS: after,
      savedS: Math.max(0, before - after),
      entryIds: optimizedIdx.map((i) => entries[i].id),
      alreadyOptimal: before - after < 60,
    };
  }

  /** 顺路度分析（不落库）：把 place 插入某天每个位置的时间增量 + 最优位置 */
  async analyzeDetour(tripId: string, placeId: string, dayIndex: number) {
    const [place] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId));
    if (!place) throw new ServiceError(404, `place ${placeId} not found`);
    const day = await this.ensureDay(tripId, dayIndex);
    const entries = await this.db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.dayId, day.id))
      .orderBy(asc(schema.entries.position));
    if (entries.length === 0) {
      return {
        dayIndex,
        place: { id: place.id, name: place.name },
        options: [{ position: 0, incrementS: 0 }],
        bestPosition: 0,
        note: "该天还没有行程，插在第一位即可",
      };
    }
    const placeIds = [...new Set([...entries.map((e) => e.placeId), placeId])];
    const places = await this.db.select().from(schema.places).where(inArray(schema.places.id, placeIds));
    const placeById = new Map(places.map((p) => [p.id, p]));
    const target = placeById.get(placeId)!;
    const chain = entries.map((e) => placeById.get(e.placeId)!);
    const points = [...chain, target].map((p) => ({ lng: Number(p.lng), lat: Number(p.lat) }));
    const matrix = await this.buildDurationMatrix(points);
    const targetIdx = points.length - 1;
    const options = insertionIncrements(
      chain.map((_, i) => i),
      targetIdx,
      matrix,
    ).map((o) => ({
      position: o.position,
      incrementS: o.incrementS,
      // 插在 position k 意味着跟在原链路第 k-1 个 entry 后面
      afterEntryName: o.position > 0 ? placeById.get(entries[o.position - 1].placeId)!.name : null,
    }));
    const best = options.reduce((a, b) => (b.incrementS < a.incrementS ? b : a));
    return {
      dayIndex,
      place: { id: place.id, name: place.name },
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
    // 换酒店影响每天首末段的出发点？v1 行程 leg 只算 entry→entry，酒店不参与；不重算
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
