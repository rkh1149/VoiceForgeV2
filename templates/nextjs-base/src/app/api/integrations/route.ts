import { NextResponse } from "next/server";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Browser code in generated apps calls this same-origin route. This route
 * adds the server-only VoiceForge app token and forwards approved integration
 * requests to VoiceForge V2. Tokens and provider credentials are never sent
 * to the browser.
 */

type IntegrationAction = "listProviders" | "invoke" | "getGoogleMapsBrowserConfig";

type IntegrationBody = {
  action?: unknown;
  providerKey?: unknown;
  actionKey?: unknown;
  input?: unknown;
  sessionToken?: unknown;
};

type DemoContact = {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string;
};

type LocalPlace = {
  placeId: string;
  name: string;
  formattedAddress: string;
  location: { latitude: number; longitude: number };
  rating: number;
  userRatingCount: number;
  types: string[];
  googleMapsUri: string;
  websiteUri?: string;
};

const ACTIONS = new Set<IntegrationAction>([
  "listProviders",
  "invoke",
  "getGoogleMapsBrowserConfig",
]);

const demoContacts: DemoContact[] = [
  {
    id: "demo-avery",
    name: "Avery Chen",
    email: "avery.chen@example.test",
    company: "Northwind Family Co-op",
    role: "Coordinator",
  },
  {
    id: "demo-morgan",
    name: "Morgan Patel",
    email: "morgan.patel@example.test",
    company: "Oak Street Volunteers",
    role: "Treasurer",
  },
  {
    id: "demo-riley",
    name: "Riley Thompson",
    email: "riley.thompson@example.test",
    company: "Weekend Sports Club",
    role: "Scheduler",
  },
];

const demoProvider = {
  providerKey: "demo_directory",
  displayName: "Demo Directory",
  description:
    "Safe sample contacts for testing VoiceForge's locked integration flow without third-party credentials.",
  authType: "none" as const,
  actions: [
    {
      actionKey: "list_contacts",
      displayName: "List contacts",
      description: "Search sample external contacts by name, email, company, or role.",
      requiredRole: "viewer" as const,
    },
    {
      actionKey: "lookup_contact",
      displayName: "Lookup contact",
      description: "Retrieve one sample external contact by ID.",
      requiredRole: "viewer" as const,
    },
    {
      actionKey: "record_contact_note",
      displayName: "Record contact note",
      description: "Pretend to write a note back to the sample external system.",
      requiredRole: "editor" as const,
    },
  ],
};

const googleMapsProvider = {
  providerKey: "google_maps",
  displayName: "Google Maps",
  description:
    "Server-side trip planning with place search, place details, address geocoding, and route estimates.",
  authType: "api_key" as const,
  actions: [
    {
      actionKey: "search_places",
      displayName: "Search places",
      description:
        "Search Google Places for hotels, restaurants, attractions, airports, or addresses.",
      requiredRole: "viewer" as const,
    },
    {
      actionKey: "get_place_details",
      displayName: "Get place details",
      description:
        "Retrieve address, location, rating, contact, website, and opening-hour details for a place.",
      requiredRole: "viewer" as const,
    },
    {
      actionKey: "geocode_address",
      displayName: "Geocode address",
      description: "Convert an address or landmark into latitude and longitude.",
      requiredRole: "viewer" as const,
    },
    {
      actionKey: "compute_route",
      displayName: "Compute route",
      description:
        "Estimate route distance, duration, legs, and encoded polyline for an itinerary.",
      requiredRole: "viewer" as const,
    },
  ],
};

const localPlaces: LocalPlace[] = [
  {
    placeId: "local-cn-tower",
    name: "CN Tower",
    formattedAddress: "290 Bremner Blvd, Toronto, ON M5V 3L9, Canada",
    location: { latitude: 43.6426, longitude: -79.3871 },
    rating: 4.6,
    userRatingCount: 76234,
    types: ["tourist_attraction", "landmark"],
    googleMapsUri: "https://maps.google.com/?cid=local-cn-tower",
    websiteUri: "https://www.cntower.ca/",
  },
  {
    placeId: "local-rom",
    name: "Royal Ontario Museum",
    formattedAddress: "100 Queens Park, Toronto, ON M5S 2C6, Canada",
    location: { latitude: 43.6677, longitude: -79.3948 },
    rating: 4.7,
    userRatingCount: 39840,
    types: ["museum", "tourist_attraction"],
    googleMapsUri: "https://maps.google.com/?cid=local-rom",
    websiteUri: "https://www.rom.on.ca/",
  },
  {
    placeId: "local-union-station",
    name: "Union Station",
    formattedAddress: "55 Front St W, Toronto, ON M5J 1E6, Canada",
    location: { latitude: 43.6453, longitude: -79.3806 },
    rating: 4.4,
    userRatingCount: 18112,
    types: ["transit_station", "train_station"],
    googleMapsUri: "https://maps.google.com/?cid=local-union-station",
  },
];

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as IntegrationBody | null;
  if (
    !body ||
    typeof body.action !== "string" ||
    !ACTIONS.has(body.action as IntegrationAction)
  ) {
    return NextResponse.json(
      { error: "Invalid integration action." },
      { status: 400 },
    );
  }

  if (process.env.VOICEFORGE_DATA_LOCAL_FALLBACK === "1") {
    return handleLocalIntegrations(
      body as IntegrationBody & { action: IntegrationAction },
    );
  }

  const base = process.env.VOICEFORGE_PUBLIC_URL?.replace(/\/$/, "");
  const token = process.env.VOICEFORGE_APP_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: "Platform integrations are not enabled for this app." },
      { status: 503 },
    );
  }
  const requireSession = process.env.VOICEFORGE_REQUIRE_SIGN_IN === "1";
  const sharingModel = normalizeSharingModel(process.env.VOICEFORGE_SHARING_MODEL);
  const sessionToken =
    typeof body.sessionToken === "string" ? body.sessionToken : undefined;

  const platformRes = await fetch(`${base}/api/platform-integrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      token,
      sessionToken,
      requireSession,
      sharingModel,
    }),
  }).catch(() => null);

  if (!platformRes) {
    return NextResponse.json(
      { error: "Platform integrations are unavailable right now." },
      { status: 502 },
    );
  }

  const text = await platformRes.text();
  return new Response(text, {
    status: platformRes.status,
    headers: {
      "Content-Type":
        platformRes.headers.get("content-type") ?? "application/json",
    },
  });
}

function handleLocalIntegrations(
  body: IntegrationBody & { action: IntegrationAction },
) {
  switch (body.action) {
    case "listProviders":
      return NextResponse.json({ providers: [demoProvider, googleMapsProvider] });
    case "getGoogleMapsBrowserConfig":
      return NextResponse.json({
        config: {
          enabled: false,
          apiKey: null,
          mapId: "DEMO_MAP_ID",
          authReferrerPolicy: "origin",
        },
      });
    case "invoke":
      return invokeLocalIntegration(body);
  }
}

function invokeLocalIntegration(body: IntegrationBody) {
  if (body.providerKey === "google_maps") return invokeLocalGoogleMaps(body);
  if (body.providerKey !== "demo_directory") return providerNotFound();

  if (body.actionKey === "list_contacts") {
    const input = isPlainObject(body.input) ? body.input : {};
    const query =
      typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.floor(input.limit), 1), 50)
        : 20;
    const contacts = demoContacts
      .filter((contact) => {
        if (!query) return true;
        return [
          contact.name,
          contact.email,
          contact.company,
          contact.role,
        ].some((value) => value.toLowerCase().includes(query));
      })
      .slice(0, limit);
    return NextResponse.json({
      providerKey: "demo_directory",
      actionKey: "list_contacts",
      result: { provider: "demo_directory", contacts },
    });
  }
  if (body.actionKey === "lookup_contact") {
    const input = isPlainObject(body.input) ? body.input : {};
    const contactId = typeof input.contactId === "string" ? input.contactId : "";
    const contact = demoContacts.find((item) => item.id === contactId);
    if (!contact) {
      return localPlatformError(
        404,
        "integration_record_not_found",
        "The integration record was not found.",
      );
    }
    return NextResponse.json({
      providerKey: "demo_directory",
      actionKey: "lookup_contact",
      result: { provider: "demo_directory", contact },
    });
  }
  if (body.actionKey === "record_contact_note") {
    const input = isPlainObject(body.input) ? body.input : {};
    const contactId = typeof input.contactId === "string" ? input.contactId : "";
    const note = typeof input.note === "string" ? input.note.trim() : "";
    const contact = demoContacts.find((item) => item.id === contactId);
    if (!contact || !note) {
      return localPlatformError(
        400,
        "invalid_integration_input",
        "contactId and note are required.",
      );
    }
    return NextResponse.json({
      providerKey: "demo_directory",
      actionKey: "record_contact_note",
      result: {
        provider: "demo_directory",
        saved: true,
        contactId,
        notePreview: note.slice(0, 120),
      },
    });
  }
  return localPlatformError(
    404,
    "integration_action_not_found",
    "That integration action is not approved in VoiceForge V2.",
  );
}

function invokeLocalGoogleMaps(body: IntegrationBody) {
  const input = isPlainObject(body.input) ? body.input : {};
  if (body.actionKey === "search_places") {
    const query = typeof input.textQuery === "string" ? input.textQuery : "";
    const limit =
      typeof input.maxResultCount === "number" && Number.isFinite(input.maxResultCount)
        ? Math.min(Math.max(Math.floor(input.maxResultCount), 1), 10)
        : 5;
    const normalizedQuery = query.toLowerCase();
    const places = localPlaces
      .filter((place) =>
        [place.name, place.formattedAddress, ...place.types].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        ),
      )
      .slice(0, limit);
    return NextResponse.json({
      providerKey: "google_maps",
      actionKey: "search_places",
      result: { provider: "google_maps", places },
    });
  }
  if (body.actionKey === "get_place_details") {
    const placeId = typeof input.placeId === "string" ? input.placeId : "";
    const place = localPlaces.find(
      (item) => item.placeId === placeId || `places/${item.placeId}` === placeId,
    );
    if (!place) {
      return localPlatformError(
        404,
        "integration_record_not_found",
        "The integration record was not found.",
      );
    }
    return NextResponse.json({
      providerKey: "google_maps",
      actionKey: "get_place_details",
      result: {
        provider: "google_maps",
        place: {
          ...place,
          phoneNumber: "+1 416-555-0199",
          openingHours: ["Monday: 9:00 AM - 5:00 PM"],
          priceLevel: "PRICE_LEVEL_MODERATE",
        },
      },
    });
  }
  if (body.actionKey === "geocode_address") {
    const address = typeof input.address === "string" ? input.address : "";
    const normalizedAddress = address.toLowerCase();
    const results = localPlaces
      .filter((place) =>
        [place.name, place.formattedAddress].some((value) =>
          value.toLowerCase().includes(normalizedAddress),
        ),
      )
      .map((place) => ({
        placeId: place.placeId,
        formattedAddress: place.formattedAddress,
        location: place.location,
        locationType: "ROOFTOP",
        types: place.types,
      }));
    return NextResponse.json({
      providerKey: "google_maps",
      actionKey: "geocode_address",
      result: { provider: "google_maps", results },
    });
  }
  if (body.actionKey === "compute_route") {
    const origin = placeFromWaypoint(input.origin) ?? localPlaces[2];
    const destination = placeFromWaypoint(input.destination) ?? localPlaces[0];
    if (!origin || !destination) {
      return localPlatformError(
        400,
        "invalid_integration_input",
        "origin and destination are required.",
      );
    }
    const distanceMeters = Math.max(
      600,
      Math.round(distanceBetween(origin.location, destination.location) * 1_000),
    );
    const durationSeconds = Math.round(distanceMeters / 7);
    return NextResponse.json({
      providerKey: "google_maps",
      actionKey: "compute_route",
      result: {
        provider: "google_maps",
        route: {
          distanceMeters,
          duration: `${durationSeconds}s`,
          durationSeconds,
          localizedDistance: `${(distanceMeters / 1000).toFixed(1)} km`,
          localizedDuration: `${Math.max(1, Math.round(durationSeconds / 60))} min`,
          encodedPolyline: "local_preview_polyline",
          legs: [
            {
              distanceMeters,
              duration: `${durationSeconds}s`,
              durationSeconds,
              localizedDistance: `${(distanceMeters / 1000).toFixed(1)} km`,
              localizedDuration: `${Math.max(1, Math.round(durationSeconds / 60))} min`,
              startLocation: origin.location,
              endLocation: destination.location,
            },
          ],
        },
      },
    });
  }
  return localPlatformError(
    404,
    "integration_action_not_found",
    "That integration action is not approved in VoiceForge V2.",
  );
}

function placeFromWaypoint(input: unknown): LocalPlace | undefined {
  if (!isPlainObject(input)) return undefined;
  const placeId = typeof input.placeId === "string" ? input.placeId : "";
  if (placeId) {
    return localPlaces.find(
      (place) => place.placeId === placeId || `places/${place.placeId}` === placeId,
    );
  }
  const address = typeof input.address === "string" ? input.address.toLowerCase() : "";
  if (address) {
    return localPlaces.find((place) =>
      [place.name, place.formattedAddress].some((value) =>
        value.toLowerCase().includes(address),
      ),
    );
  }
  return undefined;
}

function distanceBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const dLat = a.latitude - b.latitude;
  const dLng = a.longitude - b.longitude;
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111;
}

function providerNotFound() {
  return localPlatformError(
    404,
    "integration_provider_not_found",
    "That integration provider is not approved in VoiceForge V2.",
  );
}

function normalizeSharingModel(value: string | undefined) {
  if (value === "private" || value === "public") return value;
  return "shared";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localPlatformError(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status });
}
