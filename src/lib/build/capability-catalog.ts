export const GOLDEN_CAPABILITY_VALUES = [
  "browser_persistence",
  "platform_data",
  "authentication_roles",
  "record_ownership",
  "related_records",
  "workflow_handoff",
  "search_filter_sort",
  "files_images",
  "pdf_csv_exports",
  "notifications_jobs",
  "maps_routing_elevation",
  "device_location_gps",
  "ai_text_image",
  "drag_drop",
  "dates_calendars",
  "reports_saved_filters",
] as const;

export type GoldenCapabilityId = (typeof GOLDEN_CAPABILITY_VALUES)[number];

export type GoldenCapabilityDefinition = {
  id: GoldenCapabilityId;
  label: string;
  risk: "low" | "medium" | "high";
  platformServices: string[];
  requiredProof: string[];
  failureScenarios: string[];
};

export const GOLDEN_CAPABILITY_CATALOG: Record<
  GoldenCapabilityId,
  GoldenCapabilityDefinition
> = {
  browser_persistence: capability("browser_persistence", "Browser persistence", "medium", [], [
    "A saved record survives remount and reload.",
  ], ["corrupt browser data", "empty storage"]),
  platform_data: capability("platform_data", "Shared platform data", "high", ["data"], [
    "Exact entity and field keys are written and reloaded.",
  ], ["validation rejection", "network failure"]),
  authentication_roles: capability("authentication_roles", "Authentication and roles", "high", ["users"], [
    "Owner/editor/viewer controls and writes match server roles.",
  ], ["signed out", "no access", "read-only viewer"]),
  record_ownership: capability("record_ownership", "Record ownership", "high", ["data", "users"], [
    "Only the record owner can perform ownership-restricted mutations.",
  ], ["non-owner update", "non-owner delete"]),
  related_records: capability("related_records", "Related and child records", "high", ["data"], [
    "Valid relation ids save and unknown ids are rejected.",
  ], ["missing parent", "unknown relation id"]),
  workflow_handoff: capability("workflow_handoff", "Cross-workflow handoff", "high", ["data"], [
    "A producer saves a stable reference and its consumer reloads it.",
  ], ["missing producer save", "consumer has no options"]),
  search_filter_sort: capability("search_filter_sort", "Search, filter, and sort", "medium", [], [
    "Saved records are queryable with deterministic filtering and sorting.",
  ], ["empty result", "no indexed fields"]),
  files_images: capability("files_images", "Files and images", "high", ["files"], [
    "Bytes use platform files while records keep only small references.",
  ], ["oversized file", "unsupported type", "missing download"]),
  pdf_csv_exports: capability("pdf_csv_exports", "PDF and CSV exports", "medium", ["reports"], [
    "Exports contain valid bytes and expected rows.",
  ], ["empty export", "invalid PDF bytes"]),
  notifications_jobs: capability("notifications_jobs", "Notifications and scheduled jobs", "high", ["email", "jobs"], [
    "Approved notifications and durable jobs use locked platform services.",
  ], ["provider unavailable", "invalid schedule", "rate limit"]),
  maps_routing_elevation: capability("maps_routing_elevation", "Maps, routing, and elevation", "high", ["integrations"], [
    "Places, route alternatives, warnings, maps, and elevation remain connected.",
  ], ["no route", "elevation unavailable", "provider quota"]),
  device_location_gps: capability("device_location_gps", "Device location and GPS", "high", ["device_location"], [
    "Permission-aware tracking saves points against a selected durable route.",
  ], ["permission denied", "position unavailable"]),
  ai_text_image: capability("ai_text_image", "AI text and image generation", "high", ["ai"], [
    "Unknown AI responses are validated and generated images use file storage.",
  ], ["invalid JSON", "empty response", "rate limit"]),
  drag_drop: capability("drag_drop", "Drag and drop", "medium", [], [
    "Pointer/keyboard movement persists and tests use a MIME-keyed DataTransfer store.",
  ], ["missing MIME payload", "save failure"]),
  dates_calendars: capability("dates_calendars", "Dates and calendars", "medium", [], [
    "Date values remain stable across input, persistence, and display.",
  ], ["timezone boundary", "invalid date"]),
  reports_saved_filters: capability("reports_saved_filters", "Reports and saved filters", "medium", ["reports", "search"], [
    "Filters, grouped reports, and exports are computed from durable records.",
  ], ["deleted filter", "empty report"]),
};

export const REQUIRED_CAPABILITY_PAIRS: Array<
  readonly [GoldenCapabilityId, GoldenCapabilityId]
> = [
  ["platform_data", "authentication_roles"],
  ["platform_data", "related_records"],
  ["record_ownership", "authentication_roles"],
  ["related_records", "workflow_handoff"],
  ["files_images", "pdf_csv_exports"],
  ["ai_text_image", "files_images"],
  ["notifications_jobs", "dates_calendars"],
  ["maps_routing_elevation", "device_location_gps"],
  ["device_location_gps", "workflow_handoff"],
  ["platform_data", "search_filter_sort"],
  ["reports_saved_filters", "pdf_csv_exports"],
  ["drag_drop", "platform_data"],
  ["dates_calendars", "platform_data"],
] as const;

function capability(
  id: GoldenCapabilityId,
  label: string,
  risk: GoldenCapabilityDefinition["risk"],
  platformServices: string[],
  requiredProof: string[],
  failureScenarios: string[],
): GoldenCapabilityDefinition {
  return {
    id,
    label,
    risk,
    platformServices,
    requiredProof,
    failureScenarios,
  };
}
