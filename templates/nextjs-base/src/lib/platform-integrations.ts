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
};

export type GoogleMapsRoute = {
  encodedPolyline?: string | null;
  path?: GoogleMapsCoordinate[];
  localizedDistance?: string;
  localizedDuration?: string;
  legs?: Array<{
    startLocation?: GoogleMapsCoordinate | null;
    endLocation?: GoogleMapsCoordinate | null;
    localizedDistance?: string;
    localizedDuration?: string;
  }>;
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

export async function getGoogleMapsBrowserConfig(): Promise<GoogleMapsBrowserConfig> {
  const result = await request<{ config: GoogleMapsBrowserConfig }>({
    action: "getGoogleMapsBrowserConfig",
  });
  return result.config;
}
