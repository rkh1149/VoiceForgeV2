"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getGoogleMapsBrowserConfig,
  type GoogleMapsBrowserConfig,
  type GoogleMapsCoordinate,
  type GoogleMapsPlace,
  type GoogleMapsRoute,
} from "@/lib/platform-integrations";

export type GoogleMapsTripMapProps = {
  places: GoogleMapsPlace[];
  route?: GoogleMapsRoute | null;
  selectedPlaceId?: string | null;
  onSelectPlace?: (placeId: string) => void;
  center?: GoogleMapsCoordinate | null;
  zoom?: number;
  height?: number | string;
  className?: string;
  title?: string;
};

type LatLngLiteral = {
  lat: number;
  lng: number;
};

type GoogleLatLngObject = {
  lat: () => number;
  lng: () => number;
};

type MapInstance = {
  fitBounds: (bounds: BoundsInstance) => void;
  setCenter: (center: LatLngLiteral) => void;
  setZoom: (zoom: number) => void;
};

type BoundsInstance = {
  extend: (point: LatLngLiteral) => void;
};

type MarkerInstance = {
  map: MapInstance | null;
  addListener?: (eventName: string, handler: () => void) => unknown;
};

type PolylineInstance = {
  setMap: (map: MapInstance | null) => void;
};

type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapInstance;
  LatLngBounds: new () => BoundsInstance;
  Polyline?: new (options: Record<string, unknown>) => PolylineInstance;
};

type MarkerLibrary = {
  AdvancedMarkerElement: new (
    options: Record<string, unknown>,
  ) => MarkerInstance;
  PinElement?: new (options: Record<string, unknown>) => { element: HTMLElement };
};

type GeometryLibrary = {
  encoding?: {
    decodePath: (encodedPath: string) => Array<LatLngLiteral | GoogleLatLngObject>;
  };
};

type GoogleMapsApi = {
  importLibrary: (libraryName: string) => Promise<Record<string, unknown>>;
  Polyline?: new (options: Record<string, unknown>) => PolylineInstance;
};

type VoiceForgeGoogleWindow = Window &
  typeof globalThis & {
    google?: { maps?: GoogleMapsApi };
    __voiceForgeGoogleMapsReady?: () => void;
  };

let googleMapsLoaderPromise: Promise<GoogleMapsApi> | null = null;

export function GoogleMapsTripMap({
  places,
  route,
  selectedPlaceId,
  onSelectPlace,
  center,
  zoom = 12,
  height = 420,
  className = "",
  title = "Trip map",
}: GoogleMapsTripMapProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const markerRefs = useRef<MarkerInstance[]>([]);
  const routeRef = useRef<PolylineInstance | null>(null);
  const [config, setConfig] = useState<GoogleMapsBrowserConfig | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "fallback" | "error"
  >("loading");
  const [error, setError] = useState("");

  const validPlaces = useMemo(
    () => places.filter((place) => coordinateToLatLng(place.location)),
    [places],
  );
  const fallbackRoutePath = useMemo(() => pathFromRouteLegs(route), [route]);
  const selectedKey = selectedPlaceId ?? placeKey(validPlaces[0], 0);
  const resolvedHeight = typeof height === "number" ? `${height}px` : height;

  useEffect(() => {
    let active = true;
    setStatus("loading");
    setError("");
    getGoogleMapsBrowserConfig()
      .then((nextConfig) => {
        if (!active) return;
        setConfig(nextConfig);
        if (!nextConfig.enabled || !nextConfig.apiKey) {
          setStatus("fallback");
        }
      })
      .catch((nextError) => {
        if (!active) return;
        setStatus("fallback");
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Google Maps is not configured for this app yet.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!config?.enabled || !config.apiKey || !mapElementRef.current) return;
    const readyConfig = config as GoogleMapsBrowserConfig & { apiKey: string };
    let active = true;

    async function renderMap() {
      setStatus("loading");
      try {
        const mapsApi = await loadGoogleMapsApi(readyConfig);
        const mapsLibrary = (await mapsApi.importLibrary(
          "maps",
        )) as unknown as MapsLibrary;
        const markerLibrary = (await mapsApi.importLibrary(
          "marker",
        )) as unknown as MarkerLibrary;
        const geometryLibrary = (await mapsApi
          .importLibrary("geometry")
          .catch(() => ({}))) as unknown as GeometryLibrary;
        if (!active || !mapElementRef.current) return;

        clearMapObjects(markerRefs.current, routeRef.current);
        markerRefs.current = [];
        routeRef.current = null;

        const routePath = pathFromRoute(route, geometryLibrary);
        const initialCenter =
          coordinateToLatLng(center) ??
          coordinateToLatLng(validPlaces[0]?.location) ??
          routePath[0] ??
          fallbackRoutePath[0] ?? { lat: 43.6532, lng: -79.3832 };
        const map =
          mapRef.current ??
          new mapsLibrary.Map(mapElementRef.current, {
            center: initialCenter,
            zoom,
            mapId: readyConfig.mapId || "DEMO_MAP_ID",
            fullscreenControl: true,
            mapTypeControl: false,
            streetViewControl: false,
          });
        mapRef.current = map;

        const bounds = new mapsLibrary.LatLngBounds();
        let hasBounds = false;
        validPlaces.forEach((place, index) => {
          const position = coordinateToLatLng(place.location);
          if (!position) return;
          const markerOptions: Record<string, unknown> = {
            map,
            position,
            title: place.name,
          };
          if (markerLibrary.PinElement) {
            markerOptions.content = new markerLibrary.PinElement({
              glyph: String(index + 1),
              background:
                placeKey(place, index) === selectedKey ? "#0f766e" : "#2563eb",
              borderColor: "#ffffff",
              glyphColor: "#ffffff",
            }).element;
          }
          const marker = new markerLibrary.AdvancedMarkerElement(markerOptions);
          marker.addListener?.("click", () => {
            onSelectPlace?.(placeKey(place, index));
          });
          markerRefs.current.push(marker);
          bounds.extend(position);
          hasBounds = true;
        });

        const Polyline = mapsLibrary.Polyline ?? mapsApi.Polyline;
        if (routePath.length > 1 && Polyline) {
          const routeLine = new Polyline({
            path: routePath,
            geodesic: true,
            strokeColor: "#0f766e",
            strokeOpacity: 0.9,
            strokeWeight: 5,
          });
          routeLine.setMap(map);
          routeRef.current = routeLine;
          routePath.forEach((point) => {
            bounds.extend(point);
            hasBounds = true;
          });
        }

        if (hasBounds) {
          map.fitBounds(bounds);
        } else {
          map.setCenter(initialCenter);
          map.setZoom(zoom);
        }
        setStatus("ready");
        setError("");
      } catch (nextError) {
        if (!active) return;
        setStatus("error");
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Google Maps could not be loaded.",
        );
      }
    }

    void renderMap();
    return () => {
      active = false;
    };
  }, [
    center,
    config,
    fallbackRoutePath,
    onSelectPlace,
    route,
    selectedKey,
    validPlaces,
    zoom,
  ]);

  return (
    <section
      className={`overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}
      aria-label={title}
    >
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]">
        <div className="relative bg-slate-100" style={{ minHeight: resolvedHeight }}>
          {(status === "loading" || status === "ready") && (
            <div
              ref={mapElementRef}
              role="region"
              aria-label="Interactive Google map"
              className="absolute inset-0"
            />
          )}
          {status !== "ready" && (
            <MapFallback
              status={status}
              error={error}
              places={validPlaces}
              routePath={fallbackRoutePath}
            />
          )}
        </div>
        <aside className="max-h-[520px] overflow-auto border-t border-slate-200 bg-white p-4 lg:border-l lg:border-t-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-950">{title}</h2>
              {route?.localizedDistance || route?.localizedDuration ? (
                <p className="mt-1 text-sm text-slate-600">
                  {[route.localizedDistance, route.localizedDuration]
                    .filter(Boolean)
                    .join(" - ")}
                </p>
              ) : (
                <p className="mt-1 text-sm text-slate-600">
                  {validPlaces.length} mapped place
                  {validPlaces.length === 1 ? "" : "s"}
                </p>
              )}
            </div>
            <span className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800">
              {status === "ready" ? "Live map" : "Map preview"}
            </span>
          </div>
          <div className="mt-4 space-y-3">
            {validPlaces.length === 0 ? (
              <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-600">
                Add places with coordinates to show pins on the map.
              </p>
            ) : (
              validPlaces.map((place, index) => (
                <PlaceCard
                  key={placeKey(place, index)}
                  place={place}
                  index={index}
                  selected={placeKey(place, index) === selectedKey}
                  onSelect={() => onSelectPlace?.(placeKey(place, index))}
                />
              ))
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function PlaceCard({
  place,
  index,
  selected,
  onSelect,
}: {
  place: GoogleMapsPlace;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border p-3 text-left transition ${
        selected
          ? "border-emerald-500 bg-emerald-50"
          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
          {index + 1}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-950">
            {place.name}
          </span>
          {place.formattedAddress && (
            <span className="mt-1 block text-sm text-slate-600">
              {place.formattedAddress}
            </span>
          )}
          {typeof place.rating === "number" && (
            <span className="mt-2 block text-xs text-slate-500">
              Rating {place.rating.toFixed(1)}
              {typeof place.userRatingCount === "number"
                ? ` from ${place.userRatingCount.toLocaleString()} reviews`
                : ""}
            </span>
          )}
        </span>
      </div>
    </button>
  );
}

function MapFallback({
  status,
  error,
  places,
  routePath,
}: {
  status: "loading" | "fallback" | "error";
  error: string;
  places: GoogleMapsPlace[];
  routePath: LatLngLiteral[];
}) {
  return (
    <div className="absolute inset-0 flex flex-col justify-between bg-slate-100 p-5 text-slate-700">
      <div>
        <p className="text-sm font-semibold text-slate-950">
          {status === "loading" ? "Loading Google Maps..." : "Map preview"}
        </p>
        <p className="mt-1 max-w-xl text-sm">
          {status === "error" && error
            ? error
            : "Pins and routes will render on live Google map tiles when the browser map key is available."}
        </p>
      </div>
      <div className="relative mt-6 h-48 rounded-lg border border-slate-300 bg-white">
        {places.slice(0, 6).map((place, index) => {
          const position = fallbackPinPosition(index, places.length);
          return (
            <span
              key={placeKey(place, index)}
              className="absolute flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white shadow"
              style={{ left: position.left, top: position.top }}
              title={place.name}
            >
              {index + 1}
            </span>
          );
        })}
        {routePath.length > 1 && (
          <svg
            aria-hidden="true"
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <path
              d="M18 70 C 35 35, 62 58, 82 24"
              fill="none"
              stroke="#0f766e"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        )}
      </div>
    </div>
  );
}

function loadGoogleMapsApi(
  config: GoogleMapsBrowserConfig & { apiKey: string },
): Promise<GoogleMapsApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Maps can load only in the browser."));
  }
  const win = window as VoiceForgeGoogleWindow;
  if (win.google?.maps?.importLibrary) {
    return Promise.resolve(win.google.maps);
  }
  if (googleMapsLoaderPromise) return googleMapsLoaderPromise;

  googleMapsLoaderPromise = new Promise((resolve, reject) => {
    const callbackName = "__voiceForgeGoogleMapsReady";
    win[callbackName] = () => {
      const maps = win.google?.maps;
      if (!maps?.importLibrary) {
        reject(new Error("Google Maps loaded without the expected libraries."));
        return;
      }
      resolve(maps);
    };

    const params = new URLSearchParams({
      key: config.apiKey,
      v: "weekly",
      callback: callbackName,
      libraries: "maps,marker,geometry",
      auth_referrer_policy: config.authReferrerPolicy,
    });
    if (config.language) params.set("language", config.language);
    if (config.region) params.set("region", config.region);

    const script = document.createElement("script");
    script.id = "voiceforge-google-maps-js";
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.onerror = () => {
      googleMapsLoaderPromise = null;
      reject(new Error("Google Maps could not be loaded."));
    };
    document.head.appendChild(script);
  });
  return googleMapsLoaderPromise;
}

function clearMapObjects(
  markers: MarkerInstance[],
  routeLine: PolylineInstance | null,
): void {
  markers.forEach((marker) => {
    marker.map = null;
  });
  routeLine?.setMap(null);
}

function coordinateToLatLng(
  coordinate: GoogleMapsCoordinate | null | undefined,
): LatLngLiteral | null {
  if (
    !coordinate ||
    !Number.isFinite(coordinate.latitude) ||
    !Number.isFinite(coordinate.longitude)
  ) {
    return null;
  }
  return { lat: coordinate.latitude, lng: coordinate.longitude };
}

function normalizeLatLng(
  point: LatLngLiteral | GoogleLatLngObject,
): LatLngLiteral | null {
  if (isDecodedLatLngLiteral(point)) {
    return Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
  }
  if (typeof point.lat === "function" && typeof point.lng === "function") {
    const lat = point.lat();
    const lng = point.lng();
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  return null;
}

function isDecodedLatLngLiteral(
  point: LatLngLiteral | GoogleLatLngObject,
): point is LatLngLiteral {
  return typeof point.lat === "number" && typeof point.lng === "number";
}

function pathFromRoute(
  route: GoogleMapsRoute | null | undefined,
  geometryLibrary: GeometryLibrary,
): LatLngLiteral[] {
  const explicitPath =
    route?.path?.map(coordinateToLatLng).filter(isLatLngLiteral) ?? [];
  if (explicitPath.length > 1) return explicitPath;

  const encoded = route?.encodedPolyline?.trim();
  if (encoded && geometryLibrary.encoding?.decodePath) {
    try {
      const decoded = geometryLibrary.encoding
        .decodePath(encoded)
        .map(normalizeLatLng)
        .filter(isLatLngLiteral);
      if (decoded.length > 1) return decoded;
    } catch {
      // Local fallback routes use a preview token, so decoding can fail safely.
    }
  }

  return pathFromRouteLegs(route);
}

function pathFromRouteLegs(
  route: GoogleMapsRoute | null | undefined,
): LatLngLiteral[] {
  const points: LatLngLiteral[] = [];
  for (const leg of route?.legs ?? []) {
    const start = coordinateToLatLng(leg.startLocation);
    const end = coordinateToLatLng(leg.endLocation);
    if (start) points.push(start);
    if (end) points.push(end);
  }
  return points;
}

function isLatLngLiteral(point: LatLngLiteral | null): point is LatLngLiteral {
  return Boolean(point);
}

function placeKey(place: GoogleMapsPlace | undefined, index: number): string {
  return place?.placeId ?? place?.id ?? `${place?.name ?? "place"}-${index}`;
}

function fallbackPinPosition(
  index: number,
  total: number,
): { left: string; top: string } {
  const count = Math.max(total, 1);
  const x = 16 + ((index * 53) % 68);
  const y = 18 + (((index * 29) + count * 7) % 58);
  return { left: `${x}%`, top: `${y}%` };
}
