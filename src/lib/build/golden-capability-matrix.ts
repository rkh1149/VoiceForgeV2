import {
  GOLDEN_CAPABILITY_VALUES,
  REQUIRED_CAPABILITY_PAIRS,
  type GoldenCapabilityId,
} from "./capability-catalog";
import type { GoldenRegressionSpecId } from "./golden-regression-specs";

export type GoldenExecutionTier =
  | "fast"
  | "browser"
  | "database"
  | "provider_canary";

export type GoldenCapabilityCase = {
  id: string;
  specId: GoldenRegressionSpecId;
  capabilities: GoldenCapabilityId[];
  executionTiers: GoldenExecutionTier[];
  requiredProof: string[];
};

export const GOLDEN_CAPABILITY_MATRIX: GoldenCapabilityCase[] = [
  golden("personal-crud", "simple-local-storage", [
    "browser_persistence",
    "search_filter_sort",
  ], ["fast", "browser"], ["Create and reload a browser-local record."]),
  golden("shared-role-crud", "shared-platform-data", [
    "platform_data",
    "authentication_roles",
    "search_filter_sort",
    "dates_calendars",
  ], ["fast", "database", "browser"], ["Owner/editor writes succeed and viewer writes fail."]),
  golden("files-and-exports", "file-export", [
    "platform_data",
    "authentication_roles",
    "files_images",
    "pdf_csv_exports",
  ], ["fast", "browser", "provider_canary"], ["Files remain external to records and exports contain valid bytes."]),
  golden("scheduled-notifications", "notification-reminder", [
    "platform_data",
    "authentication_roles",
    "notifications_jobs",
    "dates_calendars",
  ], ["fast", "provider_canary"], ["A dated reminder queues through deterministic platform providers."]),
  golden("search-reports", "integration-search-report", [
    "platform_data",
    "authentication_roles",
    "search_filter_sort",
    "reports_saved_filters",
    "pdf_csv_exports",
  ], ["fast", "database", "provider_canary"], ["Saved filters, reports, and CSV operate on durable records."]),
  golden("ai-owned-related-records", "family-recipe-ai-shared", [
    "platform_data",
    "authentication_roles",
    "record_ownership",
    "related_records",
    "workflow_handoff",
    "search_filter_sort",
    "files_images",
    "ai_text_image",
  ], ["fast", "database", "browser", "provider_canary"], ["AI output is normalized, stored safely, and handed to related workflows."]),
  golden("route-to-location", "route-location-planner", [
    "platform_data",
    "authentication_roles",
    "related_records",
    "workflow_handoff",
    "files_images",
    "pdf_csv_exports",
    "maps_routing_elevation",
    "device_location_gps",
    "dates_calendars",
  ], ["fast", "browser", "provider_canary"], ["A selected route is saved, reloaded by tracking, and exported."]),
  golden("board-calendar", "board-calendar-planner", [
    "platform_data",
    "authentication_roles",
    "workflow_handoff",
    "search_filter_sort",
    "drag_drop",
    "dates_calendars",
  ], ["fast", "database", "browser"], ["A dragged item persists and remains visible on its calendar date."]),
];

export type GoldenCapabilityCoverage = {
  coveredCapabilities: GoldenCapabilityId[];
  missingCapabilities: GoldenCapabilityId[];
  missingPairs: Array<readonly [GoldenCapabilityId, GoldenCapabilityId]>;
  duplicateIds: string[];
};

export function analyzeGoldenCapabilityCoverage(
  cases: readonly GoldenCapabilityCase[] = GOLDEN_CAPABILITY_MATRIX,
): GoldenCapabilityCoverage {
  const covered = new Set(cases.flatMap((item) => item.capabilities));
  const counts = new Map<string, number>();
  for (const item of cases) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return {
    coveredCapabilities: GOLDEN_CAPABILITY_VALUES.filter((id) => covered.has(id)),
    missingCapabilities: GOLDEN_CAPABILITY_VALUES.filter((id) => !covered.has(id)),
    missingPairs: REQUIRED_CAPABILITY_PAIRS.filter(
      ([left, right]) =>
        !cases.some(
          (item) =>
            item.capabilities.includes(left) && item.capabilities.includes(right),
        ),
    ),
    duplicateIds: [...counts]
      .filter(([, count]) => count > 1)
      .map(([id]) => id),
  };
}

function golden(
  id: string,
  specId: GoldenRegressionSpecId,
  capabilities: GoldenCapabilityId[],
  executionTiers: GoldenExecutionTier[],
  requiredProof: string[],
): GoldenCapabilityCase {
  return { id, specId, capabilities, executionTiers, requiredProof };
}
