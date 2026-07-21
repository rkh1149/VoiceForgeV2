"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Search } from "lucide-react";
import {
  geocodeGoogleMapsAddress,
  getGoogleMapsBrowserConfig,
  searchGoogleMapsPlaces,
  type GoogleMapsBrowserConfig,
  type GoogleMapsCoordinate,
  type GoogleMapsElevationProfile,
  type GoogleMapsPlace,
  type GoogleMapsRoute,
} from "@/lib/platform-integrations";

export type GoogleMapsTripMapProps = {
  places: GoogleMapsPlace[];
  route?: GoogleMapsRoute | null;
  routes?: GoogleMapsRoute[] | null;
  selectedRouteIndex?: number;
  onSelectRoute?: (routeIndex: number) => void;
  elevationProfile?: GoogleMapsElevationProfile | null;
  selectedPlaceId?: string | null;
  onSelectPlace?: (placeId: string) => void;
  center?: GoogleMapsCoordinate | null;
  zoom?: number;
  showBicyclingLayer?: boolean | "auto";
  height?: number | string;
  className?: string;
  title?: string;
};

export type GooglePlaceAutocompleteResult = {
  placeId?: string;
  name: string;
  formattedAddress?: string;
  location?: GoogleMapsCoordinate | null;
  googleMapsUri?: string;
};

export type GooglePlaceAutocompleteProps = {
  label?: string;
  placeholder?: string;
  includedRegionCodes?: string[];
  includedPrimaryTypes?: string[];
  locationBias?: GoogleMapsCoordinate & { radiusMeters?: number };
  className?: string;
  onPlaceSelect: (place: GooglePlaceAutocompleteResult) => void;
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

type BoundsConstructor = new () => BoundsInstance;

type MarkerInstance = {
  map: MapInstance | null;
  addListener?: (eventName: string, handler: () => void) => unknown;
  addEventListener?: (eventName: string, handler: () => void) => void;
};

type PolylineInstance = {
  setMap: (map: MapInstance | null) => void;
};

type LayerInstance = {
  setMap: (map: MapInstance | null) => void;
};

type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapInstance;
  LatLngBounds?: BoundsConstructor;
  Polyline?: new (options: Record<string, unknown>) => PolylineInstance;
  BicyclingLayer?: new () => LayerInstance;
};

type CoreLibrary = {
  LatLngBounds?: BoundsConstructor;
};

type MarkerLibrary = {
  AdvancedMarkerElement: new (
    options: Record<string, unknown>,
  ) => MarkerInstance;
  PinElement?: new (options: Record<string, unknown>) => HTMLElement;
};

type GeometryLibrary = {
  encoding?: {
    decodePath: (encodedPath: string) => Array<LatLngLiteral | GoogleLatLngObject>;
  };
};

type PlacesLibrary = {
  AutocompleteSuggestion?: {
    fetchAutocompleteSuggestions: (
      request: Record<string, unknown>,
    ) => Promise<
      | { suggestions?: GoogleAutocompleteSuggestion[] }
      | GoogleAutocompleteSuggestion[]
    >;
  };
  AutocompleteSessionToken?: new () => unknown;
};

type GoogleAutocompleteSuggestion = {
  placePrediction?: GooglePlacePrediction;
};

type GoogleFormattableText = {
  text?: string;
  toString?: () => string;
};

type GooglePlacePrediction = {
  toPlace?: () => GooglePlaceResult;
  placeId?: string;
  mainText?: GoogleFormattableText | string;
  secondaryText?: GoogleFormattableText | string;
  text?: GoogleFormattableText | string;
  types?: string[];
};

type GooglePlaceResult = {
  id?: string;
  displayName?: string;
  formattedAddress?: string;
  location?: unknown;
  googleMapsURI?: string;
  googleMapsUri?: string;
  fetchFields?: (options: { fields: string[] }) => Promise<void>;
  toJSON?: () => unknown;
};

type GoogleMapsApi = {
  importLibrary: (libraryName: string) => Promise<Record<string, unknown>>;
  LatLngBounds?: BoundsConstructor;
  Polyline?: new (options: Record<string, unknown>) => PolylineInstance;
  BicyclingLayer?: new () => LayerInstance;
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
  routes,
  selectedRouteIndex = 0,
  onSelectRoute,
  elevationProfile,
  selectedPlaceId,
  onSelectPlace,
  center,
  zoom = 12,
  showBicyclingLayer = "auto",
  height = 420,
  className = "",
  title = "Trip map",
}: GoogleMapsTripMapProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const markerRefs = useRef<MarkerInstance[]>([]);
  const routeRef = useRef<PolylineInstance | null>(null);
  const bicyclingLayerRef = useRef<LayerInstance | null>(null);
  const [config, setConfig] = useState<GoogleMapsBrowserConfig | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "fallback" | "error"
  >("loading");
  const [error, setError] = useState("");
  const routeOptions = useMemo(
    () => normalizeRouteOptions(route, routes),
    [route, routes],
  );
  const activeRouteIndex =
    routeOptions.length === 0
      ? -1
      : Math.min(Math.max(selectedRouteIndex, 0), routeOptions.length - 1);
  const activeRoute =
    activeRouteIndex >= 0 ? routeOptions[activeRouteIndex] ?? null : null;

  const validPlaces = useMemo(
    () => places.filter((place) => coordinateToLatLng(place.location)),
    [places],
  );
  const fallbackRoutePath = useMemo(
    () => pathFromRouteLegs(activeRoute),
    [activeRoute],
  );
  const selectedKey = selectedPlaceId ?? placeKey(validPlaces[0], 0);
  const routeSafetyMessages = useMemo(
    () => routeWarnings(activeRoute),
    [activeRoute],
  );
  const shouldShowBicyclingLayer =
    showBicyclingLayer === true ||
    (showBicyclingLayer === "auto" && activeRoute?.travelMode === "BICYCLE");
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
        const coreLibrary = (await mapsApi
          .importLibrary("core")
          .catch(() => ({}))) as unknown as CoreLibrary;
        const geometryLibrary = (await mapsApi
          .importLibrary("geometry")
          .catch(() => ({}))) as unknown as GeometryLibrary;
        if (!active || !mapElementRef.current) return;

        clearMapObjects(
          markerRefs.current,
          routeRef.current,
          bicyclingLayerRef.current,
        );
        markerRefs.current = [];
        routeRef.current = null;
        bicyclingLayerRef.current = null;

        const routePath = pathFromRoute(activeRoute, geometryLibrary);
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

        const LatLngBounds = resolveLatLngBoundsConstructor(
          coreLibrary,
          mapsApi,
          mapsLibrary,
        );
        const bounds = LatLngBounds ? new LatLngBounds() : null;
        let hasBounds = false;
        validPlaces.forEach((place, index) => {
          const position = coordinateToLatLng(place.location);
          if (!position) return;
          const markerOptions: Record<string, unknown> = {
            map,
            position,
            title: place.name,
            gmpClickable: Boolean(onSelectPlace),
          };
          if (markerLibrary.PinElement) {
            markerOptions.content = new markerLibrary.PinElement({
              glyphText: String(index + 1),
              background:
                placeKey(place, index) === selectedKey ? "#0f766e" : "#2563eb",
              borderColor: "#ffffff",
              glyphColor: "#ffffff",
            });
          }
          const marker = new markerLibrary.AdvancedMarkerElement(markerOptions);
          const selectMarker = () => {
            onSelectPlace?.(placeKey(place, index));
          };
          if (marker.addEventListener) marker.addEventListener("gmp-click", selectMarker);
          else marker.addListener?.("click", selectMarker);
          markerRefs.current.push(marker);
          bounds?.extend(position);
          hasBounds = Boolean(bounds);
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
            bounds?.extend(point);
            hasBounds = Boolean(bounds);
          });
        }

        const BicyclingLayer =
          mapsLibrary.BicyclingLayer ?? mapsApi.BicyclingLayer;
        if (shouldShowBicyclingLayer && BicyclingLayer) {
          const bicyclingLayer = new BicyclingLayer();
          bicyclingLayer.setMap(map);
          bicyclingLayerRef.current = bicyclingLayer;
        }

        if (hasBounds && bounds) {
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
    activeRoute,
    selectedKey,
    shouldShowBicyclingLayer,
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
              {activeRoute?.localizedDistance || activeRoute?.localizedDuration ? (
                <p className="mt-1 text-sm text-slate-600">
                  {[activeRoute.localizedDistance, activeRoute.localizedDuration]
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
              {shouldShowBicyclingLayer && status === "ready"
                ? "Bike map"
                : status === "ready"
                  ? "Live map"
                  : "Map preview"}
            </span>
          </div>
          {routeSafetyMessages.length > 0 && (
            <div
              role="note"
              className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
            >
              {routeSafetyMessages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          )}
          {routeOptions.length > 0 && (
            <RouteCards
              routes={routeOptions}
              selectedRouteIndex={activeRouteIndex}
              onSelectRoute={onSelectRoute}
            />
          )}
          {elevationProfile && elevationProfile.points.length > 1 && (
            <ElevationProfileCard profile={elevationProfile} />
          )}
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
          <p className="mt-4 border-t border-slate-200 pt-3 text-xs text-slate-500">
            Powered by Google, &copy;{new Date().getFullYear()} Google
          </p>
        </aside>
      </div>
    </section>
  );
}

export function GooglePlaceAutocomplete({
  label = "Search for a place",
  placeholder = "Search for a place",
  includedRegionCodes,
  includedPrimaryTypes,
  locationBias,
  className = "",
  onPlaceSelect,
}: GooglePlaceAutocompleteProps) {
  const inputId = useId();
  const listboxId = useId();
  const placesLibraryRef = useRef<PlacesLibrary | null>(null);
  const sessionTokenRef = useRef<unknown>(null);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<GoogleAutocompleteSuggestion[]>(
    [],
  );
  const [isSearching, setIsSearching] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [status, setStatus] = useState<
    "loading" | "ready" | "fallback" | "error"
  >("loading");
  const [error, setError] = useState("");
  const trimmedQuery = query.trim();

  useEffect(() => {
    let active = true;

    setStatus("loading");
    setError("");

    async function loadPlacesAutocomplete() {
      try {
        const config = await getGoogleMapsBrowserConfig();
        if (!active) return;
        if (!config.enabled || !config.apiKey) {
          setStatus("fallback");
          return;
        }
        const mapsApi = await loadGoogleMapsApi({
          ...config,
          apiKey: config.apiKey,
        });
        const placesLibrary = (await mapsApi.importLibrary(
          "places",
        )) as unknown as PlacesLibrary;
        if (!placesLibrary.AutocompleteSuggestion) {
          setStatus("fallback");
          setError("Google place suggestions are unavailable.");
          return;
        }
        placesLibraryRef.current = placesLibrary;
        sessionTokenRef.current = createAutocompleteSessionToken(placesLibrary);
        setStatus("ready");
      } catch (nextError) {
        if (!active) return undefined;
        setStatus("error");
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Google Place Autocomplete could not be loaded.",
        );
      }
    }

    void loadPlacesAutocomplete();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (status !== "ready" || trimmedQuery.length < 2) {
      setSuggestions([]);
      setIsSuggesting(false);
      return;
    }
    const placesLibrary = placesLibraryRef.current;
    const AutocompleteSuggestion = placesLibrary?.AutocompleteSuggestion;
    if (!placesLibrary || !AutocompleteSuggestion) return;

    let active = true;
    const timeout = window.setTimeout(() => {
      setIsSuggesting(true);
      const request = autocompleteRequestFromProps({
        input: trimmedQuery,
        sessionToken: sessionTokenRef.current,
        includedRegionCodes,
        includedPrimaryTypes,
        locationBias,
      });
      AutocompleteSuggestion.fetchAutocompleteSuggestions(request)
        .then((response) => {
          if (!active) return;
          const nextSuggestions = Array.isArray(response)
            ? response
            : response.suggestions ?? [];
          setSuggestions(
            nextSuggestions
              .filter((suggestion) => suggestion.placePrediction)
              .slice(0, 5),
          );
          setError("");
        })
        .catch(() => {
          if (!active) return;
          setSuggestions([]);
        })
        .finally(() => {
          if (active) setIsSuggesting(false);
        });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [
    includedPrimaryTypes,
    includedRegionCodes,
    locationBias,
    status,
    trimmedQuery,
  ]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void searchForTypedPlace({
      query: trimmedQuery,
      firstSuggestion: suggestions[0],
      setQuery,
      setError,
      setIsSearching,
      setSuggestions,
      resetSessionToken: () => {
        sessionTokenRef.current = createAutocompleteSessionToken(
          placesLibraryRef.current,
        );
      },
      onPlaceSelect,
    });
  };

  const handleSuggestionSelect = (suggestion: GoogleAutocompleteSuggestion) => {
    void selectAutocompleteSuggestion({
      suggestion,
      setQuery,
      setError,
      setIsSearching,
      setSuggestions,
      resetSessionToken: () => {
        sessionTokenRef.current = createAutocompleteSessionToken(
          placesLibraryRef.current,
        );
      },
      onPlaceSelect,
    });
  };

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        className="mb-1 block text-sm font-medium text-slate-700"
      >
        {label}
      </label>
      <form className="relative" onSubmit={handleSubmit}>
        <div className="flex min-h-11 overflow-hidden rounded-md border border-slate-300 bg-white shadow-sm focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-200">
          <input
            id={inputId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? listboxId : undefined}
            className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-sm text-slate-950 outline-none placeholder:text-slate-400"
          />
          <button
            type="submit"
            disabled={!trimmedQuery || isSearching}
            aria-label={`Search ${label}`}
            className="flex w-11 shrink-0 items-center justify-center border-l border-slate-200 text-slate-600 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {suggestions.length > 0 && (
          <div
            id={listboxId}
            role="listbox"
            className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          >
            {suggestions.map((suggestion, index) => {
              const labelText = suggestionLabel(suggestion, index);
              return (
                <button
                  key={`${suggestion.placePrediction?.placeId ?? labelText}-${index}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => handleSuggestionSelect(suggestion)}
                  className="block w-full px-3 py-2 text-left text-sm text-slate-800 transition hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
                >
                  <span className="block font-medium text-slate-950">
                    {mainSuggestionText(suggestion) || labelText}
                  </span>
                  {secondarySuggestionText(suggestion) && (
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {secondarySuggestionText(suggestion)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </form>
      {status !== "ready" && (
        <p className="mt-1 text-xs text-slate-500">
          {status === "loading"
            ? "Loading place search..."
            : error || "Place search is available when Google Maps is configured."}
        </p>
      )}
      {status === "ready" && isSuggesting && (
        <p className="mt-1 text-xs text-slate-500">Searching places...</p>
      )}
      {status === "ready" && error && (
        <p className="mt-1 text-xs text-amber-700">{error}</p>
      )}
    </div>
  );
}

function RouteCards({
  routes,
  selectedRouteIndex,
  onSelectRoute,
}: {
  routes: GoogleMapsRoute[];
  selectedRouteIndex: number;
  onSelectRoute?: (routeIndex: number) => void;
}) {
  return (
    <div className="mt-4 space-y-2">
      <h3 className="text-sm font-semibold text-slate-950">Route options</h3>
      {routes.map((route, index) => {
        const selected = index === selectedRouteIndex;
        return (
          <button
            key={`${route.encodedPolyline ?? "route"}-${index}`}
            type="button"
            onClick={() => onSelectRoute?.(index)}
            className={`w-full rounded-md border p-3 text-left transition ${
              selected
                ? "border-emerald-500 bg-emerald-50"
                : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-950">
                  {routeLabel(route, index)}
                </span>
                {(route.localizedDistance || route.localizedDuration) && (
                  <span className="mt-1 block text-sm text-slate-600">
                    {[route.localizedDistance, route.localizedDuration]
                      .filter(Boolean)
                      .join(" - ")}
                  </span>
                )}
                {route.description && (
                  <span className="mt-1 block text-xs text-slate-500">
                    {route.description}
                  </span>
                )}
                {route.legs?.length ? (
                  <span className="mt-2 block text-xs text-slate-500">
                    {route.legs.length} leg{route.legs.length === 1 ? "" : "s"}
                    {routeStepCount(route) > 0
                      ? `, ${routeStepCount(route)} cue${routeStepCount(route) === 1 ? "" : "s"}`
                      : ""}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                {route.travelMode ?? "Route"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ElevationProfileCard({ profile }: { profile: GoogleMapsElevationProfile }) {
  const chartPoints = elevationChartPoints(profile);
  const distance = profile.distanceMeters
    ? `${(profile.distanceMeters / 1000).toFixed(1)} km`
    : undefined;
  return (
    <section className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Elevation</h3>
          <p className="mt-1 text-xs text-slate-600">
            {[
              `${Math.round(profile.totalClimbMeters)} m climb`,
              `${Math.round(profile.totalDescentMeters)} m descent`,
              distance,
            ]
              .filter(Boolean)
              .join(" - ")}
          </p>
        </div>
        {typeof profile.maxElevationMeters === "number" && (
          <span className="rounded-md bg-white px-2 py-1 text-xs font-medium text-slate-700">
            {Math.round(profile.maxElevationMeters)} m high
          </span>
        )}
      </div>
      <svg
        aria-label="Elevation profile"
        role="img"
        viewBox="0 0 240 72"
        className="mt-3 h-24 w-full"
        preserveAspectRatio="none"
      >
        <path
          d="M0 70 H240"
          stroke="#cbd5e1"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={chartPoints}
          fill="none"
          stroke="#0f766e"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
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
          {(place.phoneNumber || place.websiteUri) && (
            <span className="mt-1 block text-xs text-slate-500">
              {[place.phoneNumber, place.websiteUri ? domainLabel(place.websiteUri) : ""]
                .filter(Boolean)
                .join(" - ")}
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

type PlaceSearchState = {
  setQuery: (query: string) => void;
  setError: (message: string) => void;
  setIsSearching: (isSearching: boolean) => void;
  setSuggestions: (suggestions: GoogleAutocompleteSuggestion[]) => void;
  resetSessionToken: () => void;
  onPlaceSelect: (place: GooglePlaceAutocompleteResult) => void;
};

async function searchForTypedPlace({
  query,
  firstSuggestion,
  ...state
}: PlaceSearchState & {
  query: string;
  firstSuggestion?: GoogleAutocompleteSuggestion;
}): Promise<void> {
  if (!query) return;
  if (firstSuggestion) {
    await selectAutocompleteSuggestion({
      suggestion: firstSuggestion,
      ...state,
    });
    return;
  }

  state.setIsSearching(true);
  try {
    const selected = await placeFromServerSearch(query);
    state.setError(selected.location ? "" : "No exact place found; using typed text.");
    state.setQuery(selected.formattedAddress ?? selected.name);
    state.setSuggestions([]);
    state.onPlaceSelect(selected);
  } catch (nextError) {
    state.setError(
      nextError instanceof Error
        ? nextError.message
        : "Place search is unavailable; using typed text.",
    );
    state.setSuggestions([]);
    state.onPlaceSelect(
      compactAutocompleteResult({ name: query, formattedAddress: query }),
    );
  } finally {
    state.setIsSearching(false);
  }
}

async function selectAutocompleteSuggestion({
  suggestion,
  setQuery,
  setError,
  setIsSearching,
  setSuggestions,
  resetSessionToken,
  onPlaceSelect,
}: PlaceSearchState & {
  suggestion: GoogleAutocompleteSuggestion;
}): Promise<void> {
  const fallbackQuery = suggestionLabel(suggestion, 0);
  setIsSearching(true);
  try {
    const selected =
      (await placeFromAutocompleteSuggestion(suggestion)) ??
      (fallbackQuery ? await placeFromServerSearch(fallbackQuery) : null);
    if (!selected) return;
    setError("");
    setQuery(selected.formattedAddress ?? selected.name);
    setSuggestions([]);
    resetSessionToken();
    onPlaceSelect(selected);
  } catch (nextError) {
    setError(
      nextError instanceof Error
        ? nextError.message
        : "Selected place details could not be loaded.",
    );
  } finally {
    setIsSearching(false);
  }
}

async function placeFromAutocompleteSuggestion(
  suggestion: GoogleAutocompleteSuggestion,
): Promise<GooglePlaceAutocompleteResult | null> {
  const prediction = suggestion.placePrediction;
  const place = prediction?.toPlace?.();
  if (!place) return null;
  await place.fetchFields?.({
    fields: [
      "id",
      "displayName",
      "formattedAddress",
      "location",
      "googleMapsURI",
    ],
  });
  return autocompleteResultFromPlace(place, suggestionLabel(suggestion, 0));
}

async function placeFromServerSearch(
  query: string,
): Promise<GooglePlaceAutocompleteResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return compactAutocompleteResult({ name: "Selected place" });
  }

  const placeSearch = await searchGoogleMapsPlaces({
    textQuery: trimmed,
    maxResultCount: 1,
  }).catch(() => null);
  const place = placeSearch?.places[0];
  if (place) {
    return compactAutocompleteResult({
      placeId: place.placeId ?? place.id,
      name: place.name || place.formattedAddress || trimmed,
      formattedAddress: place.formattedAddress,
      location: place.location,
      googleMapsUri: place.googleMapsUri,
    });
  }

  const geocode = await geocodeGoogleMapsAddress({
    address: trimmed,
    limit: 1,
  }).catch(() => null);
  const result = geocode?.results[0];
  if (result) {
    return compactAutocompleteResult({
      placeId: result.placeId,
      name: result.formattedAddress || trimmed,
      formattedAddress: result.formattedAddress,
      location: result.location,
    });
  }

  return compactAutocompleteResult({
    name: trimmed,
    formattedAddress: trimmed,
  });
}

function autocompleteRequestFromProps({
  input,
  sessionToken,
  includedRegionCodes,
  includedPrimaryTypes,
  locationBias,
}: {
  input: string;
  sessionToken: unknown;
  includedRegionCodes?: string[];
  includedPrimaryTypes?: string[];
  locationBias?: GoogleMapsCoordinate & { radiusMeters?: number };
}): Record<string, unknown> {
  const request: Record<string, unknown> = { input };
  if (sessionToken) request.sessionToken = sessionToken;
  if (includedRegionCodes?.length) {
    request.includedRegionCodes = includedRegionCodes;
  }
  if (includedPrimaryTypes?.length) {
    request.includedPrimaryTypes = includedPrimaryTypes;
  }
  if (locationBias) {
    request.locationBias = {
      radius: locationBias.radiusMeters ?? 5_000,
      center: {
        lat: locationBias.latitude,
        lng: locationBias.longitude,
      },
    };
  }
  return request;
}

function createAutocompleteSessionToken(
  placesLibrary: PlacesLibrary | null,
): unknown {
  try {
    return placesLibrary?.AutocompleteSessionToken
      ? new placesLibrary.AutocompleteSessionToken()
      : undefined;
  } catch {
    return undefined;
  }
}

function autocompleteResultFromPlace(
  place: GooglePlaceResult,
  fallbackName: string,
): GooglePlaceAutocompleteResult {
  const json = place.toJSON?.();
  const jsonRecord = isRecord(json) ? json : {};
  return compactAutocompleteResult({
    placeId: place.id ?? stringFromRecord(jsonRecord, "id"),
    name:
      place.displayName ??
      stringFromRecord(jsonRecord, "displayName") ??
      stringFromNestedRecord(jsonRecord, ["displayName", "text"]) ??
      place.formattedAddress ??
      stringFromRecord(jsonRecord, "formattedAddress") ??
      fallbackName ??
      "Selected place",
    formattedAddress:
      place.formattedAddress ?? stringFromRecord(jsonRecord, "formattedAddress"),
    location:
      coordinateFromGoogleLocation(place.location) ??
      coordinateFromGoogleLocation(jsonRecord.location),
    googleMapsUri:
      place.googleMapsURI ??
      place.googleMapsUri ??
      stringFromRecord(jsonRecord, "googleMapsURI") ??
      stringFromRecord(jsonRecord, "googleMapsUri"),
  });
}

function suggestionLabel(
  suggestion: GoogleAutocompleteSuggestion,
  index: number,
): string {
  const prediction = suggestion.placePrediction;
  return (
    textFromFormattable(prediction?.text) ||
    [mainSuggestionText(suggestion), secondarySuggestionText(suggestion)]
      .filter(Boolean)
      .join(", ") ||
    `Place ${index + 1}`
  );
}

function mainSuggestionText(suggestion: GoogleAutocompleteSuggestion): string {
  return textFromFormattable(suggestion.placePrediction?.mainText);
}

function secondarySuggestionText(
  suggestion: GoogleAutocompleteSuggestion,
): string {
  return textFromFormattable(suggestion.placePrediction?.secondaryText);
}

function textFromFormattable(
  value: GoogleFormattableText | string | undefined,
): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (typeof value.text === "string") return value.text;
  const asString = value.toString?.();
  return asString && asString !== "[object Object]" ? asString : "";
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
      loading: "async",
      callback: callbackName,
      libraries: "maps,marker,geometry,places",
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
  bicyclingLayer: LayerInstance | null,
): void {
  markers.forEach((marker) => {
    marker.map = null;
  });
  routeLine?.setMap(null);
  bicyclingLayer?.setMap(null);
}

function resolveLatLngBoundsConstructor(
  coreLibrary: CoreLibrary,
  mapsApi: GoogleMapsApi,
  mapsLibrary: MapsLibrary,
): BoundsConstructor | null {
  return (
    coreLibrary.LatLngBounds ??
    mapsApi.LatLngBounds ??
    mapsLibrary.LatLngBounds ??
    null
  );
}

function normalizeRouteOptions(
  route: GoogleMapsRoute | null | undefined,
  routes: GoogleMapsRoute[] | null | undefined,
): GoogleMapsRoute[] {
  const routeList = (routes ?? []).filter(Boolean);
  if (routeList.length > 0) return routeList;
  return route ? [route] : [];
}

function routeLabel(route: GoogleMapsRoute, index: number): string {
  if (route.routeLabels?.includes("DEFAULT_ROUTE")) return "Recommended route";
  if (route.routeLabels?.includes("DEFAULT_ROUTE_ALTERNATE")) {
    return `Alternative ${index}`;
  }
  if (route.routeLabels?.length) {
    return titleCase(route.routeLabels[0]);
  }
  return index === 0 ? "Recommended route" : `Alternative ${index}`;
}

function routeStepCount(route: GoogleMapsRoute): number {
  return (route.legs ?? []).reduce(
    (count, leg) => count + (leg.steps?.length ?? 0),
    0,
  );
}

function elevationChartPoints(profile: GoogleMapsElevationProfile): string {
  const values = profile.points
    .map((point) => point.elevationMeters)
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  return values
    .map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 240;
      const y = 68 - ((value - min) / span) * 60;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function compactAutocompleteResult(
  input: GooglePlaceAutocompleteResult,
): GooglePlaceAutocompleteResult {
  return {
    ...(input.placeId ? { placeId: input.placeId } : {}),
    name: input.name,
    ...(input.formattedAddress
      ? { formattedAddress: input.formattedAddress }
      : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.googleMapsUri ? { googleMapsUri: input.googleMapsUri } : {}),
  };
}

function coordinateFromGoogleLocation(
  location: unknown,
): GoogleMapsCoordinate | null {
  if (!isRecord(location)) return null;
  const latValue = location.lat;
  const lngValue = location.lng;
  const latitude = typeof latValue === "function" ? latValue() : latValue;
  const longitude = typeof lngValue === "function" ? lngValue() : lngValue;
  return typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    typeof longitude === "number" &&
    Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
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

function routeWarnings(route: GoogleMapsRoute | null | undefined): string[] {
  return uniqueMessages([
    route?.safetyNotice,
    ...(Array.isArray(route?.warnings) ? route.warnings : []),
  ]);
}

function uniqueMessages(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(isString))];
}

function stringFromRecord(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof input[key] === "string" ? input[key] : undefined;
}

function stringFromNestedRecord(
  input: Record<string, unknown>,
  path: string[],
): string | undefined {
  let current: unknown = input;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: string | undefined): value is string {
  return Boolean(value);
}

function titleCase(value: string | undefined): string {
  return (value ?? "Route")
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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
