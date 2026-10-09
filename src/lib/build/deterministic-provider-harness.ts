export const PROVIDER_SCENARIO_VALUES = [
  "success",
  "invalid_response",
  "empty_response",
  "rate_limited",
  "unavailable",
  "permission_denied",
  "oversized_file",
] as const;

export type ProviderScenario = (typeof PROVIDER_SCENARIO_VALUES)[number];
export type DeterministicProvider = "ai" | "maps" | "notifications" | "jobs" | "files" | "location";

export type ProviderHarnessResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
  error: string;
};

export type ProviderHarnessCall = {
  provider: DeterministicProvider;
  scenario: ProviderScenario;
  input: Record<string, unknown>;
};

export function createDeterministicProviderHarness(
  scenarios: Partial<Record<DeterministicProvider, ProviderScenario>> = {},
) {
  const calls: ProviderHarnessCall[] = [];
  return {
    calls,
    invoke(
      provider: DeterministicProvider,
      input: Record<string, unknown> = {},
    ): ProviderHarnessResult {
      const scenario = scenarios[provider] ?? "success";
      calls.push({ provider, scenario, input });
      return providerResult(provider, scenario);
    },
    reset(): void {
      calls.splice(0);
    },
  };
}

function providerResult(
  provider: DeterministicProvider,
  scenario: ProviderScenario,
): ProviderHarnessResult {
  if (scenario === "rate_limited") return failure(429, "Deterministic provider rate limit.");
  if (scenario === "unavailable") return failure(503, "Deterministic provider unavailable.");
  if (scenario === "permission_denied") return failure(403, "Deterministic permission denied.");
  if (scenario === "empty_response") return { ok: true, status: 200, data: {}, error: "" };
  if (scenario === "invalid_response") return { ok: true, status: 200, data: { unexpected: true }, error: "" };
  if (scenario === "oversized_file") {
    return provider === "files"
      ? failure(413, "Deterministic file is too large.")
      : failure(400, "Oversized-file scenario only applies to files.");
  }
  return { ok: true, status: 200, data: successData(provider), error: "" };
}

function successData(provider: DeterministicProvider): Record<string, unknown> {
  if (provider === "ai") return { text: '{"title":"Golden result","quantity":2}', imageBase64: "iVBORw0KGgo=" };
  if (provider === "maps") return { places: [{ id: "place-1", name: "Golden Place" }], routes: [{ id: "route-1", distanceMeters: 12500, elevationGainMeters: 240 }] };
  if (provider === "notifications") return { notificationId: "notification-1", status: "queued" };
  if (provider === "jobs") return { jobId: "job-1", nextRunAt: "2030-01-01T12:00:00.000Z" };
  if (provider === "files") return { fileId: "file-1", fileName: "golden.png", size: 2048 };
  return { latitude: 43.6532, longitude: -79.3832, accuracy: 5, timestamp: 1_893_499_200_000 };
}

function failure(status: number, error: string): ProviderHarnessResult {
  return { ok: false, status, data: {}, error };
}
