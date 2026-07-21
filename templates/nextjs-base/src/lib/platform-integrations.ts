/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Typed browser client for generated apps that use approved VoiceForge
 * integrations. It talks only to the same-origin /api/integrations route;
 * app tokens and provider credentials remain on the server.
 */

import { getStoredSessionToken } from "./platform-data";

export type PlatformIntegrationProvider = {
  providerKey: string;
  displayName: string;
  description: string;
  authType: "none" | "api_key" | "oauth2";
  actions: Array<{
    actionKey: string;
    displayName: string;
    description: string;
    requiredRole: "viewer" | "editor" | "owner";
  }>;
};

export type InvokePlatformIntegrationInput = {
  providerKey: string;
  actionKey: string;
  input?: Record<string, unknown>;
};

export type GoogleMapsBrowserConfig = {
  enabled: boolean;
  apiKey: string | null;
  mapId: string;
  language?: string;
  region?: string;
  authReferrerPolicy: "origin";
};

export type GoogleMapsCoordinate = {
  latitude: number;
  longitude: number;
};

export type GoogleMapsRouteTravelMode =
  | "DRIVE"
  | "WALK"
  | "BICYCLE"
  | "TRANSIT"
  | "TWO_WHEELER";

export type GoogleMapsRouteWaypoint = {
  address?: string;
  placeId?: string;
  location?: GoogleMapsCoordinate;
  via?: boolean;
};

export type GoogleMapsPlace = {
  placeId?: string;
  id?: string;
  name: string;
  formattedAddress?: string;
  location?: GoogleMapsCoordinate | null;
  rating?: number;
  userRatingCount?: number;
  types?: string[];
  googleMapsUri?: string;
  websiteUri?: string;
  phoneNumber?: string;
  openingHours?: string[];
  priceLevel?: string;
};

export type GoogleMapsRouteStep = {
  distanceMeters?: number;
  duration?: string;
  durationSeconds?: number;
  localizedDistance?: string;
  localizedDuration?: string;
  startLocation?: GoogleMapsCoordinate | null;
  endLocation?: GoogleMapsCoordinate | null;
  encodedPolyline?: string | null;
  instruction?: string;
  maneuver?: string;
  travelMode?: GoogleMapsRouteTravelMode;
};

export type GoogleMapsRouteLeg = {
  distanceMeters?: number;
  duration?: string;
  durationSeconds?: number;
  localizedDistance?: string;
  localizedDuration?: string;
  startLocation?: GoogleMapsCoordinate | null;
  endLocation?: GoogleMapsCoordinate | null;
  steps?: GoogleMapsRouteStep[];
};

export type GoogleMapsRouteViewport = {
  low?: GoogleMapsCoordinate;
  high?: GoogleMapsCoordinate;
};

export type GoogleMapsRoute = {
  routeLabels?: string[];
  description?: string;
  distanceMeters?: number;
  duration?: string;
  durationSeconds?: number;
  localizedDistance?: string;
  localizedDuration?: string;
  encodedPolyline?: string | null;
  path?: GoogleMapsCoordinate[];
  viewport?: GoogleMapsRouteViewport;
  optimizedIntermediateWaypointIndex?: number[];
  travelMode?: GoogleMapsRouteTravelMode;
  warnings?: string[];
  safetyNotice?: string;
  legs?: GoogleMapsRouteLeg[];
};

export type GoogleMapsElevationPoint = {
  location: GoogleMapsCoordinate;
  elevationMeters: number;
  resolutionMeters?: number;
};

export type GoogleMapsElevationProfile = {
  samples: number;
  points: GoogleMapsElevationPoint[];
  minElevationMeters?: number;
  maxElevationMeters?: number;
  totalClimbMeters: number;
  totalDescentMeters: number;
  distanceMeters?: number;
};

export type SearchGoogleMapsPlacesInput = {
  textQuery: string;
  maxResultCount?: number;
  regionCode?: string;
  languageCode?: string;
  includedType?: string;
  locationBias?: GoogleMapsCoordinate & { radiusMeters?: number };
};

export type SearchGoogleMapsPlacesOutput = {
  provider: "google_maps";
  places: GoogleMapsPlace[];
};

export type GetGoogleMapsPlaceDetailsInput = {
  placeId: string;
  regionCode?: string;
  languageCode?: string;
};

export type GetGoogleMapsPlaceDetailsOutput = {
  provider: "google_maps";
  place: GoogleMapsPlace;
};

export type GeocodeGoogleMapsAddressInput = {
  address: string;
  region?: string;
  language?: string;
  countryCode?: string;
  limit?: number;
};

export type GeocodeGoogleMapsAddressOutput = {
  provider: "google_maps";
  results: Array<{
    placeId?: string;
    formattedAddress: string;
    location: GoogleMapsCoordinate;
    locationType?: string;
    types: string[];
  }>;
};

export type ComputeGoogleMapsRouteInput = {
  origin: GoogleMapsRouteWaypoint;
  destination: GoogleMapsRouteWaypoint;
  intermediates?: GoogleMapsRouteWaypoint[];
  travelMode?: GoogleMapsRouteTravelMode;
  routingPreference?: "TRAFFIC_UNAWARE" | "TRAFFIC_AWARE" | "TRAFFIC_AWARE_OPTIMAL";
  computeAlternativeRoutes?: boolean;
  optimizeWaypointOrder?: boolean;
  polylineQuality?: "OVERVIEW" | "HIGH_QUALITY";
  units?: "METRIC" | "IMPERIAL";
  languageCode?: string;
  regionCode?: string;
  routeModifiers?: {
    avoidTolls?: boolean;
    avoidHighways?: boolean;
    avoidFerries?: boolean;
  };
};

export type ComputeGoogleMapsRouteOutput = {
  provider: "google_maps";
  route: GoogleMapsRoute | null;
  routes: GoogleMapsRoute[];
  routeNotice?: string;
};

export type GetGoogleMapsElevationProfileInput =
  | {
      encodedPolyline: string;
      path?: never;
      samples?: number;
    }
  | {
      encodedPolyline?: never;
      path: GoogleMapsCoordinate[];
      samples?: number;
    };

export type GetGoogleMapsElevationProfileOutput = {
  provider: "google_maps";
  profile: GoogleMapsElevationProfile;
};

type RequestBody =
  | { action: "listProviders" }
  | { action: "getGoogleMapsBrowserConfig" }
  | ({ action: "invoke" } & InvokePlatformIntegrationInput);

async function request<TResponse>(body: RequestBody): Promise<TResponse> {
  const res = await fetch("/api/integrations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, sessionToken: getStoredSessionToken() }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & TResponse;
  if (!res.ok) {
    throw new Error(payload.error ?? "Platform integration request failed.");
  }
  return payload;
}

export async function listPlatformIntegrationProviders(): Promise<
  PlatformIntegrationProvider[]
> {
  const result = await request<{ providers: PlatformIntegrationProvider[] }>({
    action: "listProviders",
  });
  return result.providers;
}

export async function invokePlatformIntegration<TOutput = unknown>(
  input: InvokePlatformIntegrationInput,
): Promise<TOutput> {
  const result = await request<{
    providerKey: string;
    actionKey: string;
    result: TOutput;
  }>({
    action: "invoke",
    ...input,
  });
  return result.result;
}

export async function searchGoogleMapsPlaces(
  input: SearchGoogleMapsPlacesInput,
): Promise<SearchGoogleMapsPlacesOutput> {
  return invokePlatformIntegration<SearchGoogleMapsPlacesOutput>({
    providerKey: "google_maps",
    actionKey: "search_places",
    input: integrationInput(input),
  });
}

export async function getGoogleMapsPlaceDetails(
  input: GetGoogleMapsPlaceDetailsInput,
): Promise<GetGoogleMapsPlaceDetailsOutput> {
  return invokePlatformIntegration<GetGoogleMapsPlaceDetailsOutput>({
    providerKey: "google_maps",
    actionKey: "get_place_details",
    input: integrationInput(input),
  });
}

export async function geocodeGoogleMapsAddress(
  input: GeocodeGoogleMapsAddressInput,
): Promise<GeocodeGoogleMapsAddressOutput> {
  return invokePlatformIntegration<GeocodeGoogleMapsAddressOutput>({
    providerKey: "google_maps",
    actionKey: "geocode_address",
    input: integrationInput(input),
  });
}

export async function computeGoogleMapsRoute(
  input: ComputeGoogleMapsRouteInput,
): Promise<ComputeGoogleMapsRouteOutput> {
  return invokePlatformIntegration<ComputeGoogleMapsRouteOutput>({
    providerKey: "google_maps",
    actionKey: "compute_route",
    input: integrationInput(input),
  });
}

export async function getGoogleMapsElevationProfile(
  input: GetGoogleMapsElevationProfileInput,
): Promise<GetGoogleMapsElevationProfileOutput> {
  return invokePlatformIntegration<GetGoogleMapsElevationProfileOutput>({
    providerKey: "google_maps",
    actionKey: "get_elevation_profile",
    input: integrationInput(input),
  });
}

export async function getGoogleMapsBrowserConfig(): Promise<GoogleMapsBrowserConfig> {
  const result = await request<{ config: GoogleMapsBrowserConfig }>({
    action: "getGoogleMapsBrowserConfig",
  });
  return result.config;
}

function integrationInput<TInput extends object>(
  input: TInput,
): Record<string, unknown> {
  return input as Record<string, unknown>;
}
