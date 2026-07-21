import { z } from "zod";
import { PlatformDataError, type JsonObject, type JsonValue } from "./data";
import type {
  IntegrationInvokeContext,
  IntegrationProviderDefinition,
} from "./integration-catalog";

const GOOGLE_PLACES_SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.types",
  "places.googleMapsUri",
  "places.websiteUri",
].join(",");

const GOOGLE_PLACE_DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "rating",
  "userRatingCount",
  "types",
  "googleMapsUri",
  "websiteUri",
  "nationalPhoneNumber",
  "regularOpeningHours",
  "priceLevel",
].join(",");

const GOOGLE_ROUTES_FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.localizedValues",
  "routes.polyline.encodedPolyline",
  "routes.warnings",
  "routes.legs.duration",
  "routes.legs.distanceMeters",
  "routes.legs.startLocation",
  "routes.legs.endLocation",
  "routes.legs.localizedValues",
].join(",");

const BETA_ROUTE_SAFETY_NOTICE =
  "Walking, bicycling, and two-wheel routes are beta and may be missing clear sidewalks, pedestrian paths, or bicycling paths. Review the route before traveling.";

const googleMapsCredentialSchema = z
  .object({
    apiKey: z.string().trim().min(20).max(200),
  })
  .strict();

const routeTravelModeSchema = z.enum([
  "DRIVE",
  "WALK",
  "BICYCLE",
  "TRANSIT",
  "TWO_WHEELER",
]);

type RouteTravelMode = z.infer<typeof routeTravelModeSchema>;

const coordinateSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

const locationBiasSchema = coordinateSchema
  .extend({
    radiusMeters: z.number().int().min(100).max(50_000).default(10_000),
  })
  .strict();

const googleMapsPlaceSchema = z
  .object({
    placeId: z.string(),
    resourceName: z.string().optional(),
    name: z.string(),
    formattedAddress: z.string().optional(),
    location: coordinateSchema.optional(),
    rating: z.number().optional(),
    userRatingCount: z.number().int().optional(),
    types: z.array(z.string()),
    googleMapsUri: z.string().optional(),
    websiteUri: z.string().optional(),
    phoneNumber: z.string().optional(),
    openingHours: z.array(z.string()).optional(),
    priceLevel: z.string().optional(),
  })
  .strict();

const searchPlacesInputSchema = z
  .object({
    textQuery: z.string().trim().min(1).max(240),
    maxResultCount: z.number().int().min(1).max(10).default(5),
    regionCode: z.string().trim().min(2).max(8).optional(),
    languageCode: z.string().trim().min(2).max(12).optional(),
    includedType: z.string().trim().min(1).max(80).optional(),
    locationBias: locationBiasSchema.optional(),
  })
  .strict();

const searchPlacesOutputSchema = z
  .object({
    provider: z.literal("google_maps"),
    places: z.array(googleMapsPlaceSchema),
  })
  .strict();

const getPlaceDetailsInputSchema = z
  .object({
    placeId: z.string().trim().min(1).max(200),
    regionCode: z.string().trim().min(2).max(8).optional(),
    languageCode: z.string().trim().min(2).max(12).optional(),
  })
  .strict();

const getPlaceDetailsOutputSchema = z
  .object({
    provider: z.literal("google_maps"),
    place: googleMapsPlaceSchema,
  })
  .strict();

const geocodeAddressInputSchema = z
  .object({
    address: z.string().trim().min(1).max(300),
    region: z.string().trim().min(2).max(8).optional(),
    language: z.string().trim().min(2).max(12).optional(),
    countryCode: z.string().trim().min(2).max(8).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

const geocodeResultSchema = z
  .object({
    placeId: z.string().optional(),
    formattedAddress: z.string(),
    location: coordinateSchema,
    locationType: z.string().optional(),
    types: z.array(z.string()),
  })
  .strict();

const geocodeAddressOutputSchema = z
  .object({
    provider: z.literal("google_maps"),
    results: z.array(geocodeResultSchema),
  })
  .strict();

const routeWaypointSchema = z
  .object({
    address: z.string().trim().min(1).max(300).optional(),
    placeId: z.string().trim().min(1).max(200).optional(),
    location: coordinateSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.address || value.placeId || value.location),
    "A waypoint needs an address, placeId, or location.",
  );

const routeModifiersSchema = z
  .object({
    avoidTolls: z.boolean().optional(),
    avoidHighways: z.boolean().optional(),
    avoidFerries: z.boolean().optional(),
  })
  .strict();

const computeRouteInputSchema = z
  .object({
    origin: routeWaypointSchema,
    destination: routeWaypointSchema,
    intermediates: z.array(routeWaypointSchema).max(8).default([]),
    travelMode: routeTravelModeSchema.default("DRIVE"),
    routingPreference: z
      .enum(["TRAFFIC_UNAWARE", "TRAFFIC_AWARE", "TRAFFIC_AWARE_OPTIMAL"])
      .optional(),
    units: z.enum(["METRIC", "IMPERIAL"]).default("METRIC"),
    languageCode: z.string().trim().min(2).max(12).optional(),
    regionCode: z.string().trim().min(2).max(8).optional(),
    routeModifiers: routeModifiersSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.routingPreference &&
      value.travelMode !== "DRIVE" &&
      value.travelMode !== "TWO_WHEELER"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["routingPreference"],
        message:
          "routingPreference is supported only for DRIVE or TWO_WHEELER routes.",
      });
    }
  });

const routeLegSchema = z
  .object({
    distanceMeters: z.number().int().optional(),
    duration: z.string().optional(),
    durationSeconds: z.number().int().optional(),
    localizedDistance: z.string().optional(),
    localizedDuration: z.string().optional(),
    startLocation: coordinateSchema.optional(),
    endLocation: coordinateSchema.optional(),
  })
  .strict();

const computeRouteOutputSchema = z
  .object({
    provider: z.literal("google_maps"),
    route: z
      .object({
        distanceMeters: z.number().int().optional(),
        duration: z.string().optional(),
        durationSeconds: z.number().int().optional(),
        localizedDistance: z.string().optional(),
        localizedDuration: z.string().optional(),
        travelMode: routeTravelModeSchema,
        warnings: z.array(z.string()),
        safetyNotice: z.string().optional(),
        encodedPolyline: z.string().optional(),
        legs: z.array(routeLegSchema),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const googleMapsProvider: IntegrationProviderDefinition = {
  providerKey: "google_maps",
  displayName: "Google Maps",
  description:
    "Trip planning with place search, place details, address geocoding, route estimates, and map display.",
  authType: "api_key",
  credentialSchema: googleMapsCredentialSchema,
  aliases: [
    "google maps",
    "maps",
    "google places",
    "places api",
    "routes api",
    "google routes",
    "geocoding",
    "trip planning",
    "travel planner",
    "itinerary",
    "route planning",
    "bike route",
    "bicycle route",
    "cycling",
    "cycling route",
  ],
  actions: [
    {
      actionKey: "search_places",
      displayName: "Search places",
      description:
        "Search Google Places for hotels, restaurants, attractions, airports, or addresses.",
      requiredRole: "viewer",
      inputSchema: searchPlacesInputSchema,
      outputSchema: searchPlacesOutputSchema,
      invoke: async (input, context) =>
        searchPlaces(input as z.infer<typeof searchPlacesInputSchema>, context),
    },
    {
      actionKey: "get_place_details",
      displayName: "Get place details",
      description:
        "Retrieve address, location, rating, contact, website, and opening-hour details for a place.",
      requiredRole: "viewer",
      inputSchema: getPlaceDetailsInputSchema,
      outputSchema: getPlaceDetailsOutputSchema,
      invoke: async (input, context) =>
        getPlaceDetails(
          input as z.infer<typeof getPlaceDetailsInputSchema>,
          context,
        ),
    },
    {
      actionKey: "geocode_address",
      displayName: "Geocode address",
      description: "Convert an address or landmark into latitude and longitude.",
      requiredRole: "viewer",
      inputSchema: geocodeAddressInputSchema,
      outputSchema: geocodeAddressOutputSchema,
      invoke: async (input, context) =>
        geocodeAddress(
          input as z.infer<typeof geocodeAddressInputSchema>,
          context,
        ),
    },
    {
      actionKey: "compute_route",
      displayName: "Compute route",
      description:
        "Estimate route distance, duration, legs, and encoded polyline for an itinerary.",
      requiredRole: "viewer",
      inputSchema: computeRouteInputSchema,
      outputSchema: computeRouteOutputSchema,
      invoke: async (input, context) =>
        computeRoute(input as z.infer<typeof computeRouteInputSchema>, context),
    },
  ],
};

async function searchPlaces(
  input: z.infer<typeof searchPlacesInputSchema>,
  context: IntegrationInvokeContext,
): Promise<JsonObject> {
  const apiKey = googleMapsApiKey(context);
  const body = compactJsonObject({
    textQuery: input.textQuery,
    maxResultCount: input.maxResultCount,
    regionCode: input.regionCode,
    languageCode: input.languageCode,
    includedType: input.includedType,
    locationBias: input.locationBias
      ? {
          circle: {
            center: {
              latitude: input.locationBias.latitude,
              longitude: input.locationBias.longitude,
            },
            radius: input.locationBias.radiusMeters,
          },
        }
      : undefined,
  });
  const payload = await googleJson(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: googleHeaders(apiKey, GOOGLE_PLACES_SEARCH_FIELD_MASK),
      body: JSON.stringify(body),
    },
  );
  const places = arrayFrom(payload, "places").map(mapGooglePlace).filter(isJsonObject);
  return { provider: "google_maps", places };
}

async function getPlaceDetails(
  input: z.infer<typeof getPlaceDetailsInputSchema>,
  context: IntegrationInvokeContext,
): Promise<JsonObject> {
  const apiKey = googleMapsApiKey(context);
  const placeId = normalizeGooglePlaceId(input.placeId);
  const url = new URL(`https://places.googleapis.com/v1/places/${placeId}`);
  if (input.languageCode) url.searchParams.set("languageCode", input.languageCode);
  if (input.regionCode) url.searchParams.set("regionCode", input.regionCode);
  const payload = await googleJson(url.toString(), {
    method: "GET",
    headers: googleHeaders(apiKey, GOOGLE_PLACE_DETAILS_FIELD_MASK),
  });
  const place = mapGooglePlace(payload);
  if (!place) {
    throw new PlatformDataError(
      502,
      "google_maps_invalid_place",
      "Google Maps returned an invalid place details response.",
    );
  }
  return { provider: "google_maps", place };
}

async function geocodeAddress(
  input: z.infer<typeof geocodeAddressInputSchema>,
  context: IntegrationInvokeContext,
): Promise<JsonObject> {
  const apiKey = googleMapsApiKey(context);
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", input.address);
  url.searchParams.set("key", apiKey);
  if (input.region) url.searchParams.set("region", input.region);
  if (input.language) url.searchParams.set("language", input.language);
  if (input.countryCode) {
    url.searchParams.set("components", `country:${input.countryCode}`);
  }
  const payload = await googleJson(url.toString(), { method: "GET" });
  const status = stringAt(payload, "status");
  if (status === "ZERO_RESULTS") {
    return { provider: "google_maps", results: [] };
  }
  if (status !== "OK") throw googleStatusError(status, payload);
  const results = arrayFrom(payload, "results")
    .slice(0, input.limit)
    .map(mapGeocodeResult)
    .filter(isJsonObject);
  return { provider: "google_maps", results };
}

async function computeRoute(
  input: z.infer<typeof computeRouteInputSchema>,
  context: IntegrationInvokeContext,
): Promise<JsonObject> {
  const apiKey = googleMapsApiKey(context);
  const body = compactJsonObject({
    origin: toGoogleWaypoint(input.origin),
    destination: toGoogleWaypoint(input.destination),
    intermediates:
      input.intermediates.length > 0
        ? input.intermediates.map(toGoogleWaypoint)
        : undefined,
    travelMode: input.travelMode,
    routingPreference: input.routingPreference,
    units: input.units,
    languageCode: input.languageCode,
    regionCode: input.regionCode,
    routeModifiers: input.routeModifiers,
  });
  const payload = await googleJson(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: googleHeaders(apiKey, GOOGLE_ROUTES_FIELD_MASK),
      body: JSON.stringify(body),
    },
  );
  const [route] = arrayFrom(payload, "routes").map(mapRoute).filter(isJsonObject);
  return {
    provider: "google_maps",
    route: route ? withTravelMode(route, input.travelMode) : null,
  };
}

function googleMapsApiKey(context: IntegrationInvokeContext): string {
  const credentialKey = context.credential?.secrets.apiKey;
  const envKey =
    process.env.VOICEFORGE_GOOGLE_MAPS_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
  const apiKey =
    typeof credentialKey === "string" && credentialKey.trim()
      ? credentialKey.trim()
      : envKey?.trim();
  if (!apiKey) {
    throw new PlatformDataError(
      409,
      "google_maps_not_configured",
      "Google Maps is approved, but no server-side Maps API key is configured for this app.",
    );
  }
  return apiKey;
}

function googleHeaders(apiKey: string, fieldMask: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask": fieldMask,
  };
}

async function googleJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init).catch(() => null);
  if (!res) {
    throw new PlatformDataError(
      502,
      "google_maps_unavailable",
      "Google Maps is unavailable right now.",
    );
  }
  const payload = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      nestedString(payload, ["error", "message"]) ??
      stringAt(payload, "error_message") ??
      "Google Maps rejected the request.";
    throw new PlatformDataError(
      res.status >= 500 ? 502 : res.status,
      "google_maps_request_failed",
      message,
    );
  }
  return payload;
}

function googleStatusError(status: string | undefined, payload: unknown): PlatformDataError {
  const code =
    status === "OVER_QUERY_LIMIT" || status === "OVER_DAILY_LIMIT"
      ? "google_maps_quota_exceeded"
      : status === "REQUEST_DENIED"
        ? "google_maps_request_denied"
        : "google_maps_geocode_failed";
  return new PlatformDataError(
    code === "google_maps_quota_exceeded" ? 429 : 502,
    code,
    stringAt(payload, "error_message") ??
      `Google Maps geocoding failed${status ? ` (${status})` : ""}.`,
  );
}

function toGoogleWaypoint(
  input: z.infer<typeof routeWaypointSchema>,
): JsonObject {
  if (input.placeId) return { placeId: normalizeGooglePlaceId(input.placeId) };
  if (input.location) {
    return {
      location: {
        latLng: {
          latitude: input.location.latitude,
          longitude: input.location.longitude,
        },
      },
    };
  }
  return { address: input.address ?? "" };
}

function mapGooglePlace(input: unknown): JsonObject | null {
  if (!isRecord(input)) return null;
  const placeId = stringAt(input, "id") ?? resourceId(stringAt(input, "name"));
  if (!placeId) return null;
  const location = coordinateAt(input, "location");
  return compactJsonObject({
    placeId,
    resourceName: stringAt(input, "name"),
    name: nestedString(input, ["displayName", "text"]) ?? placeId,
    formattedAddress: stringAt(input, "formattedAddress"),
    location,
    rating: numberAt(input, "rating"),
    userRatingCount: integerAt(input, "userRatingCount"),
    types: stringArrayAt(input, "types"),
    googleMapsUri: stringAt(input, "googleMapsUri"),
    websiteUri: stringAt(input, "websiteUri"),
    phoneNumber: stringAt(input, "nationalPhoneNumber"),
    openingHours: stringArrayAt(input, "regularOpeningHours", "weekdayDescriptions"),
    priceLevel: stringAt(input, "priceLevel"),
  });
}

function mapGeocodeResult(input: unknown): JsonObject | null {
  if (!isRecord(input)) return null;
  const location = nestedCoordinate(input, ["geometry", "location"], "lat", "lng");
  const formattedAddress = stringAt(input, "formatted_address");
  if (!location || !formattedAddress) return null;
  return compactJsonObject({
    placeId: stringAt(input, "place_id"),
    formattedAddress,
    location,
    locationType: nestedString(input, ["geometry", "location_type"]),
    types: stringArrayAt(input, "types"),
  });
}

function mapRoute(input: unknown): JsonObject | null {
  if (!isRecord(input)) return null;
  return compactJsonObject({
    distanceMeters: integerAt(input, "distanceMeters"),
    duration: stringAt(input, "duration"),
    durationSeconds: durationSeconds(stringAt(input, "duration")),
    localizedDistance: nestedString(input, ["localizedValues", "distance", "text"]),
    localizedDuration: nestedString(input, ["localizedValues", "duration", "text"]),
    encodedPolyline: nestedString(input, ["polyline", "encodedPolyline"]),
    warnings: stringArrayAt(input, "warnings"),
    legs: arrayFrom(input, "legs").map(mapRouteLeg).filter(isJsonObject),
  });
}

function withTravelMode(route: JsonObject, travelMode: RouteTravelMode): JsonObject {
  const routeWarnings = Array.isArray(route.warnings)
    ? route.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const safetyNotice = betaRouteSafetyNotice(travelMode);
  return compactJsonObject({
    ...route,
    travelMode,
    warnings: uniqueStrings([...(safetyNotice ? [safetyNotice] : []), ...routeWarnings]),
    safetyNotice,
  });
}

function betaRouteSafetyNotice(travelMode: RouteTravelMode): string | undefined {
  return travelMode === "WALK" ||
    travelMode === "BICYCLE" ||
    travelMode === "TWO_WHEELER"
    ? BETA_ROUTE_SAFETY_NOTICE
    : undefined;
}

function mapRouteLeg(input: unknown): JsonObject | null {
  if (!isRecord(input)) return null;
  return compactJsonObject({
    distanceMeters: integerAt(input, "distanceMeters"),
    duration: stringAt(input, "duration"),
    durationSeconds: durationSeconds(stringAt(input, "duration")),
    localizedDistance: nestedString(input, ["localizedValues", "distance", "text"]),
    localizedDuration: nestedString(input, ["localizedValues", "duration", "text"]),
    startLocation: nestedCoordinate(
      input,
      ["startLocation", "latLng"],
      "latitude",
      "longitude",
    ),
    endLocation: nestedCoordinate(
      input,
      ["endLocation", "latLng"],
      "latitude",
      "longitude",
    ),
  });
}

function durationSeconds(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d+)s$/);
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

function normalizeGooglePlaceId(value: string): string {
  return value.trim().replace(/^places\//, "");
}

function resourceId(value: string | undefined): string | undefined {
  return value?.startsWith("places/") ? value.slice("places/".length) : value;
}

function arrayFrom(input: unknown, key: string): unknown[] {
  if (!isRecord(input)) return [];
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function stringAt(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  return typeof input[key] === "string" ? input[key] : undefined;
}

function numberAt(input: unknown, key: string): number | undefined {
  if (!isRecord(input)) return undefined;
  return typeof input[key] === "number" && Number.isFinite(input[key])
    ? input[key]
    : undefined;
}

function integerAt(input: unknown, key: string): number | undefined {
  const value = numberAt(input, key);
  return value === undefined ? undefined : Math.trunc(value);
}

function stringArrayAt(input: unknown, key: string, nestedKey?: string): string[] {
  const source = nestedKey
    ? isRecord(input) && isRecord(input[key])
      ? input[key][nestedKey]
      : undefined
    : isRecord(input)
      ? input[key]
      : undefined;
  return Array.isArray(source)
    ? source.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function nestedString(input: unknown, path: string[]): string | undefined {
  let current = input;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function coordinateAt(input: unknown, key: string): JsonObject | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return nestedCoordinate({ value }, ["value"], "latitude", "longitude");
}

function nestedCoordinate(
  input: unknown,
  path: string[],
  latKey: string,
  lngKey: string,
): JsonObject | undefined {
  let current = input;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  if (!isRecord(current)) return undefined;
  const latitude = current[latKey];
  const longitude = current[lngKey];
  return typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    typeof longitude === "number" &&
    Number.isFinite(longitude)
    ? { latitude, longitude }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonObject | null): value is JsonObject {
  return value !== null;
}

function compactJsonObject(input: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    const jsonValue = toJsonValue(value);
    if (jsonValue !== undefined) output[key] = jsonValue;
  }
  return output;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(toJsonValue)
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (isRecord(value)) return compactJsonObject(value);
  return undefined;
}
