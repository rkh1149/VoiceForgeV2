/**
 * LOCKED PLATFORM FILE - managed by VoiceForge. Do not modify.
 *
 * Browser-only device location helpers for generated apps. These wrap the
 * Web Geolocation API with typed results, consistent permission/error handling,
 * track summaries, and GPX export helpers. Location access always requires the
 * rider's browser/device permission and runs only while the web app is active.
 */

export type DeviceLocationPermissionState =
  | "granted"
  | "prompt"
  | "denied"
  | "unsupported"
  | "unknown";

export type DeviceLocationErrorCode =
  | "unsupported"
  | "permission_denied"
  | "position_unavailable"
  | "timeout"
  | "unknown";

export type DeviceLocationFix = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  altitudeMeters?: number | null;
  altitudeAccuracyMeters?: number | null;
  headingDegrees?: number | null;
  speedMetersPerSecond?: number | null;
  timestamp: string;
  timestampMs: number;
  source: "browser_geolocation";
};

export type DeviceLocationOptions = {
  enableHighAccuracy?: boolean;
  timeoutMs?: number;
  maximumAgeMs?: number;
};

export type DeviceLocationWatchInput = DeviceLocationOptions & {
  minDistanceMeters?: number;
  throttleMs?: number;
  onLocation: (location: DeviceLocationFix) => void;
  onError?: (error: DeviceLocationError) => void;
};

export type DeviceLocationWatchHandle = {
  stop: () => void;
};

export type DeviceTrackSummary = {
  pointCount: number;
  startedAt?: string;
  endedAt?: string;
  distanceMeters: number;
  durationSeconds: number;
  averageSpeedMetersPerSecond?: number;
  latest?: DeviceLocationFix;
};

const DEFAULT_LOCATION_OPTIONS: Required<DeviceLocationOptions> = {
  enableHighAccuracy: true,
  timeoutMs: 15_000,
  maximumAgeMs: 5_000,
};

export class DeviceLocationError extends Error {
  code: DeviceLocationErrorCode;

  constructor(code: DeviceLocationErrorCode, message: string) {
    super(message);
    this.name = "DeviceLocationError";
    this.code = code;
  }
}

export function deviceLocationSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.geolocation) &&
    typeof navigator.geolocation.getCurrentPosition === "function" &&
    typeof navigator.geolocation.watchPosition === "function"
  );
}

export async function getDeviceLocationPermission(): Promise<DeviceLocationPermissionState> {
  if (!deviceLocationSupported()) return "unsupported";
  const permissions = navigator.permissions;
  if (!permissions?.query) return "unknown";
  try {
    const status = await permissions.query({ name: "geolocation" as PermissionName });
    if (
      status.state === "granted" ||
      status.state === "prompt" ||
      status.state === "denied"
    ) {
      return status.state;
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

export async function getCurrentDeviceLocation(
  options: DeviceLocationOptions = {},
): Promise<DeviceLocationFix> {
  assertDeviceLocationSupported();
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(positionToFix(position)),
      (error) => reject(toDeviceLocationError(error)),
      toGeolocationOptions(options),
    );
  });
}

export function watchDeviceLocation(
  input: DeviceLocationWatchInput,
): DeviceLocationWatchHandle {
  assertDeviceLocationSupported();
  let active = true;
  let lastLocation: DeviceLocationFix | null = null;
  let lastEmittedAtMs = 0;
  const minDistanceMeters = Math.max(input.minDistanceMeters ?? 0, 0);
  const throttleMs = Math.max(input.throttleMs ?? 0, 0);

  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      if (!active) return;
      const location = positionToFix(position);
      if (
        lastLocation &&
        minDistanceMeters > 0 &&
        distanceBetweenDeviceLocations(lastLocation, location) < minDistanceMeters
      ) {
        return;
      }
      if (
        lastLocation &&
        throttleMs > 0 &&
        location.timestampMs - lastEmittedAtMs < throttleMs
      ) {
        return;
      }
      lastLocation = location;
      lastEmittedAtMs = location.timestampMs;
      input.onLocation(location);
    },
    (error) => {
      if (!active) return;
      input.onError?.(toDeviceLocationError(error));
    },
    toGeolocationOptions(input),
  );

  return {
    stop: () => {
      if (!active) return;
      active = false;
      navigator.geolocation.clearWatch(watchId);
    },
  };
}

export function appendDeviceTrackPoint(
  track: readonly DeviceLocationFix[],
  point: DeviceLocationFix,
  maxTrackPoints = 5_000,
): DeviceLocationFix[] {
  const limit = Math.max(Math.trunc(maxTrackPoints), 1);
  const next = [...track, point];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function summarizeDeviceTrack(
  track: readonly DeviceLocationFix[],
): DeviceTrackSummary {
  const latest = track.at(-1);
  const first = track[0];
  const durationSeconds =
    first && latest
      ? Math.max(0, Math.round((latest.timestampMs - first.timestampMs) / 1000))
      : 0;
  const distanceMeters = Math.round(trackDistanceMeters(track));
  return {
    pointCount: track.length,
    ...(first ? { startedAt: first.timestamp } : {}),
    ...(latest ? { endedAt: latest.timestamp, latest } : {}),
    distanceMeters,
    durationSeconds,
    ...(durationSeconds > 0
      ? { averageSpeedMetersPerSecond: distanceMeters / durationSeconds }
      : {}),
  };
}

export function trackDistanceMeters(track: readonly DeviceLocationFix[]): number {
  let total = 0;
  for (let index = 1; index < track.length; index += 1) {
    total += distanceBetweenDeviceLocations(track[index - 1], track[index]);
  }
  return total;
}

export function distanceBetweenDeviceLocations(
  from: Pick<DeviceLocationFix, "latitude" | "longitude">,
  to: Pick<DeviceLocationFix, "latitude" | "longitude">,
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

export function exportDeviceTrackGpx(
  trackName: string,
  track: readonly DeviceLocationFix[],
): string {
  const safeName = xmlEscape(trackName.trim() || "Device GPS Track");
  const points = track
    .map((point) => {
      const altitude =
        typeof point.altitudeMeters === "number"
          ? `<ele>${point.altitudeMeters}</ele>`
          : "";
      return `      <trkpt lat="${point.latitude}" lon="${point.longitude}">${altitude}<time>${point.timestamp}</time></trkpt>`;
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="VoiceForge" xmlns="http://www.topografix.com/GPX/1/1">',
    "  <trk>",
    `    <name>${safeName}</name>`,
    "    <trkseg>",
    points,
    "    </trkseg>",
    "  </trk>",
    "</gpx>",
    "",
  ].join("\n");
}

export function formatLocationDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "0 m";
  if (Math.abs(meters) < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatLocationSpeed(
  metersPerSecond: number | null | undefined,
): string {
  if (typeof metersPerSecond !== "number" || !Number.isFinite(metersPerSecond)) {
    return "Unknown";
  }
  return `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}

function assertDeviceLocationSupported(): void {
  if (!deviceLocationSupported()) {
    throw new DeviceLocationError(
      "unsupported",
      "Device location is not available in this browser.",
    );
  }
}

function toGeolocationOptions(options: DeviceLocationOptions): PositionOptions {
  return {
    enableHighAccuracy:
      options.enableHighAccuracy ?? DEFAULT_LOCATION_OPTIONS.enableHighAccuracy,
    timeout: options.timeoutMs ?? DEFAULT_LOCATION_OPTIONS.timeoutMs,
    maximumAge: options.maximumAgeMs ?? DEFAULT_LOCATION_OPTIONS.maximumAgeMs,
  };
}

function positionToFix(position: GeolocationPosition): DeviceLocationFix {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: position.coords.accuracy,
    altitudeMeters: position.coords.altitude,
    altitudeAccuracyMeters: position.coords.altitudeAccuracy,
    headingDegrees: position.coords.heading,
    speedMetersPerSecond: position.coords.speed,
    timestamp: new Date(position.timestamp).toISOString(),
    timestampMs: position.timestamp,
    source: "browser_geolocation",
  };
}

function toDeviceLocationError(error: GeolocationPositionError): DeviceLocationError {
  if (error.code === 1) {
    return new DeviceLocationError(
      "permission_denied",
      "Location permission was denied.",
    );
  }
  if (error.code === 2) {
    return new DeviceLocationError(
      "position_unavailable",
      "The device location is unavailable right now.",
    );
  }
  if (error.code === 3) {
    return new DeviceLocationError(
      "timeout",
      "The device location request timed out.",
    );
  }
  return new DeviceLocationError(
    "unknown",
    error.message || "Device location failed.",
  );
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
