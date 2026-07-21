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
  "routes.routeLabels",
  "routes.duration",
  "routes.distanceMeters",
  "routes.description",
  "routes.localizedValues",
  "routes.polyline.encodedPolyline",
  "routes.warnings",
  "routes.viewport",
  "routes.optimizedIntermediateWaypointIndex",
  "routes.legs.duration",
  "routes.legs.distanceMeters",
  "routes.legs.startLocation",
  "routes.legs.endLocation",
  "routes.legs.localizedValues",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.startLocation",
  "routes.legs.steps.endLocation",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.localizedValues",
  "routes.legs.steps.travelMode",
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
    via: z.boolean().optional(),
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
    intermediates: z.array(routeWaypointSchema).max(25).default([]),
    travelMode: routeTravelModeSchema.default("DRIVE"),
    routingPreference: z
      .enum(["TRAFFIC_UNAWARE", "TRAFFIC_AWARE", "TRAFFIC_AWARE_OPTIMAL"])
      .optional(),
    computeAlternativeRoutes: z.boolean().optional(),
    optimizeWaypointOrder: z.boolean().optional(),
    polylineQuality: z.enum(["OVERVIEW", "HIGH_QUALITY"]).optional(),
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
    if (value.origin.via) {
      ctx.addIssue({
        code: "custom",
        path: ["origin", "via"],
        message: "via can be used only on intermediate waypoints.",
      });
    }
    if (value.destination.via) {
      ctx.addIssue({
        code: "custom",
        path: ["destination", "via"],
        message: "via can be used only on intermediate waypoints.",
      });
    }
    if (
      value.optimizeWaypointOrder &&
      value.intermediates.some((waypoint) => waypoint.via)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["optimizeWaypointOrder"],
        message:
          "optimizeWaypointOrder cannot be combined with via waypoints.",
      });
    }
  });

const routeViewportSchema = z
  .object({
    low: coordinateSchema.optional(),
    high: coordinateSchema.optional(),
  })
  .strict();

const routeStepSchema = z
  .object({
    distanceMeters: z.number().int().optional(),
    duration: z.string().optional(),
    durationSeconds: z.number().int().optional(),
    localizedDistance: z.string().optional(),
    localizedDuration: z.string().optional(),
    startLocation: coordinateSchema.optional(),
    endLocation: coordinateSchema.optional(),
    encodedPolyline: z.string().optional(),
    instruction: z.string().optional(),
    maneuver: z.string().optional(),
    travelMode: routeTravelModeSchema.optional(),
  })
  .strict();

const routeLegSchema = z
  .object({
    distanceMeters: z.number().int().optional(),
    duration: z.string().optional(),
    durationSeconds: z.number().int().optional(),
    localizedDistance: z.string().optional(),
    localizedDuration: z.string().optional(),
    startLocation: coordinateSchema.optional(),
    endLocation: coordinateSchema.optional(),
    steps: z.array(routeStepSchema).optional(),
  })
  .strict();

const routeSchema = z
  .object({
    routeLabels: z.array(z.string()).optional(),
    description: z.string().optional(),
    distanceMeters: z.number().int().optional(),
    duration: z.string().optional(),
    durationSeconds: z.number().int().optional(),
    localizedDistance: z.string().optional(),
    localizedDuration: z.string().optional(),
    travelMode: routeTravelModeSchema,
    warnings: z.array(z.string()),
    safetyNotice: z.string().optional(),
    encodedPolyline: z.string().optional(),
    viewport: routeViewportSchema.optional(),
    optimizedIntermediateWaypointIndex: z.array(z.number().int()).optional(),
    legs: z.array(routeLegSchema),
  })
  .strict();

const computeRouteOutputSchema = z
  .object({
    provider: z.literal("google_maps"),
    route: routeSchema.nullable(),
    routes: z.array(routeSchema),
    routeNotice: z.string().optional(),
  })
  .strict();

const elevationProfileInputSchema = z
  .object({
    encodedPolyline: z.string().trim().min(2).max(16_000).optional(),
    path: z.array(coordinateSchema).min(2).max(512).optional(),
    samples: z.number().int().min(2).max(256).default(64),
  })
  .strict()
  .refine(
    (value) => Boolean(value.encodedPolyline || value.path?.length),
    "Provide either encodedPolyline or a path with at least two coordinates.",
  );

const elevationPointSchema = z
  .object({
    location: coordinateSchema,
    elevationMeters: z.number(),
    resolutionMeters: z.number().optional(),
  })
  .strict();

const elevationProfileSchema = z
  .object({
    samples: z.number().int(),
    points: z.array(elevationPointSchema),
    minElevationMeters: z.number().optional(),
    maxElevationMeters: z.number().optional(),
    totalClimbMeters: z.number(),
    totalDescentMeters: z.number(),
    distanceMeters: z.number().int().optional(),
  })
  .strict();

const elevationProfileOutputSchema = z
  .object({
    provider: z.literal("google_maps"),
    profile: elevationProfileSchema,
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
    "elevation profile",
    "bike elevation",
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
        "Estimate route distance, duration, alternatives, legs, waypoints, and encoded polyline for an itinerary.",
      requiredRole: "viewer",
      inputSchema: computeRouteInputSchema,
      outputSchema: computeRouteOutputSchema,
      invoke: async (input, context) =>
        computeRoute(input as z.infer<typeof computeRouteInputSchema>, context),
    },
    {
      actionKey: "get_elevation_profile",
      displayName: "Get elevation profile",
      description:
        "Sample elevation along a route path or encoded polyline for bike-trip climb and descent planning.",
      requiredRole: "viewer",
      inputSchema: elevationProfileInputSchema,
      outputSchema: elevationProfileOutputSchema,
      invoke: async (input, context) =>
        getElevationProfile(
          input as z.infer<typeof elevationProfileInputSchema>,
          context,
        ),
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
    computeAlternativeRoutes: input.computeAlternativeRoutes,
    optimizeWaypointOrder: input.optimizeWaypointOrder,
    polylineQuality: input.polylineQuality,
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
  const routes = arrayFrom(payload, "routes")
    .map(mapRoute)
    .filter(isJsonObject)
    .map((route) => withTravelMode(route, input.travelMode));
  const routeNotice =
    input.computeAlternativeRoutes && input.intermediates.length > 0
      ? "Google Routes does not return alternate routes when intermediate waypoints are present."
      : undefined;
  return compactJsonObject({
    provider: "google_maps",
    route: routes[0] ?? null,
    routes,
    routeNotice,
  });
}

async function getElevationProfile(
  input: z.infer<typeof elevationProfileInputSchema>,
  context: IntegrationInvokeContext,
): Promise<JsonObject> {
  const apiKey = googleMapsApiKey(context);
  const url = new URL("https://maps.googleapis.com/maps/api/elevation/json");
  url.searchParams.set("samples", String(input.samples));
  url.searchParams.set("key", apiKey);
  if (input.encodedPolyline) {
    url.searchParams.set("path", `enc:${input.encodedPolyline}`);
  } else {
    url.searchParams.set(
      "path",
      (input.path ?? [])
        .map((point) => `${point.latitude},${point.longitude}`)
        .join("|"),
    );
  }

  const payload = await googleJson(url.toString(), { method: "GET" });
  const status = stringAt(payload, "status");
  if (status === "DATA_NOT_AVAILABLE") {
    return {
      provider: "google_maps",
      profile: {
        samples: input.samples,
        points: [],
        totalClimbMeters: 0,
        totalDescentMeters: 0,
      },
    };
  }
  if (status !== "OK") throw googleStatusError(status, payload, "elevation");
  const points = arrayFrom(payload, "results")
    .map(mapElevationPoint)
    .filter(isJsonObject);
  const stats = elevationStats(points);
  return {
    provider: "google_maps",
    profile: compactJsonObject({
      samples: input.samples,
      points,
      ...stats,
    }),
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

function googleStatusError(
  status: string | undefined,
  payload: unknown,
  service = "geocoding",
): PlatformDataError {
  const code =
    status === "OVER_QUERY_LIMIT" || status === "OVER_DAILY_LIMIT"
      ? "google_maps_quota_exceeded"
      : status === "REQUEST_DENIED"
        ? "google_maps_request_denied"
        : `google_maps_${service}_failed`;
  return new PlatformDataError(
    code === "google_maps_quota_exceeded" ? 429 : 502,
    code,
    stringAt(payload, "error_message") ??
      `Google Maps ${service} failed${status ? ` (${status})` : ""}.`,
  );
}

function toGoogleWaypoint(
  input: z.infer<typeof routeWaypointSchema>,
): JsonObject {
  if (input.placeId) {
    return compactJsonObject({
      placeId: normalizeGooglePlaceId(input.placeId),
      via: input.via,
    });
  }
  if (input.location) {
    return compactJsonObject({
      location: {
        latLng: {
          latitude: input.location.latitude,
          longitude: input.location.longitude,
        },
      },
      via: input.via,
    });
  }
  return compactJsonObject({ address: input.address ?? "", via: input.via });
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
    routeLabels: stringArrayAt(input, "routeLabels"),
    description: stringAt(input, "description"),
    distanceMeters: integerAt(input, "distanceMeters"),
    duration: stringAt(input, "duration"),
    durationSeconds: durationSeconds(stringAt(input, "duration")),
    localizedDistance: nestedString(input, ["localizedValues", "distance", "text"]),
    localizedDuration: nestedString(input, ["localizedValues", "duration", "text"]),
    encodedPolyline: nestedString(input, ["polyline", "encodedPolyline"]),
    warnings: stringArrayAt(input, "warnings"),
    viewport: mapViewport(input),
    optimizedIntermediateWaypointIndex: numberArrayAt(
      input,
      "optimizedIntermediateWaypointIndex",
    ),
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
    steps: arrayFrom(input, "steps").map(mapRouteStep).filter(isJsonObject),
  });
}

function mapRouteStep(input: unknown): JsonObject | null {
  if (!isRecord(input)) return null;
  const duration = stringAt(input, "staticDuration");
  return compactJsonObject({
    distanceMeters: integerAt(input, "distanceMeters"),
    duration,
    durationSeconds: durationSeconds(duration),
    localizedDistance: nestedString(input, ["localizedValues", "distance", "text"]),
    localizedDuration: nestedString(
      input,
      ["localizedValues", "staticDuration", "text"],
    ),
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
    encodedPolyline: nestedString(input, ["polyline", "encodedPolyline"]),
    instruction: nestedString(input, ["navigationInstruction", "instructions"]),
    maneuver: nestedString(input, ["navigationInstruction", "maneuver"]),
    travelMode: routeTravelModeAt(input, "travelMode"),
  });
}

function mapViewport(input: unknown): JsonObject | undefined {
  if (!isRecord(input) || !isRecord(input.viewport)) return undefined;
  return compactJsonObject({
    low: nestedCoordinate(input, ["viewport", "low"], "latitude", "longitude"),
    high: nestedCoordinate(input, ["viewport", "high"], "latitude", "longitude"),
  });
}

function mapElevationPoint(input: unknown): JsonObject | null {
  if (!isRecord(input)) return null;
  const location = nestedCoordinate(input, ["location"], "lat", "lng");
  const elevationMeters = numberAt(input, "elevation");
  if (!location || elevationMeters === undefined) return null;
  return compactJsonObject({
    location,
    elevationMeters,
    resolutionMeters: numberAt(input, "resolution"),
  });
}

function elevationStats(points: JsonObject[]): JsonObject {
  const elevations = points
    .map((point) => numberAt(point, "elevationMeters"))
    .filter((value): value is number => value !== undefined);
  if (elevations.length === 0) {
    return {
      totalClimbMeters: 0,
      totalDescentMeters: 0,
    };
  }
  let totalClimbMeters = 0;
  let totalDescentMeters = 0;
  for (let index = 1; index < elevations.length; index += 1) {
    const delta = elevations[index] - elevations[index - 1];
    if (delta > 0) totalClimbMeters += delta;
    if (delta < 0) totalDescentMeters += Math.abs(delta);
  }
  return compactJsonObject({
    minElevationMeters: Math.min(...elevations),
    maxElevationMeters: Math.max(...elevations),
    totalClimbMeters: Math.round(totalClimbMeters * 10) / 10,
    totalDescentMeters: Math.round(totalDescentMeters * 10) / 10,
    distanceMeters: routeDistanceFromPoints(points),
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

function numberArrayAt(input: unknown, key: string): number[] {
  if (!isRecord(input) || !Array.isArray(input[key])) return [];
  return input[key]
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    .map((item) => Math.trunc(item));
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

function routeTravelModeAt(input: unknown, key: string): RouteTravelMode | undefined {
  const value = stringAt(input, key);
  const parsed = routeTravelModeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function coordinateAt(input: unknown, key: string): JsonObject | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return nestedCoordinate({ value }, ["value"], "latitude", "longitude");
}

function routeDistanceFromPoints(points: JsonObject[]): number | undefined {
  const coordinates = points
    .map((point) => (isRecord(point.location) ? point.location : undefined))
    .map((location) => {
      const latitude = numberAt(location, "latitude");
      const longitude = numberAt(location, "longitude");
      return latitude !== undefined && longitude !== undefined
        ? { latitude, longitude }
        : null;
    })
    .filter(
      (
        coordinate,
      ): coordinate is { latitude: number; longitude: number } =>
        coordinate !== null,
    );
  if (coordinates.length < 2) return undefined;
  let distanceMeters = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    distanceMeters += haversineMeters(coordinates[index - 1], coordinates[index]);
  }
  return Math.round(distanceMeters);
}

function haversineMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const earthRadiusMeters = 6_371_000;
  const fromLat = degreesToRadians(from.latitude);
  const toLat = degreesToRadians(to.latitude);
  const deltaLat = degreesToRadians(to.latitude - from.latitude);
  const deltaLng = degreesToRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(fromLat) *
      Math.cos(toLat) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
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
