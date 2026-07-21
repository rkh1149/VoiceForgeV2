import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendDeviceTrackPoint,
  exportDeviceTrackGpx,
  getCurrentDeviceLocation,
  summarizeDeviceTrack,
  watchDeviceLocation,
  type DeviceLocationFix,
} from "../../../templates/nextjs-base/src/lib/device-location";

type MockGeolocationPosition = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    altitudeAccuracy: number | null;
    heading: number | null;
    speed: number | null;
  };
  timestamp: number;
};

function position(input: {
  latitude: number;
  longitude: number;
  timestamp: number;
  speed?: number | null;
}): MockGeolocationPosition {
  return {
    coords: {
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: input.speed ?? null,
    },
    timestamp: input.timestamp,
  };
}

describe("generated app device location helper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the browser current location into a typed fix", async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success(
        position({
          latitude: 43.6426,
          longitude: -79.3871,
          timestamp: Date.parse("2026-07-21T12:00:00.000Z"),
          speed: 5.4,
        }) as GeolocationPosition,
      );
    });
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition,
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      },
    });

    const fix = await getCurrentDeviceLocation();

    expect(fix).toMatchObject({
      latitude: 43.6426,
      longitude: -79.3871,
      accuracyMeters: 8,
      speedMetersPerSecond: 5.4,
      timestamp: "2026-07-21T12:00:00.000Z",
      source: "browser_geolocation",
    });
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true }),
    );
  });

  it("watches location, filters tiny moves, and stops the browser watch", () => {
    const callbacks: { success?: PositionCallback } = {};
    const clearWatch = vi.fn();
    const watchPosition = vi.fn((success: PositionCallback) => {
      callbacks.success = success;
      return 42;
    });
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: vi.fn(),
        watchPosition,
        clearWatch,
      },
    });
    const onLocation = vi.fn();

    const handle = watchDeviceLocation({
      minDistanceMeters: 20,
      onLocation,
    });

    callbacks.success?.(
      position({
        latitude: 43.6426,
        longitude: -79.3871,
        timestamp: Date.parse("2026-07-21T12:00:00.000Z"),
      }) as GeolocationPosition,
    );
    callbacks.success?.(
      position({
        latitude: 43.64261,
        longitude: -79.38711,
        timestamp: Date.parse("2026-07-21T12:00:10.000Z"),
      }) as GeolocationPosition,
    );
    callbacks.success?.(
      position({
        latitude: 43.646,
        longitude: -79.39,
        timestamp: Date.parse("2026-07-21T12:02:00.000Z"),
      }) as GeolocationPosition,
    );

    expect(onLocation).toHaveBeenCalledTimes(2);
    handle.stop();
    expect(clearWatch).toHaveBeenCalledWith(42);
  });

  it("summarizes tracks and exports GPX", () => {
    const first: DeviceLocationFix = {
      latitude: 43.6426,
      longitude: -79.3871,
      accuracyMeters: 7,
      timestamp: "2026-07-21T12:00:00.000Z",
      timestampMs: Date.parse("2026-07-21T12:00:00.000Z"),
      source: "browser_geolocation",
    };
    const second: DeviceLocationFix = {
      ...first,
      latitude: 43.646,
      longitude: -79.39,
      timestamp: "2026-07-21T12:02:00.000Z",
      timestampMs: Date.parse("2026-07-21T12:02:00.000Z"),
    };

    const track = appendDeviceTrackPoint([first], second, 10);
    const summary = summarizeDeviceTrack(track);
    const gpx = exportDeviceTrackGpx("Bike & Coffee", track);

    expect(summary).toMatchObject({
      pointCount: 2,
      durationSeconds: 120,
      latest: second,
    });
    expect(summary.distanceMeters).toBeGreaterThan(300);
    expect(gpx).toContain("<name>Bike &amp; Coffee</name>");
    expect(gpx).toContain('<trkpt lat="43.646" lon="-79.39">');
  });
});
