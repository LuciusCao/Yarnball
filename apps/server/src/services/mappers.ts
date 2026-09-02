import type {
  ChatSessionDto,
  DayDto,
  EntryDto,
  HotelCandidateDto,
  PlaceDto,
  TransportLegDto,
  TripDto,
} from "@odessey/shared";
import type * as t from "../db/schema.js";

type TripRow = typeof t.trips.$inferSelect;
type PlaceRow = typeof t.places.$inferSelect;
type DayRow = typeof t.days.$inferSelect;
type EntryRow = typeof t.entries.$inferSelect;
type LegRow = typeof t.transportLegs.$inferSelect;
type HotelRow = typeof t.hotelCandidates.$inferSelect;
type ChatSessionRow = typeof t.chatSessions.$inferSelect;

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

export function toTripDto(row: TripRow): TripDto {
  return {
    id: row.id,
    title: row.title,
    destinationCity: row.destinationCity,
    cityAdcode: row.cityAdcode,
    geoProvider: row.geoProvider as TripDto["geoProvider"],
    location:
      row.cityCenterLng != null && row.cityCenterLat != null
        ? { lng: Number(row.cityCenterLng), lat: Number(row.cityCenterLat) }
        : null,
    startDate: row.startDate,
    endDate: row.endDate,
    selectedHotelCandidateId: row.selectedHotelCandidateId,
    shareToken: row.shareToken,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toPlaceDto(row: PlaceRow): PlaceDto {
  return {
    id: row.id,
    tripId: row.tripId,
    name: row.name,
    category: row.category as PlaceDto["category"],
    location: { lng: Number(row.lng), lat: Number(row.lat) },
    address: row.address,
    amapPoiId: row.amapPoiId,
    sourceType: row.sourceType as PlaceDto["sourceType"],
    sourceUrl: row.sourceUrl,
    notes: row.notes,
    durationMin: row.durationMin,
    priceCny: row.priceCny,
    createdBy: row.createdBy as PlaceDto["createdBy"],
    createdAt: iso(row.createdAt),
  };
}

export function toDayDto(row: DayRow): DayDto {
  return { id: row.id, tripId: row.tripId, dayIndex: row.dayIndex, date: row.date };
}

export function toEntryDto(row: EntryRow): EntryDto {
  return {
    id: row.id,
    dayId: row.dayId,
    tripId: row.tripId,
    placeId: row.placeId,
    position: row.position,
    startTime: row.startTime,
    note: row.note,
  };
}

export function toLegDto(row: LegRow): TransportLegDto {
  return {
    id: row.id,
    dayId: row.dayId,
    tripId: row.tripId,
    fromEntryId: row.fromEntryId,
    toEntryId: row.toEntryId,
    fromPlaceId: row.fromPlaceId,
    toPlaceId: row.toPlaceId,
    seq: row.seq,
    mode: row.mode as TransportLegDto["mode"],
    distanceM: row.distanceM,
    durationS: row.durationS,
    polyline: (row.polyline as TransportLegDto["polyline"]) ?? null,
    computedAt: iso(row.computedAt),
  };
}

export function toHotelDto(row: HotelRow): HotelCandidateDto {
  return {
    id: row.id,
    tripId: row.tripId,
    placeId: row.placeId,
    pricePerNight: row.pricePerNight,
    notes: row.notes,
  };
}

export function toChatSessionDto(row: ChatSessionRow): ChatSessionDto {
  return {
    id: row.id,
    tripId: row.tripId,
    agentRegistryId: row.agentRegistryId,
    agentLabel: row.agentLabel,
    status: row.status as ChatSessionDto["status"],
    allowAllPermissions: row.allowAllPermissions,
    lastError: row.lastError,
    uiContext: (row.uiContext as Record<string, unknown> | null) ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
