import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  validateArchitecturePlan,
  type ArchitecturePlan,
} from "../architecture";
import { computeSpecComplexity, normalizeAppSpec, type AppSpec } from "../spec";
import {
  getPostGenerationBlockingIssues,
  runPostGenerationReviews,
} from "./post-generation-reviews";
import type { FileMap } from "./template";

const sharedSpecInput = {
  appName: "Family Follow Up Hub",
  purpose: "Help a family track shared follow ups.",
  targetUsers: "A family of five",
  screens: [
    {
      name: "Dashboard",
      description: "Review and add follow ups.",
    },
  ],
  features: ["Add follow ups", "Track owners", "Search records"],
  dataToStore: ["follow ups with title, owner, due date, and status"],
  needsLogin: true,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Create a follow up and see it in the list"],
  deploymentNotes: "",
};

const personalSpecInput = {
  appName: "Packing Helper",
  purpose: "Track a personal packing list.",
  targetUsers: "One person",
  screens: [
    {
      name: "Dashboard",
      description: "Manage packing items.",
    },
  ],
  features: ["Add items", "Mark packed"],
  dataToStore: ["items"],
  needsLogin: false,
  sharingModel: "private" as const,
  aiFeatures: [],
  testPlan: ["Add an item"],
  deploymentNotes: "",
};

function buildArchitecture(spec: AppSpec): ArchitecturePlan {
  const architecture = createFallbackArchitecturePlan(
    spec,
    computeSpecComplexity(spec),
  );
  const validation = validateArchitecturePlan(architecture, spec);
  return {
    ...architecture,
    capabilityValidation: {
      ...architecture.capabilityValidation,
      canBuildNow: validation.canBuildNow,
      blockingIssues: validation.blockingIssues,
      warnings: validation.warnings,
    },
  };
}

function review(input: {
  spec?: AppSpec;
  architecture?: ArchitecturePlan;
  allFiles: FileMap;
  changedFiles?: FileMap;
  changeMode?: boolean;
}) {
  const spec = input.spec ?? normalizeAppSpec(sharedSpecInput);
  const architecture = input.architecture ?? buildArchitecture(spec);
  const changedFiles = input.changedFiles ?? input.allFiles;
  return runPostGenerationReviews({
    spec,
    architecture,
    allFiles: input.allFiles,
    changedFiles,
    changedFilePaths: Object.keys(changedFiles),
    deletedFilePaths: [],
    changeMode: input.changeMode ?? false,
  });
}

function findReview(
  reviews: ReturnType<typeof review>,
  agentKey: ReturnType<typeof review>[number]["agentKey"],
) {
  const found = reviews.find((item) => item.agentKey === agentKey);
  if (!found) throw new Error(`Missing review ${agentKey}`);
  return found;
}

function bikeEntity(
  name: string,
  fields: AppSpec["dataEntities"][number]["fields"],
): AppSpec["dataEntities"][number] {
  return {
    name,
    description: `${name} records for a shared bicycle trip.`,
    ownership: "shared",
    fields,
    relationships: [],
  };
}

function textField(name: string, label = name): AppSpec["dataEntities"][number]["fields"][number] {
  return {
    name,
    label,
    type: "text",
    required: true,
    validation: `${label} is required.`,
  };
}

function advancedBikeSpec(): AppSpec {
  const base = normalizeAppSpec({
    ...sharedSpecInput,
    appName: "Bike Journey Planner",
    purpose:
      "Plan multi-day bicycle trips with Google Maps routes, stops, saved places, maps, elevation, and CSV exports.",
    features: [
      "Create multi-day trips",
      "Plan stops and bicycle routes",
      "Compare route alternatives",
      "Save route-related places",
      "Export trip planning CSV",
    ],
    dataToStore: ["trips", "trip days", "stops", "route options", "saved places"],
    testPlan: [
      "Create a trip",
      "Add stops and routes",
      "Save places",
      "Export CSV",
    ],
  });

  const workflows: AppSpec["workflows"] = [
    {
      name: "Create multi-day trip",
      actor: "Editor",
      trigger: "Editor opens the dashboard.",
      steps: ["Add trip details", "Save the trip", "Review created trip days"],
      successOutcome: "Trip and days are visible.",
      failureStates: ["Missing trip details"],
    },
    {
      name: "Plan stops and bicycle routes",
      actor: "Editor",
      trigger: "Editor opens a day planner.",
      steps: ["Add ordered stops", "Calculate bicycle routes", "Save route options"],
      successOutcome: "Stops and route options are saved.",
      failureStates: ["Not enough stops"],
    },
    {
      name: "Compare bicycle route alternatives",
      actor: "Member",
      trigger: "Member opens route comparison.",
      steps: ["Search origin and destination", "Request alternatives", "Compare route cards"],
      successOutcome: "Alternative route cards and map are shown.",
      failureStates: ["No route found"],
    },
    {
      name: "Save route-related places",
      actor: "Editor",
      trigger: "Editor searches places along the route.",
      steps: ["Search places", "Choose a place", "Save place notes"],
      successOutcome: "Saved places appear in the trip.",
      failureStates: ["Place unavailable"],
    },
    {
      name: "Export trip planning CSV",
      actor: "Editor",
      trigger: "Editor opens reports.",
      steps: ["Filter planning records", "Export CSV"],
      successOutcome: "CSV includes trip planning records.",
      failureStates: ["No records to export"],
    },
  ];

  return {
    ...base,
    capabilityTier: "advanced",
    expectedDataVolume: "medium",
    dataEntities: [
      bikeEntity("Trip", [textField("name", "Trip name")]),
      bikeEntity("TripDay", [textField("date", "Date")]),
      bikeEntity("TripStop", [textField("placeName", "Place name")]),
      bikeEntity("RouteOption", [
        textField("name", "Route name"),
        {
          name: "routeData",
          label: "Route data",
          type: "json",
          required: true,
          validation: "Google Maps route response is required.",
        },
      ]),
      bikeEntity("SavedPlace", [textField("name", "Place name")]),
    ],
    workflows,
    permissionRules: [
      {
        role: "Owner",
        entity: "All saved information",
        actions: ["create", "read", "update", "delete"],
        condition: "Owner can manage every shared record.",
      },
      {
        role: "Editor",
        entity: "All saved information",
        actions: ["create", "read", "update"],
        condition: "Editor can update planning records.",
      },
      {
        role: "Viewer",
        entity: "All saved information",
        actions: ["read"],
        condition: "Viewer is read-only.",
      },
    ],
    searchRequirements: [
      {
        target: "Trip records",
        fields: ["name", "date", "placeName"],
        filters: ["Filter trips and places", "Sort by date"],
      },
    ],
    integrations: [
      {
        name: "Google Maps",
        purpose:
          "Place search, autocomplete, bicycle routing, route alternatives, interactive map display, route pins, and elevation profiles.",
        direction: "two_way",
        requiredForLaunch: true,
      },
    ],
    reports: [
      {
        name: "Trip planning CSV",
        description: "Export trip days, stops, routes, and saved places.",
        dataNeeded: ["Trips", "Trip days", "Stops", "Routes", "Saved places"],
        exportFormats: ["csv"],
      },
    ],
    acceptanceCriteria: workflows.map((workflow) => ({
      name: workflow.name,
      scenario: workflow.successOutcome,
      given: workflow.trigger,
      when: workflow.steps.join(" "),
      then: workflow.successOutcome,
    })),
    testScenarios: workflows.map((workflow) => ({
      name: workflow.name,
      type: "workflow" as const,
      steps: workflow.steps,
      expectedResult: workflow.successOutcome,
    })),
  };
}

describe("post-generation reviews", () => {
  it("records passing gates for a shared app with platform clients and generated tests", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const files: FileMap = {
      "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { createPlatformRecord, listPlatformRecords, searchPlatformRecords } from "@/lib/platform-data";

export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  void createPlatformRecord;
  void listPlatformRecords;
  void searchPlatformRecords;
  return <main><h1>Family Follow Up Hub</h1><label htmlFor="title">Title</label><input id="title" /></main>;
}`,
      "src/lib/follow-ups.test.ts": `import { describe, expect, it } from "vitest";
describe("follow ups", () => { it("works", () => expect(1).toBe(1)); });`,
      "e2e/generated/follow-ups.spec.ts": `import { test, expect } from "@playwright/test";
test("loads", async ({ page }) => { await page.goto("/"); await expect(page.getByRole("heading")).toBeVisible(); });`,
    };

    const reviews = review({ spec, architecture: buildArchitecture(spec), allFiles: files });

    expect(reviews.map((item) => item.agentKey)).toEqual([
      "code_reviewer",
      "test_reviewer",
      "security_reviewer",
      "ux_accessibility_reviewer",
    ]);
    expect(reviews.every((item) => item.status === "passed")).toBe(true);
    expect(getPostGenerationBlockingIssues(reviews)).toEqual([]);
  });

  it("blocks direct credentials, external URLs, API routes, and unsafe HTML", () => {
    const spec = normalizeAppSpec(personalSpecInput);
    const files: FileMap = {
      "src/app/page.tsx": `"use client";
export default function Page() {
  const key = process.env.OPENAI_API_KEY;
  void fetch("https://example.com/api");
  navigator.geolocation.watchPosition(() => {});
  return <main dangerouslySetInnerHTML={{ __html: String(key) }} />;
}`,
      "src/app/api/custom/route.ts": `export async function POST() { return Response.json({ ok: true }); }`,
    };

    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });
    const securityReview = findReview(reviews, "security_reviewer");

    expect(securityReview.status).toBe("failed");
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "references platform credentials",
    );
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "external URLs",
    );
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "locked API route",
    );
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "unsafe dynamic HTML",
    );
    expect(securityReview.blockingIssues.join(" ")).toContain(
      "navigator.geolocation",
    );
  });

  it("blocks shared apps that omit platform-data and session wiring", () => {
    const spec = normalizeAppSpec(sharedSpecInput);
    const files: FileMap = {
      "src/app/page.tsx": `export default function Page() { return <main><h1>Family Follow Up Hub</h1></main>; }`,
      "src/lib/follow-ups.test.ts": `import { expect, it } from "vitest";
it("works", () => expect(true).toBe(true));`,
    };

    const codeReview = findReview(
      review({ spec, architecture: buildArchitecture(spec), allFiles: files }),
      "code_reviewer",
    );

    expect(codeReview.status).toBe("failed");
    expect(codeReview.blockingIssues).toContain(
      "code_review: Shared/platform-data app did not use the locked platform-data client.",
    );
    expect(codeReview.blockingIssues).toContain(
      "code_review: Sign-in or role-aware app did not provide a usable locked platform sign-in action.",
    );
  });

  it("warns about missing generated tests and basic accessibility gaps", () => {
    const spec = normalizeAppSpec(personalSpecInput);
    const files: FileMap = {
      "src/app/page.tsx": `"use client";
export default function Page() { return <main><input id="item" /><img src="/missing.png" /></main>; }`,
    };
    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });
    const testReview = findReview(reviews, "test_reviewer");
    const uxReview = findReview(reviews, "ux_accessibility_reviewer");

    expect(testReview.status).toBe("warning");
    expect(testReview.warnings).toContain(
      "tests_review: No generated unit/workflow tests were found under src/.",
    );
    expect(uxReview.status).toBe("warning");
    expect(uxReview.warnings.join(" ")).toContain("without an h1");
    expect(uxReview.warnings.join(" ")).toContain("Images without alt text");
    expect(uxReview.warnings.join(" ")).toContain("Form controls need labels");
  });

  it("blocks advanced placeholder apps with incomplete workflow controls and type-only Google Maps references", () => {
    const spec = advancedBikeSpec();
    const files: FileMap = {
      "src/lib/bike.ts": `export type { GoogleMapsRoute } from "@/lib/platform-integrations";
export const ENTITY_KEYS = { trip: "trip", tripDay: "trip_day", tripStop: "trip_stop", routeOption: "route_option", savedPlace: "saved_place" } as const;`,
      "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { createPlatformRecord, listPlatformRecords } from "@/lib/platform-data";
import { ENTITY_KEYS } from "@/lib/bike";
export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  void listPlatformRecords;
  async function createTrip() {
    await createPlatformRecord(ENTITY_KEYS.trip, { name: "Tour" });
    await createPlatformRecord(ENTITY_KEYS.tripDay, { date: "2026-08-01" });
  }
  return <main><h1>Bike Journey Planner</h1><form onSubmit={(event) => { event.preventDefault(); void createTrip(); }}><label>Trip name<input /></label><button type="submit">Create trip</button></form></main>;
}`,
      "src/app/day-planner/page.tsx": `export default function Page() { return <main><h1>Day Planner</h1><p>Add stops and calculate routes after selecting a trip.</p></main>; }`,
      "src/lib/bike.test.ts": `import { expect, it } from "vitest";
it("creates a trip", () => expect(["trip", "trip_day"]).toContain("trip"));`,
      "e2e/generated/trip.spec.ts": `import { test, expect } from "@playwright/test";
test("creates a trip", async ({ page }) => { await page.goto("/"); await expect(page.getByRole("button", { name: "Create trip" })).toBeVisible(); });`,
    };

    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });
    const codeReview = findReview(reviews, "code_reviewer");
    const testReview = findReview(reviews, "test_reviewer");

    expect(codeReview.status).toBe("failed");
    expect(codeReview.blockingIssues.join(" ")).toContain(
      "Google Maps integration was requested",
    );
    expect(codeReview.blockingIssues.join(" ")).toContain("TripStop");
    expect(codeReview.blockingIssues.join(" ")).toContain("RouteOption");
    expect(codeReview.blockingIssues.join(" ")).toContain("SavedPlace");
    expect(codeReview.blockingIssues.join(" ")).toContain(
      "planned workflows without visible action controls",
    );
    expect(testReview.status).toBe("failed");
    expect(testReview.blockingIssues.join(" ")).toContain(
      "Advanced workflow test coverage is incomplete",
    );
  });

  it("blocks advanced apps that omit architecture-planned route files", () => {
    const spec = advancedBikeSpec();
    const architecture = buildArchitecture(spec);
    const reviews = review({
      spec,
      architecture: {
        ...architecture,
        pageMap: [
          ...architecture.pageMap,
          {
            route: "/route-comparison",
            name: "Route Comparison",
            purpose: "Compare bicycle route alternatives.",
            primaryComponents: ["RouteComparisonView"],
            workflows: ["Compare bicycle route alternatives"],
          },
        ],
      },
      allFiles: {
        "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { createPlatformRecord, listPlatformRecords } from "@/lib/platform-data";
export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  void listPlatformRecords;
  void createPlatformRecord;
  return <main><h1>Bike Journey Planner</h1><button>Create trip</button></main>;
}`,
      },
    });

    const codeReview = findReview(reviews, "code_reviewer");

    expect(codeReview.status).toBe("failed");
    expect(codeReview.blockingIssues).toContain(
      "code_review: Architecture planned route files that were not generated: src/app/route-comparison/page.tsx.",
    );
  });

  it("accepts typed platform wrapper helpers as advanced save wiring", () => {
    const spec = advancedBikeSpec();
    const files: FileMap = {
      "src/lib/bike-journey.ts": `import { createPlatformRecord, updatePlatformRecord, deletePlatformRecord, exportPlatformRecordsCsv } from "@/lib/platform-data";
export const ENTITY_KEYS = { trip: "trip", tripDay: "trip_day", tripStop: "trip_stop", routeOption: "route_option", savedPlace: "saved_place" } as const;
type TripData = { name: string };
type TripDayData = { date: string };
type TripStopData = { place_name: string };
type RouteOptionData = { name: string; route_data: unknown };
type SavedPlaceData = { name: string };
export function createTrip(data: TripData) { return createPlatformRecord<TripData>(ENTITY_KEYS.trip, data); }
export function updateTrip(recordId: string, data: Partial<TripData>) { return updatePlatformRecord<Partial<TripData>>(recordId, data); }
export function deleteTrip(recordId: string) { return deletePlatformRecord(recordId); }
export function createTripDay(data: TripDayData) { return createPlatformRecord<TripDayData>(ENTITY_KEYS.tripDay, data); }
export function updateTripDay(recordId: string, data: Partial<TripDayData>) { return updatePlatformRecord<Partial<TripDayData>>(recordId, data); }
export function deleteTripDay(recordId: string) { return deletePlatformRecord(recordId); }
export function createTripStop(data: TripStopData) { return createPlatformRecord<TripStopData>(ENTITY_KEYS.tripStop, data); }
export function updateTripStop(recordId: string, data: Partial<TripStopData>) { return updatePlatformRecord<Partial<TripStopData>>(recordId, data); }
export function deleteTripStop(recordId: string) { return deletePlatformRecord(recordId); }
export function createRouteOption(data: RouteOptionData) { return createPlatformRecord<RouteOptionData>(ENTITY_KEYS.routeOption, data); }
export function updateRouteOption(recordId: string, data: Partial<RouteOptionData>) { return updatePlatformRecord<Partial<RouteOptionData>>(recordId, data); }
export function deleteRouteOption(recordId: string) { return deletePlatformRecord(recordId); }
export function createSavedPlace(data: SavedPlaceData) { return createPlatformRecord<SavedPlaceData>(ENTITY_KEYS.savedPlace, data); }
export function updateSavedPlace(recordId: string, data: Partial<SavedPlaceData>) { return updatePlatformRecord<Partial<SavedPlaceData>>(recordId, data); }
export function deleteSavedPlace(recordId: string) { return deletePlatformRecord(recordId); }
export function exportTripPlanningCsv() { return exportPlatformRecordsCsv(ENTITY_KEYS.trip); }`,
      "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { GoogleMapsTripMap, GooglePlaceAutocomplete } from "@/components/voiceforge-google-map";
import { DeviceLocationTracker } from "@/lib/device-location";
import { computeGoogleMapsRoute, getGoogleMapsElevationProfile, searchGoogleMapsPlaces } from "@/lib/platform-integrations";
import { createTrip, updateTrip, deleteTrip, createTripDay, updateTripDay, deleteTripDay, createTripStop, updateTripStop, deleteTripStop, createRouteOption, updateRouteOption, deleteRouteOption, createSavedPlace, updateSavedPlace, deleteSavedPlace, exportTripPlanningCsv } from "@/lib/bike-journey";
export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  async function planRoute() {
    const route = await computeGoogleMapsRoute({ origin: { address: "A" }, destination: { address: "B" }, travelMode: "BICYCLE", computeAlternativeRoutes: true, polylineQuality: "HIGH_QUALITY" });
    await getGoogleMapsElevationProfile({ encodedPolyline: "abc", samples: 64 });
    await searchGoogleMapsPlaces({ query: "bike friendly cafe" });
    await createRouteOption({ name: "Comfort route", route_data: route.routes[0] });
  }
  return <main><h1>Bike Journey Planner</h1>
    <button onClick={() => void createTrip({ name: "Tour" })}>Create multi-day trip</button>
    <button onClick={() => void updateTrip("trip-1", { name: "Updated tour" })}>Update trip</button>
    <button onClick={() => void deleteTrip("trip-1")}>Delete trip</button>
    <button onClick={() => void createTripDay({ date: "2026-08-01" })}>Add trip day</button>
    <button onClick={() => void updateTripDay("day-1", { date: "2026-08-02" })}>Update trip day</button>
    <button onClick={() => void deleteTripDay("day-1")}>Delete trip day</button>
    <button onClick={() => void createTripStop({ place_name: "Start" })}>Add trip stop</button>
    <button onClick={() => void updateTripStop("stop-1", { place_name: "Cafe" })}>Update trip stop</button>
    <button onClick={() => void deleteTripStop("stop-1")}>Delete trip stop</button>
    <button onClick={() => void planRoute()}>Plan stops and bicycle routes</button>
    <button onClick={() => void updateRouteOption("route-1", { name: "Scenic route" })}>Compare bicycle route alternatives</button>
    <button onClick={() => void deleteRouteOption("route-1")}>Delete route option</button>
    <button onClick={() => void createSavedPlace({ name: "Inn" })}>Save route-related places</button>
    <button onClick={() => void updateSavedPlace("place-1", { name: "Campground" })}>Update saved place</button>
    <button onClick={() => void deleteSavedPlace("place-1")}>Delete saved place</button>
    <button onClick={() => void exportTripPlanningCsv()}>Export trip planning CSV</button>
    <GooglePlaceAutocomplete label="Origin" onPlaceSelect={() => undefined} />
    <GoogleMapsTripMap places={[]} />
  </main>;
}`,
      "src/lib/bike-journey.test.ts": `import { expect, it } from "vitest";
it("creates updates and deletes trip, trip day, trip stop, route option, and saved place records", () => expect("create update delete trip trip_day trip_stop route_option saved_place").toContain("route_option"));
it("covers create multi-day trip, plan stops and bicycle routes, compare bicycle route alternatives, save route-related places, and export trip planning csv", () => expect("create plan compare save export").toContain("export"));`,
      "e2e/generated/bike-journey.spec.ts": `import { test, expect } from "@playwright/test";
test("advanced bike planner controls are reachable", async ({ page }) => { await page.goto("/"); await expect(page.getByRole("button", { name: "Create multi-day trip" })).toBeVisible(); await expect(page.getByRole("button", { name: "Plan stops and bicycle routes" })).toBeVisible(); await expect(page.getByRole("button", { name: "Export trip planning CSV" })).toBeVisible(); });`,
    };

    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });
    const codeReview = findReview(reviews, "code_reviewer");

    expect(codeReview.blockingIssues.join(" ")).not.toContain(
      "Advanced workflow coverage is incomplete",
    );
    expect(getPostGenerationBlockingIssues(reviews)).toEqual([]);
  });

  it("uses surrounding UI context for compact advanced controls", () => {
    const baseSpec = advancedBikeSpec();
    const spec: AppSpec = {
      ...baseSpec,
      dataEntities: [
        ...baseSpec.dataEntities,
        bikeEntity("Photo", [textField("caption", "Caption")]),
        bikeEntity("GpsTrackSession", [textField("startedAt", "Started at")]),
      ],
      workflows: [
        ...baseSpec.workflows,
        {
          name: "Track current ride location",
          actor: "Editor",
          trigger: "Editor opens the ride tracker.",
          steps: ["Start tracking", "Record the current ride location"],
          successOutcome: "GPS ride tracking session is saved.",
          failureStates: ["Location permission denied"],
        },
      ],
      acceptanceCriteria: [
        ...baseSpec.acceptanceCriteria,
        {
          name: "Track current ride location",
          scenario: "GPS ride tracking session is saved.",
          given: "Editor opens the ride tracker.",
          when: "Start tracking and record the current ride location",
          then: "GPS ride tracking session is saved.",
        },
      ],
      testScenarios: [
        ...baseSpec.testScenarios,
        {
          name: "Track current ride location",
          type: "workflow",
          steps: ["Start tracking", "Record the current ride location"],
          expectedResult: "GPS ride tracking session is saved.",
        },
      ],
    };
    const files: FileMap = {
      "src/lib/bike-journey.ts": `import { createPlatformRecord, updatePlatformRecord, deletePlatformRecord, exportPlatformRecordsCsv } from "@/lib/platform-data";
export const ENTITY_KEYS = { trip: "trip", tripDay: "trip_day", tripStop: "trip_stop", routeOption: "route_option", savedPlace: "saved_place", photo: "photo", gpsTrackSession: "gps_track_session" } as const;
export function createTrip(data: { name: string }) { return createPlatformRecord(ENTITY_KEYS.trip, data); }
export function updateTrip(id: string, data: { name?: string }) { return updatePlatformRecord(id, data); }
export function deleteTrip(id: string) { return deletePlatformRecord(id); }
export function createTripDay(data: { date: string }) { return createPlatformRecord(ENTITY_KEYS.tripDay, data); }
export function updateTripDay(id: string, data: { date?: string }) { return updatePlatformRecord(id, data); }
export function deleteTripDay(id: string) { return deletePlatformRecord(id); }
export function createTripStop(data: { place_name: string }) { return createPlatformRecord(ENTITY_KEYS.tripStop, data); }
export function updateTripStop(id: string, data: { place_name?: string }) { return updatePlatformRecord(id, data); }
export function deleteTripStop(id: string) { return deletePlatformRecord(id); }
export function createRouteOption(data: { name: string; route_data: unknown }) { return createPlatformRecord(ENTITY_KEYS.routeOption, data); }
export function updateRouteOption(id: string, data: { name?: string }) { return updatePlatformRecord(id, data); }
export function deleteRouteOption(id: string) { return deletePlatformRecord(id); }
export function createSavedPlace(data: { name: string }) { return createPlatformRecord(ENTITY_KEYS.savedPlace, data); }
export function updateSavedPlace(id: string, data: { name?: string }) { return updatePlatformRecord(id, data); }
export function deleteSavedPlace(id: string) { return deletePlatformRecord(id); }
export function createPhoto(data: { caption: string }) { return createPlatformRecord(ENTITY_KEYS.photo, data); }
export function updatePhoto(id: string, data: { caption?: string }) { return updatePlatformRecord(id, data); }
export function deletePhoto(id: string) { return deletePlatformRecord(id); }
export function createGpsTrackSession(data: { started_at: string }) { return createPlatformRecord(ENTITY_KEYS.gpsTrackSession, data); }
export function updateGpsTrackSession(id: string, data: { started_at?: string }) { return updatePlatformRecord(id, data); }
export function deleteGpsTrackSession(id: string) { return deletePlatformRecord(id); }
export function exportTripPlanningCsv() { return exportPlatformRecordsCsv(ENTITY_KEYS.trip); }`,
      "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { GoogleMapsTripMap, GooglePlaceAutocomplete } from "@/components/voiceforge-google-map";
import { computeGoogleMapsRoute, getGoogleMapsElevationProfile, searchGoogleMapsPlaces } from "@/lib/platform-integrations";
import { createTrip, updateTrip, deleteTrip, createTripDay, updateTripDay, deleteTripDay, createTripStop, updateTripStop, deleteTripStop, createRouteOption, updateRouteOption, deleteRouteOption, createSavedPlace, updateSavedPlace, deleteSavedPlace, createPhoto, updatePhoto, deletePhoto, createGpsTrackSession, updateGpsTrackSession, deleteGpsTrackSession, exportTripPlanningCsv } from "@/lib/bike-journey";
export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  async function planRoute() {
    const route = await computeGoogleMapsRoute({ origin: { address: "A" }, destination: { address: "B" }, travelMode: "BICYCLE", computeAlternativeRoutes: true, polylineQuality: "HIGH_QUALITY" });
    await getGoogleMapsElevationProfile({ encodedPolyline: "abc", samples: 64 });
    await searchGoogleMapsPlaces({ query: "bike friendly cafe" });
    await createRouteOption({ name: "Comfort route", route_data: route.routes[0] });
  }
  return <main><h1>Bike Journey Planner</h1>
    <section aria-label="Trips"><button onClick={() => void createTrip({ name: "Tour" })}>Create</button><button onClick={() => void updateTrip("trip-1", { name: "Updated" })}>Update</button><button onClick={() => void deleteTrip("trip-1")}>Delete</button></section>
    <section aria-label="Trip days"><button onClick={() => void createTripDay({ date: "2026-08-01" })}>Add</button><button onClick={() => void updateTripDay("day-1", { date: "2026-08-02" })}>Save</button><button onClick={() => void deleteTripDay("day-1")}>Remove</button></section>
    <section aria-label="Stops"><button onClick={() => void createTripStop({ place_name: "Start" })}>Add</button><button onClick={() => void updateTripStop("stop-1", { place_name: "Cafe" })}>Save</button><button onClick={() => void deleteTripStop("stop-1")}>Remove</button></section>
    <section aria-label="Route options"><button onClick={() => void planRoute()}>Calculate</button><button onClick={() => void updateRouteOption("route-1", { name: "Scenic" })}>Compare</button><button onClick={() => void deleteRouteOption("route-1")}>Remove</button></section>
    <section aria-label="Saved places"><button onClick={() => void createSavedPlace({ name: "Inn" })}>Save</button><button onClick={() => void updateSavedPlace("place-1", { name: "Campground" })}>Edit</button><button onClick={() => void deleteSavedPlace("place-1")}>Remove</button></section>
    <section aria-label="Photo journal"><button onClick={() => void createPhoto({ caption: "View" })}>Upload image</button><button onClick={() => void updatePhoto("photo-1", { caption: "Summit" })}>Save</button><button onClick={() => void deletePhoto("photo-1")}>Remove</button></section>
    <section aria-label="GPS ride tracking"><button onClick={() => void createGpsTrackSession({ started_at: "2026-08-01T09:00:00Z" })}>Start tracking</button><button onClick={() => void updateGpsTrackSession("gps-1", { started_at: "2026-08-01T10:00:00Z" })}>Save</button><button onClick={() => void deleteGpsTrackSession("gps-1")}>Stop tracking</button></section>
    <button onClick={() => void exportTripPlanningCsv()}>Export trip planning CSV</button>
    <GooglePlaceAutocomplete label="Origin" onPlaceSelect={() => undefined} />
    <DeviceLocationTracker onLocation={() => undefined} />
    <GoogleMapsTripMap places={[]} />
  </main>;
}`,
      "src/lib/bike-journey.test.ts": `import { expect, it } from "vitest";
it("creates updates and deletes trip, trip day, trip stop, route option, saved place, photo, and gps track session records", () => expect("create update delete trip trip_day trip_stop route_option saved_place photo gps_track_session").toContain("gps_track_session"));
it("covers create multi-day trip, plan stops and bicycle routes, compare bicycle route alternatives, save route-related places, track current ride location, and export trip planning csv", () => expect("create plan compare save track current ride location export").toContain("track"));`,
      "e2e/generated/bike-journey.spec.ts": `import { test, expect } from "@playwright/test";
test("advanced bike planner controls are reachable", async ({ page }) => { await page.goto("/"); await expect(page.getByRole("button", { name: "Start tracking" })).toBeVisible(); await expect(page.getByRole("button", { name: "Upload image" })).toBeVisible(); await expect(page.getByRole("button", { name: "Export trip planning CSV" })).toBeVisible(); });`,
    };

    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });
    const codeReview = findReview(reviews, "code_reviewer");

    expect(codeReview.blockingIssues.join(" ")).not.toContain(
      "Advanced workflow coverage is incomplete",
    );
    expect(getPostGenerationBlockingIssues(reviews)).toEqual([]);
  });

  it("accepts generic entity-key write wrappers and acronym entity names", () => {
    const baseSpec = advancedBikeSpec();
    const spec: AppSpec = {
      ...baseSpec,
      dataEntities: [
        bikeEntity("Trip", [textField("name", "Trip name")]),
        bikeEntity("TripDay", [textField("date", "Date")]),
        bikeEntity("Stop", [textField("placeName", "Place name")]),
        bikeEntity("RouteOption", [textField("name", "Route name")]),
        bikeEntity("SavedPlace", [textField("name", "Place name")]),
        bikeEntity("RoutePlaceLink", [textField("category", "Category")]),
        bikeEntity("GPSRideTrack", [textField("mode", "Mode")]),
        bikeEntity("PhotoJournalEntry", [textField("caption", "Caption")]),
      ],
      workflows: [
        ...baseSpec.workflows,
        {
          name: "Track current ride location",
          actor: "Editor",
          trigger: "Editor opens the ride tracker.",
          steps: ["Start tracking", "Save the current ride location"],
          successOutcome: "GPS ride track is saved.",
          failureStates: ["Location permission denied"],
        },
      ],
      acceptanceCriteria: [
        ...baseSpec.acceptanceCriteria,
        {
          name: "Track current ride location",
          scenario: "GPS ride track is saved.",
          given: "Editor opens the ride tracker.",
          when: "Start tracking and save the current ride location",
          then: "GPS ride track is saved.",
        },
      ],
      testScenarios: [
        ...baseSpec.testScenarios,
        {
          name: "Track current ride location",
          type: "workflow",
          steps: ["Start tracking", "Save current ride location"],
          expectedResult: "GPS ride track is saved.",
        },
      ],
    };
    const files: FileMap = {
      "src/lib/bike-journey.ts": `import { createPlatformRecord, updatePlatformRecord, deletePlatformRecord, exportPlatformRecordsCsv } from "@/lib/platform-data";
export const BIKE_ENTITY_KEYS = { trip: "trip", tripDay: "trip_day", stop: "stop", routeOption: "route_option", savedPlace: "saved_place", routePlaceLink: "route_place_link", gpsRideTrack: "gpsride_track", photoJournalEntry: "photo_journal_entry" } as const;
export function createBikeRecord(entityKey: string, data: object) { return createPlatformRecord(entityKey, data); }
export function updateBikeRecord(entityKey: string, recordId: string, data: object) { void entityKey; return updatePlatformRecord(recordId, data); }
export function deleteBikeRecord(entityKey: string, recordId: string) { void entityKey; return deletePlatformRecord(recordId); }
export function exportTripPlanningCsv() { return exportPlatformRecordsCsv(BIKE_ENTITY_KEYS.trip); }`,
      "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { GoogleMapsTripMap, GooglePlaceAutocomplete } from "@/components/voiceforge-google-map";
import { DeviceLocationTracker } from "@/lib/device-location";
import { computeGoogleMapsRoute, getGoogleMapsElevationProfile, searchGoogleMapsPlaces } from "@/lib/platform-integrations";
import { BIKE_ENTITY_KEYS, createBikeRecord, updateBikeRecord, deleteBikeRecord, exportTripPlanningCsv } from "@/lib/bike-journey";
export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  async function planRoute() {
    const route = await computeGoogleMapsRoute({ origin: { address: "A" }, destination: { address: "B" }, travelMode: "BICYCLE", computeAlternativeRoutes: true, polylineQuality: "HIGH_QUALITY" });
    await getGoogleMapsElevationProfile({ encodedPolyline: "abc", samples: 64 });
    await searchGoogleMapsPlaces({ query: "bike friendly cafe" });
    await createBikeRecord(BIKE_ENTITY_KEYS.routeOption, { name: "Comfort route", route_data: route.routes[0] });
  }
  return <main><h1>Bike Journey Planner</h1>
    <section aria-label="Trips"><button onClick={() => void createBikeRecord(BIKE_ENTITY_KEYS.trip, { name: "Tour" })}>Create</button><button onClick={() => void updateBikeRecord(BIKE_ENTITY_KEYS.trip, "trip-1", { name: "Updated" })}>Update</button><button onClick={() => void deleteBikeRecord(BIKE_ENTITY_KEYS.trip, "trip-1")}>Delete</button></section>
    <section aria-label="Trip days"><button onClick={() => void createBikeRecord(BIKE_ENTITY_KEYS.tripDay, { date: "2026-08-01" })}>Add</button><button onClick={() => void updateBikeRecord(BIKE_ENTITY_KEYS.tripDay, "day-1", { date: "2026-08-02" })}>Save</button><button onClick={() => void deleteBikeRecord(BIKE_ENTITY_KEYS.tripDay, "day-1")}>Remove</button></section>
    <section aria-label="Stops"><button onClick={() => void createBikeRecord(BIKE_ENTITY_KEYS.stop, { place_name: "Start" })}>Add</button><button onClick={() => void updateBikeRecord(BIKE_ENTITY_KEYS.stop, "stop-1", { place_name: "Cafe" })}>Save</button><button onClick={() => void deleteBikeRecord(BIKE_ENTITY_KEYS.stop, "stop-1")}>Remove</button></section>
    <section aria-label="Route options"><button onClick={() => void planRoute()}>Calculate</button><button onClick={() => void updateBikeRecord(BIKE_ENTITY_KEYS.routeOption, "route-1", { name: "Scenic" })}>Compare</button><button onClick={() => void deleteBikeRecord(BIKE_ENTITY_KEYS.routeOption, "route-1")}>Remove</button></section>
    <section aria-label="Saved places"><button onClick={() => void createBikeRecord(BIKE_ENTITY_KEYS.savedPlace, { name: "Inn" })}>Save</button><button onClick={() => void updateBikeRecord(BIKE_ENTITY_KEYS.savedPlace, "place-1", { name: "Campground" })}>Edit</button><button onClick={() => void deleteBikeRecord(BIKE_ENTITY_KEYS.savedPlace, "place-1")}>Remove</button></section>
    <section aria-label="Route place links"><button onClick={() => void createBikeRecord(BIKE_ENTITY_KEYS.routePlaceLink, { category: "food" })}>Save</button><button onClick={() => void updateBikeRecord(BIKE_ENTITY_KEYS.routePlaceLink, "link-1", { category: "stay" })}>Edit</button><button onClick={() => void deleteBikeRecord(BIKE_ENTITY_KEYS.routePlaceLink, "link-1")}>Remove</button></section>
    <section aria-label="GPS ride tracks"><button onClick={() => void createBikeRecord(BIKE_ENTITY_KEYS.gpsRideTrack, { mode: "manual_endpoints" })}>Start tracking</button><button onClick={() => void updateBikeRecord(BIKE_ENTITY_KEYS.gpsRideTrack, "gps-1", { mode: "live" })}>Save</button><button onClick={() => void deleteBikeRecord(BIKE_ENTITY_KEYS.gpsRideTrack, "gps-1")}>Stop tracking</button></section>
    <section aria-label="Photo journal entries"><button onClick={() => void createBikeRecord(BIKE_ENTITY_KEYS.photoJournalEntry, { caption: "View" })}>Upload image</button><button onClick={() => void updateBikeRecord(BIKE_ENTITY_KEYS.photoJournalEntry, "photo-1", { caption: "Summit" })}>Save</button><button onClick={() => void deleteBikeRecord(BIKE_ENTITY_KEYS.photoJournalEntry, "photo-1")}>Remove</button></section>
    <button onClick={() => void exportTripPlanningCsv()}>Export trip planning CSV</button>
    <GooglePlaceAutocomplete label="Origin" onPlaceSelect={() => undefined} />
    <DeviceLocationTracker onLocation={() => undefined} />
    <GoogleMapsTripMap places={[]} />
  </main>;
}`,
      "src/lib/bike-journey.test.ts": `import { expect, it } from "vitest";
it("creates updates and deletes trip, trip day, stop, route option, saved place, route place link, gps ride track, and photo journal entry records", () => expect("create update delete trip trip_day stop route_option saved_place route_place_link gpsride_track photo_journal_entry").toContain("gpsride_track"));
it("covers create multi-day trip, plan stops and bicycle routes, compare bicycle route alternatives, save route-related places, track current ride location, and export trip planning csv", () => expect("create plan compare save track current ride location export").toContain("track"));`,
      "e2e/generated/bike-journey.spec.ts": `import { test, expect } from "@playwright/test";
test("advanced bike planner controls are reachable", async ({ page }) => { await page.goto("/"); await expect(page.getByRole("button", { name: "Start tracking" })).toBeVisible(); await expect(page.getByRole("button", { name: "Upload image" })).toBeVisible(); await expect(page.getByRole("button", { name: "Export trip planning CSV" })).toBeVisible(); });`,
    };

    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });
    const codeReview = findReview(reviews, "code_reviewer");

    expect(codeReview.blockingIssues.join(" ")).not.toContain(
      "Advanced workflow coverage is incomplete",
    );
    expect(getPostGenerationBlockingIssues(reviews)).toEqual([]);
  });

  it("passes advanced coverage when entities, workflows, tests, and Google Maps are real", () => {
    const spec = advancedBikeSpec();
    const files: FileMap = {
      "src/app/page.tsx": `"use client";
import { PlatformSignInGate, usePlatformSessionState } from "@/components/voiceforge-reusable";
import { createPlatformRecord, listPlatformRecords, searchPlatformRecords, exportPlatformRecordsCsv } from "@/lib/platform-data";
import { computeGoogleMapsRoute, getGoogleMapsElevationProfile, searchGoogleMapsPlaces } from "@/lib/platform-integrations";
import { GoogleMapsTripMap, GooglePlaceAutocomplete } from "@/components/voiceforge-google-map";
export default function Page() {
  usePlatformSessionState();
  void PlatformSignInGate;
  void listPlatformRecords;
  void searchPlatformRecords;
  void exportPlatformRecordsCsv;
  async function createTrip() { await createPlatformRecord("trip", { name: "Tour" }); }
  async function saveTripDay() { await createPlatformRecord("trip_day", { date: "2026-08-01" }); }
  async function addStop() { await createPlatformRecord("trip_stop", { place_name: "Start" }); }
  async function calculateRoute() { const route = await computeGoogleMapsRoute({ origin: { address: "A" }, destination: { address: "B" }, travelMode: "BICYCLE", computeAlternativeRoutes: true, polylineQuality: "HIGH_QUALITY" }); await getGoogleMapsElevationProfile({ encodedPolyline: "abc", samples: 64 }); await createPlatformRecord("route_option", { name: "Comfort route", route_data: route.routes[0] }); }
  async function savePlace() { await searchGoogleMapsPlaces({ query: "cafe" }); await createPlatformRecord("saved_place", { name: "Cafe" }); }
  return <main><h1>Bike Journey Planner</h1><form><label>Trip name<input /></label><button onClick={() => void createTrip()}>Create trip</button></form><button onClick={() => void saveTripDay()}>Add trip day</button><button onClick={() => void addStop()}>Add stop</button><button onClick={() => void calculateRoute()}>Calculate bicycle route</button><button>Compare route alternatives</button><button onClick={() => void savePlace()}>Save place</button><button>Search places</button><button>Export CSV</button><GooglePlaceAutocomplete label="Origin" onPlaceSelect={() => undefined} /><GoogleMapsTripMap places={[]} /></main>;
}`,
      "src/lib/bike-workflows.test.ts": `import { expect, it } from "vitest";
it("creates trip and trip day records", () => expect("create trip trip_day").toContain("trip"));
it("adds trip stop records and calculates bicycle route options", () => expect("add trip_stop route_option calculate route").toContain("route_option"));
it("searches and saves saved place records", () => expect("search saved_place save place").toContain("saved_place"));
it("compares route alternatives and exports CSV", () => expect("compare route export csv").toContain("export"));`,
      "e2e/generated/bike-workflows.spec.ts": `import { test, expect } from "@playwright/test";
test("advanced bike workflow controls are reachable", async ({ page }) => { await page.goto("/"); await expect(page.getByRole("button", { name: "Add stop" })).toBeVisible(); await expect(page.getByRole("button", { name: "Calculate bicycle route" })).toBeVisible(); await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible(); });`,
    };

    const reviews = review({
      spec,
      architecture: buildArchitecture(spec),
      allFiles: files,
    });

    expect(getPostGenerationBlockingIssues(reviews)).toEqual([]);
  });
});
