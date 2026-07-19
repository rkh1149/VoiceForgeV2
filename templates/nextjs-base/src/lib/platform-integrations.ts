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

type RequestBody =
  | { action: "listProviders" }
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
