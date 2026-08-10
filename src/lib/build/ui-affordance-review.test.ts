import { describe, expect, it } from "vitest";
import {
  createFallbackArchitecturePlan,
  type ArchitecturePlan,
} from "../architecture";
import { computeSpecComplexity, normalizeAppSpec, type AppSpec } from "../spec";
import type { WorkflowContract, WorkflowContractRole } from "../workflow-contract";
import { analyzeUiAffordances } from "./ui-affordance-review";
import type { FileMap } from "./template";

const spec = normalizeAppSpec({
  appName: "Ride Helper",
  purpose: "Track a family bicycle ride with device GPS.",
  targetUsers: "A family",
  screens: [
    { name: "Home", description: "Open ride tools." },
    { name: "GPS", description: "Track the current ride." },
  ],
  features: ["Track a ride"],
  dataToStore: ["rides"],
  needsLogin: true,
  sharingModel: "shared" as const,
  aiFeatures: [],
  testPlan: ["Start GPS tracking"],
  deploymentNotes: "",
  capabilityTier: "advanced" as const,
  dataEntities: [
    {
      name: "Ride",
      description: "A saved bicycle ride.",
      ownership: "shared" as const,
      fields: [
        {
          name: "name",
          label: "Ride name",
          type: "text" as const,
          required: true,
          validation: "Ride name is required.",
        },
      ],
      relationships: [],
    },
  ],
  workflows: [
    {
      name: "Track current ride",
      actor: "Editor",
      trigger: "Editor opens GPS tracking.",
      steps: ["Start GPS tracking", "Save the ride"],
      successOutcome: "The ride is visible in GPS history.",
      failureStates: ["Location permission denied"],
    },
  ],
});

function rideContract(
  roles: WorkflowContractRole[] = ["owner", "editor"],
): WorkflowContract {
  return {
    id: "track-current-ride",
    name: "Track current ride",
    actor: { persona: "Rider", roles },
    trigger: "user_action",
    start: {
      route: "/gps",
      screen: "GPS",
      preconditions: ["Signed in"],
    },
    controls: [
      {
        id: "start-gps-tracking",
        kind: "button",
        accessibleName: "Start GPS tracking",
        route: "/gps",
        roles,
        action: "Start the ride tracker",
      },
    ],
    steps: [
      {
        id: "start-tracking",
        description: "Start GPS tracking",
        kind: "save",
        route: "/gps",
        controlId: "start-gps-tracking",
        reads: ["ride"],
        writes: ["ride"],
        visibleResult: "The ride appears in GPS history.",
      },
    ],
    requiredData: [
      {
        entityName: "Ride",
        entityKey: "ride",
        operations: ["read", "create"],
        requiredFieldKeys: ["name"],
      },
    ],
    expectedSaves: [
      {
        stepId: "start-tracking",
        operation: "create",
        entityName: "Ride",
        entityKey: "ride",
        fieldKeys: ["name"],
        storage: "platformData",
        producedReference: "saved-ride",
      },
    ],
    success: {
      message: "Ride started.",
      visibleResult: "The ride appears in GPS history.",
      route: "/gps",
    },
    failureStates: ["Location permission denied"],
    handoffs: [],
    dependencies: {
      workflowIds: [],
      platformServices: ["data", "device_location"],
    },
    source: {
      workflowName: "Track current ride",
      acceptanceCriteria: ["Start GPS tracking"],
      testScenarios: ["Save a ride"],
    },
  };
}

function architecture(contract = rideContract()): ArchitecturePlan {
  const base = createFallbackArchitecturePlan(spec, computeSpecComplexity(spec));
  return {
    ...base,
    pageMap: [
      {
        route: "/",
        name: "Home",
        purpose: "Open ride tools.",
        primaryComponents: ["HomePage"],
        workflows: [],
      },
      {
        route: "/gps",
        name: "GPS",
        purpose: "Track the current ride.",
        primaryComponents: ["GpsPage"],
        workflows: [contract.name],
      },
    ],
    workflowContracts: [contract],
  };
}

const gpsPage = `"use client";
import { createPlatformRecord, listPlatformRecords } from "@/lib/platform-data";
export default function GpsPage() {
  void listPlatformRecords("ride");
  return <main><h1>GPS tracking</h1><button onClick={() => void createPlatformRecord("ride", { name: "Morning ride" })}>Start GPS tracking</button></main>;
}`;

function review(files: FileMap, appArchitecture = architecture(), appSpec: AppSpec = spec) {
  return analyzeUiAffordances({
    spec: appSpec,
    architecture: appArchitecture,
    files,
  });
}

describe("UI affordance review", () => {
  it("blocks a workflow page that is available only through a hidden URL", () => {
    const result = review({
      "src/app/page.tsx":
        "export default function Home() { return <main><h1>Ride Helper</h1></main>; }",
      "src/app/gps/page.tsx": gpsPage,
    });

    expect(result.hiddenRoutes).toContain("/gps");
    expect(result.workflows[0]).toMatchObject({
      status: "needs_repair",
      unreachableRoles: ["owner", "editor"],
    });
    expect(result.blockingIssues.join(" ")).toContain(
      "cannot reach it through visible navigation",
    );
  });

  it("passes a reachable GPS workflow with the contracted control", () => {
    const result = review({
      "src/app/page.tsx": `import Link from "next/link";
export default function Home() { return <main><h1>Ride Helper</h1><Link href="/gps">GPS tracking</Link></main>; }`,
      "src/app/gps/page.tsx": gpsPage,
    });

    expect(result.blockingIssues).toEqual([]);
    expect(result.summary).toMatchObject({
      routesFound: 2,
      reachableRoutes: 2,
      workflowsDiscoverable: 1,
      controlsMatched: 1,
      entityPathsAvailable: 2,
    });
  });

  it("follows navigation rendered by an imported shared component", () => {
    const result = review({
      "src/app/page.tsx": `import { AppNav } from "@/components/app-nav";
export default function Home() { return <main><h1>Ride Helper</h1><AppNav /></main>; }`,
      "src/components/app-nav.tsx": `import Link from "next/link";
export function AppNav() { return <nav><Link href="/gps">GPS tracking</Link></nav>; }`,
      "src/app/gps/page.tsx": gpsPage,
    });

    expect(result.routes.find((route) => route.route === "/gps"))
      .toMatchObject({ reachableByRoles: ["owner", "editor", "viewer", "public"] });
    expect(result.workflows[0].status).toBe("discoverable");
  });

  it("blocks a missing contracted control even when the route is reachable", () => {
    const result = review({
      "src/app/page.tsx": `import Link from "next/link";
export default function Home() { return <Link href="/gps">GPS tracking</Link>; }`,
      "src/app/gps/page.tsx": gpsPage.replace(
        "Start GPS tracking</button>",
        "Begin ride</button>",
      ),
    });

    expect(result.workflows[0].missingControls).toEqual([
      {
        controlId: "start-gps-tracking",
        label: "Start GPS tracking",
        route: "/gps",
        roles: ["owner", "editor"],
      },
    ]);
    expect(result.blockingIssues.join(" ")).toContain(
      'requires a visible button named "Start GPS tracking"',
    );
  });

  it("blocks placeholder workflow pages and vague action labels", () => {
    const placeholder = review({
      "src/app/page.tsx": `import Link from "next/link";
export default function Home() { return <Link href="/gps">GPS tracking</Link>; }`,
      "src/app/gps/page.tsx":
        "export default function GpsPage() { return <main><h1>GPS</h1><p>Coming soon</p></main>; }",
    });
    const vague = review({
      "src/app/page.tsx": `import Link from "next/link";
export default function Home() { return <Link href="/gps">GPS tracking</Link>; }`,
      "src/app/gps/page.tsx": gpsPage.replace(
        "Start GPS tracking</button>",
        "Submit</button>",
      ),
    });

    expect(placeholder.placeholderRoutes).toContain("/gps");
    expect(placeholder.blockingIssues.join(" ")).toContain(
      "mostly placeholder content",
    );
    expect(vague.vagueControls.map((control) => control.label)).toContain(
      "Submit",
    );
    expect(vague.blockingIssues.join(" ")).toContain("vague button label");
  });

  it("blocks a user-managed entity that has no visible workflow path", () => {
    const appArchitecture = { ...architecture(), workflowContracts: [] };
    const result = review(
      {
        "src/app/page.tsx":
          "export default function Home() { return <main><h1>Ride Helper</h1></main>; }",
      },
      appArchitecture,
    );

    expect(result.entities[0]).toMatchObject({
      entityKey: "ride",
      status: "needs_repair",
      requiredOperations: ["read"],
      availableOperations: [],
    });
    expect(result.blockingIssues.join(" ")).toContain(
      "Entity Ride (ride) has no discoverable read path",
    );
  });

  it("respects role-restricted navigation when checking discoverability", () => {
    const viewerContract = rideContract(["viewer"]);
    const result = review(
      {
        "src/app/page.tsx": `import Link from "next/link";
export default function Home({ session }: { session: { canWrite: boolean } }) { return <main>{session.canWrite && <Link href="/gps">GPS tracking</Link>}</main>; }`,
        "src/app/gps/page.tsx": gpsPage,
      },
      architecture(viewerContract),
    );

    expect(result.workflows[0]).toMatchObject({
      status: "needs_repair",
      unreachableRoles: ["viewer"],
    });
  });

  it("matches dynamic contextual links to generated detail routes", () => {
    const contract: WorkflowContract = {
      ...rideContract(),
      id: "edit-trip",
      name: "Edit trip",
      start: { route: "/trips/[tripId]", screen: "Trip", preconditions: [] },
      controls: [
        {
          id: "edit-trip",
          kind: "button",
          accessibleName: "Edit trip",
          route: "/trips/[tripId]",
          roles: ["owner", "editor"],
          action: "Edit the selected trip",
        },
      ],
      steps: [
        {
          id: "edit-trip-step",
          description: "Edit trip",
          kind: "action",
          route: "/trips/[tripId]",
          controlId: "edit-trip",
          reads: [],
          writes: [],
          visibleResult: "Trip editor opens.",
        },
      ],
      requiredData: [],
      expectedSaves: [],
      success: {
        message: "",
        visibleResult: "Trip editor opens.",
        route: "/trips/[tripId]",
      },
    };
    const appSpec = { ...spec, dataEntities: [] };
    const appArchitecture: ArchitecturePlan = {
      ...architecture(contract),
      dataModel: [],
      workflowContracts: [contract],
    };
    const result = review(
      {
        "src/app/page.tsx": `import Link from "next/link";
export default function Home() { const trip = { id: "trip-1" }; return <Link href={\`/trips/\${trip.id}\`}>View trip</Link>; }`,
        "src/app/trips/[tripId]/page.tsx":
          "export default function TripPage() { return <main><h1>Trip</h1><button>Edit trip</button></main>; }",
      },
      appArchitecture,
      appSpec,
    );

    expect(result.workflows[0].status).toBe("discoverable");
    expect(result.hiddenRoutes).not.toContain("/trips/[tripId]");
  });

  it("recognizes reusable form labels, submit-label props, and object-driven navigation", () => {
    const contract: WorkflowContract = {
      ...rideContract(),
      controls: [
        {
          id: "ride-name",
          kind: "textbox",
          accessibleName: "Ride name",
          route: "/gps",
          roles: ["owner", "editor"],
          action: "Enter the ride name",
        },
        {
          id: "save-ride",
          kind: "button",
          accessibleName: "Save ride",
          route: "/gps",
          roles: ["owner", "editor"],
          action: "Save the ride",
        },
      ],
    };
    const result = review(
      {
        "src/app/page.tsx": `import { PrimaryNavigation } from "@/components/primary-navigation";
import { PlatformSignInGate } from "@/components/voiceforge-reusable";
export default function Home() { return <main><h1>Ride Helper</h1><PrimaryNavigation /><PlatformSignInGate /></main>; }`,
        "src/app/gps/page.tsx": `import { RideForm } from "@/components/ride-form";
import { createRide, listRides } from "@/lib/rides";
export default function GpsPage() { void listRides(); return <main><h1>GPS</h1><RideForm submitLabel="Save ride" onSave={createRide} /></main>; }`,
        "src/components/primary-navigation.tsx": `import Link from "next/link";
const items = [{ href: "/", label: "Home" }, { href: "/gps", label: "GPS tracking" }];
export function PrimaryNavigation() { return <nav>{items.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}</nav>; }`,
        "src/components/ride-form.tsx": `export function RideForm({ submitLabel = "Save ride", onSave }: { submitLabel?: string; onSave: () => void }) {
return <form onSubmit={(event) => { event.preventDefault(); onSave(); }}><label htmlFor="ride-name">Ride name</label><input id="ride-name" /><button type="submit">{submitLabel}</button></form>; }`,
        "src/components/voiceforge-reusable.tsx": `export function PlatformSignInGate() { return <button>Sign in to VoiceForge</button>; }
export function AddButton({ children = "Add" }: { children?: string }) { return <button>{children}</button>; }`,
        "src/lib/rides.ts": `import { createPlatformRecord, listPlatformRecords } from "@/lib/platform-data";
export function createRide() { return createPlatformRecord("ride", { name: "Morning ride" }); }
export function listRides() { return listPlatformRecords("ride"); }`,
      },
      architecture(contract),
    );

    expect(result.workflows[0]).toMatchObject({
      status: "discoverable",
      matchedControls: 2,
      expectedControls: 2,
    });
    expect(result.routes.find((route) => route.route === "/gps")?.incomingFrom)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ route: "/", label: "GPS tracking" }),
        ]),
      );
    expect(result.vagueControls).toEqual([]);
    expect(result.uncertainControls).toEqual([]);
    expect(result.entities[0]).toMatchObject({
      status: "available",
      availableOperations: ["create", "read"],
    });
    expect(result.blockingIssues).toEqual([]);
  });

  it("resolves mapped navigation aliases used by generated app shells", () => {
    const result = review(
      {
        "src/app/page.tsx": `import { AppShell } from "@/components/app-shell";
export default function Home() { return <AppShell><h1>Overview</h1></AppShell>; }`,
        "src/app/gps/page.tsx": `import { AppShell } from "@/components/app-shell";
export default function GpsPage() { return <AppShell><h1>GPS</h1><button>Start tracking</button></AppShell>; }`,
        "src/components/app-shell.tsx": `import Link from "next/link";
const navigationLinks = [{ path: "/", text: "Overview" }, { path: "/gps", text: "GPS tracking" }];
export function AppShell({ children }: { children: React.ReactNode }) { return <><nav>{navigationLinks.map((item) => <Link key={item.path} href={item.path}>{item.text}</Link>)}</nav><main>{children}</main></>; }`,
      },
      architecture(rideContract()),
    );

    expect(result.routes.find((route) => route.route === "/gps")).toMatchObject({
      reachableByRoles: ["owner", "editor", "viewer", "public"],
      incomingFrom: expect.arrayContaining([
        expect.objectContaining({ route: "/", label: "GPS tracking" }),
      ]),
    });
    expect(result.workflows[0].status).toBe("discoverable");
    expect(result.blockingIssues).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("cannot reach it through visible navigation"),
      ]),
    );
  });

  it("resolves tuple and route-keyed navigation collections", () => {
    const tupleResult = review(
      {
        "src/app/page.tsx": `import { AppShell } from "@/components/app-shell";
export default function Home() { return <AppShell><h1>Overview</h1></AppShell>; }`,
        "src/app/gps/page.tsx": `import { AppShell } from "@/components/app-shell";
export default function GpsPage() { return <AppShell><h1>GPS</h1><button>Start tracking</button></AppShell>; }`,
        "src/components/app-shell.tsx": `import Link from "next/link";
const routeLinks = [["Overview", "/"], ["GPS tracking", "/gps"]] as const;
export function AppShell({ children }: { children: React.ReactNode }) { return <><nav>{routeLinks.map(([label, path]) => <Link key={path} href={path}>{label}</Link>)}</nav><main>{children}</main></>; }`,
      },
      architecture(rideContract()),
    );
    const keyedResult = review(
      {
        "src/app/page.tsx": `import { AppShell } from "@/components/app-shell";
export default function Home() { return <AppShell><h1>Overview</h1></AppShell>; }`,
        "src/app/gps/page.tsx": `import { AppShell } from "@/components/app-shell";
export default function GpsPage() { return <AppShell><h1>GPS</h1><button>Start tracking</button></AppShell>; }`,
        "src/components/app-shell.tsx": `import Link from "next/link";
const navigationRoutes = { "/": "Overview", "/gps": "GPS tracking" };
export function AppShell({ children }: { children: React.ReactNode }) { return <><nav>{Object.entries(navigationRoutes).map(([path, label]) => <Link key={path} href={path}>{label}</Link>)}</nav><main>{children}</main></>; }`,
      },
      architecture(rideContract()),
    );

    expect(tupleResult.workflows[0].status).toBe("discoverable");
    expect(keyedResult.workflows[0].status).toBe("discoverable");
  });

  it("uses a textbox label instead of treating its controlled value as its name", () => {
    const contract: WorkflowContract = {
      ...rideContract(),
      controls: [
        {
          id: "ride-search",
          kind: "textbox",
          accessibleName: "Search rides by name or destination",
          route: "/gps",
          roles: ["owner", "editor"],
          action: "Search saved rides",
        },
      ],
    };
    const result = review(
      {
        "src/app/page.tsx": `import Link from "next/link";
export default function Home() { return <Link href="/gps">GPS tracking</Link>; }`,
        "src/app/gps/page.tsx": `import { RideSearch } from "@/components/ride-search";
export default function GpsPage() { return <main><h1>GPS</h1><RideSearch query="" onQueryChange={() => {}} /></main>; }`,
        "src/components/ride-search.tsx": `export function RideSearch({ query, onQueryChange }: { query: string; onQueryChange: (value: string) => void }) { return <label>Search rides by name or destination<input value={query} onChange={(event) => onQueryChange(event.target.value)} /></label>; }`,
      },
      architecture(contract),
    );

    expect(result.workflows[0]).toMatchObject({
      status: "discoverable",
      missingControls: [],
    });
    expect(
      result.routes
        .find((route) => route.route === "/gps")
        ?.controls.find((control) => control.kind === "textbox"),
    ).toMatchObject({
      label: "Search rides by name or destination",
      labelConfidence: "resolved",
    });
  });

  it("warns about unresolved runtime labels instead of claiming they are absent", () => {
    const result = review({
      "src/app/page.tsx": `import Link from "next/link";
export default function Home() { return <Link href="/gps">GPS tracking</Link>; }`,
      "src/app/gps/page.tsx": `import { RideAction } from "@/components/ride-action";
export default function GpsPage() { return <main><h1>GPS</h1><RideAction /></main>; }`,
      "src/components/ride-action.tsx":
        "export function RideAction({ actionLabel }: { actionLabel: string }) { return <button>{actionLabel}</button>; }",
    });

    expect(result.uncertainControls).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("runtime-provided button label");
    expect(result.blockingIssues.join(" ")).not.toContain(
      "has an unlabeled button",
    );
  });

  it("reports a shared shell control once even when it appears on every route", () => {
    const result = review({
      "src/app/page.tsx": `import Link from "next/link"; import { SharedShell } from "@/components/shared-shell";
export default function Home() { return <main><SharedShell /><Link href="/gps">GPS tracking</Link></main>; }`,
      "src/app/gps/page.tsx": `import { SharedShell } from "@/components/shared-shell";
${gpsPage.replace('"use client";', "").replace("return <main>", "return <><SharedShell /><main>").replace("</main>;", "</main></>;")}`,
      "src/components/shared-shell.tsx":
        "export function SharedShell() { return <header><button><span aria-hidden=\"true\">+</span></button></header>; }",
    });

    expect(
      result.blockingIssues.filter((issue) => issue.includes("shared-shell")),
    ).toHaveLength(1);
    expect(
      result.vagueControls.filter(
        (control) => control.filePath === "src/components/shared-shell.tsx",
      ),
    ).toHaveLength(1);
  });

  it("passes the Family Outing Planner reusable workflow pattern", () => {
    const familySpec: AppSpec = {
      ...spec,
      appName: "Family Outing Planner",
      dataEntities: [
        {
          name: "Outing",
          description: "A shared family outing.",
          ownership: "shared",
          fields: [
            {
              name: "title",
              label: "Title",
              type: "text",
              required: true,
              validation: "Title is required.",
            },
          ],
          relationships: [],
        },
        {
          name: "PackingItem",
          description: "An item linked to an outing.",
          ownership: "shared",
          fields: [
            {
              name: "itemName",
              label: "Item name",
              type: "text",
              required: true,
              validation: "Item name is required.",
            },
          ],
          relationships: [],
        },
      ],
    };
    const control = (
      id: string,
      kind: WorkflowContract["controls"][number]["kind"],
      accessibleName: string,
      route: string,
      roles: WorkflowContractRole[] = ["owner", "editor"],
    ): WorkflowContract["controls"][number] => ({
      id,
      kind,
      accessibleName,
      route,
      roles,
      action: accessibleName,
    });
    const workflow = (input: {
      id: string;
      name: string;
      route: string;
      controls: WorkflowContract["controls"];
      requiredData: WorkflowContract["requiredData"];
      expectedSaves?: WorkflowContract["expectedSaves"];
      roles?: WorkflowContractRole[];
    }): WorkflowContract => ({
      ...rideContract(input.roles ?? ["owner", "editor"]),
      id: input.id,
      name: input.name,
      actor: {
        persona: "Family member",
        roles: input.roles ?? ["owner", "editor"],
      },
      start: { route: input.route, screen: input.name, preconditions: [] },
      controls: input.controls,
      requiredData: input.requiredData,
      expectedSaves: input.expectedSaves ?? [],
      success: {
        route: input.route,
        message: `${input.name} completed.`,
        visibleResult: `${input.name} is visible.`,
      },
    });
    const outingFields = ["title", "date", "location", "notes", "status"];
    const contracts: WorkflowContract[] = [
      workflow({
        id: "plan-new-outing",
        name: "Plan a new outing",
        route: "/",
        controls: [
          control("plan", "button", "Plan new outing", "/"),
          control("title", "textbox", "Title", "/outings/new"),
          control("date", "date", "Date", "/outings/new"),
          control("location", "textbox", "Location", "/outings/new"),
          control("notes", "textbox", "Notes", "/outings/new"),
          control("status", "combobox", "Status", "/outings/new"),
          control("save", "button", "Save outing", "/outings/new"),
        ],
        requiredData: [
          {
            entityName: "Outing",
            entityKey: "outing",
            operations: ["create", "read"],
            requiredFieldKeys: outingFields,
          },
        ],
        expectedSaves: [
          {
            stepId: "start-tracking",
            operation: "create",
            entityName: "Outing",
            entityKey: "outing",
            fieldKeys: outingFields,
            storage: "platformData",
            producedReference: "outing.id",
          },
        ],
      }),
      workflow({
        id: "view-outing",
        name: "View an outing",
        route: "/outings",
        roles: ["owner", "editor", "viewer"],
        controls: [
          control(
            "view",
            "link",
            "View outing",
            "/outings",
            ["owner", "editor", "viewer"],
          ),
        ],
        requiredData: [
          {
            entityName: "Outing",
            entityKey: "outing",
            operations: ["read"],
            requiredFieldKeys: outingFields,
          },
        ],
      }),
      workflow({
        id: "edit-outing",
        name: "Edit an outing",
        route: "/outings/[outingId]",
        controls: [
          control("edit", "button", "Edit outing", "/outings/[outingId]"),
          control("title", "textbox", "Title", "/outings/[outingId]"),
          control("date", "date", "Date", "/outings/[outingId]"),
          control("location", "textbox", "Location", "/outings/[outingId]"),
          control("notes", "textbox", "Notes", "/outings/[outingId]"),
          control("status", "combobox", "Status", "/outings/[outingId]"),
          control("save", "button", "Save outing changes", "/outings/[outingId]"),
        ],
        requiredData: [
          {
            entityName: "Outing",
            entityKey: "outing",
            operations: ["read", "update"],
            requiredFieldKeys: outingFields,
          },
        ],
        expectedSaves: [
          {
            stepId: "start-tracking",
            operation: "update",
            entityName: "Outing",
            entityKey: "outing",
            fieldKeys: outingFields,
            storage: "platformData",
            producedReference: "outing.id",
          },
        ],
      }),
      workflow({
        id: "add-packing-item",
        name: "Add a packing item",
        route: "/outings/[outingId]",
        controls: [
          control("add", "button", "Add packing item", "/outings/[outingId]"),
          control("item", "textbox", "Item name", "/outings/[outingId]"),
          control("save", "button", "Save packing item", "/outings/[outingId]"),
        ],
        requiredData: [
          {
            entityName: "PackingItem",
            entityKey: "packing_item",
            operations: ["create", "read"],
            requiredFieldKeys: ["outing", "item_name", "packed_status"],
          },
        ],
        expectedSaves: [
          {
            stepId: "start-tracking",
            operation: "create",
            entityName: "PackingItem",
            entityKey: "packing_item",
            fieldKeys: ["outing", "item_name", "packed_status"],
            storage: "platformData",
            producedReference: "packing_item.id",
          },
        ],
      }),
      workflow({
        id: "update-packing-status",
        name: "Update packing status",
        route: "/packing",
        controls: [
          control(
            "outing-filter",
            "combobox",
            "Filter by outing",
            "/packing",
            ["owner", "editor", "viewer"],
          ),
          control(
            "status-filter",
            "combobox",
            "Filter by packed status",
            "/packing",
            ["owner", "editor", "viewer"],
          ),
          control("packed", "button", "Mark packed", "/packing"),
          control("unpacked", "button", "Mark not packed", "/packing"),
        ],
        requiredData: [
          {
            entityName: "PackingItem",
            entityKey: "packing_item",
            operations: ["read", "update"],
            requiredFieldKeys: ["outing", "item_name", "packed_status"],
          },
        ],
        expectedSaves: [
          {
            stepId: "start-tracking",
            operation: "update",
            entityName: "PackingItem",
            entityKey: "packing_item",
            fieldKeys: ["packed_status"],
            storage: "platformData",
            producedReference: "packing_item.id",
          },
        ],
      }),
    ];
    const base = createFallbackArchitecturePlan(
      familySpec,
      computeSpecComplexity(familySpec),
    );
    const appArchitecture: ArchitecturePlan = {
      ...base,
      workflowContracts: contracts,
      pageMap: [
        { route: "/", name: "Dashboard", purpose: "Plan outings", primaryComponents: [], workflows: [] },
        { route: "/outings", name: "Outings", purpose: "List outings", primaryComponents: [], workflows: [] },
        { route: "/outings/new", name: "New Outing", purpose: "Create outing", primaryComponents: [], workflows: [] },
        { route: "/outings/[outingId]", name: "Outing Details", purpose: "Edit outing", primaryComponents: [], workflows: [] },
        { route: "/packing", name: "Packing", purpose: "Update packing", primaryComponents: [], workflows: [] },
      ],
    };
    const result = review(
      {
        "src/app/page.tsx": `import Link from "next/link"; import { PrimaryNavigation } from "@/components/primary-navigation";
export default function Dashboard() { return <main><PrimaryNavigation /><h1>Family Outing Planner</h1><Link href="/outings/new">Plan new outing</Link></main>; }`,
        "src/app/outings/page.tsx": `import Link from "next/link"; import { PrimaryNavigation } from "@/components/primary-navigation"; import { listOutings } from "@/lib/outings";
export default function Outings() { void listOutings(); const outing = { id: "outing-1" }; return <main><PrimaryNavigation /><h1>Outings</h1><Link href={\`/outings/\${outing.id}\`}>View outing</Link></main>; }`,
        "src/app/outings/new/page.tsx": `import { PrimaryNavigation } from "@/components/primary-navigation"; import { OutingForm } from "@/components/outing-form"; import { createOuting } from "@/lib/outings";
export default function NewOuting() { return <main><PrimaryNavigation /><h1>New Outing</h1><OutingForm submitLabel="Save outing" onSave={createOuting} /></main>; }`,
        "src/app/outings/[outingId]/page.tsx": `import { PrimaryNavigation } from "@/components/primary-navigation"; import { OutingForm } from "@/components/outing-form"; import { PackingItemForm } from "@/components/packing-item-form"; import { updateOuting } from "@/lib/outings"; import { createPackingItem } from "@/lib/packing";
export default function OutingDetails() { return <main><PrimaryNavigation /><h1>Outing Details</h1><button>Edit outing</button><OutingForm submitLabel="Save outing changes" onSave={updateOuting} /><button>Add packing item</button><PackingItemForm submitLabel="Save packing item" onSave={createPackingItem} /></main>; }`,
        "src/app/packing/page.tsx": `import { PrimaryNavigation } from "@/components/primary-navigation"; import { listPackingItems, updatePackingItem } from "@/lib/packing";
export default function Packing() { void listPackingItems(); void updatePackingItem; return <main><PrimaryNavigation /><h1>Packing List</h1><label htmlFor="outing-filter">Filter by outing</label><select id="outing-filter" /><label htmlFor="status-filter">Filter by packed status</label><select id="status-filter" /><button>Mark packed</button><button>Mark not packed</button></main>; }`,
        "src/components/primary-navigation.tsx": `import Link from "next/link"; const items = [{ href: "/", label: "Dashboard" }, { href: "/outings", label: "Outings" }, { href: "/packing", label: "Packing List" }]; export function PrimaryNavigation() { return <nav>{items.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}</nav>; }`,
        "src/components/outing-form.tsx": `export function OutingForm({ submitLabel = "Save outing", onSave }: { submitLabel?: string; onSave: () => void }) { return <form onSubmit={(event) => { event.preventDefault(); onSave(); }}><label htmlFor="title">Title</label><input id="title" /><label htmlFor="date">Date</label><input id="date" type="date" /><label htmlFor="location">Location</label><input id="location" /><label htmlFor="notes">Notes</label><textarea id="notes" /><label htmlFor="status">Status</label><select id="status" /><button type="submit">{submitLabel}</button></form>; }`,
        "src/components/packing-item-form.tsx": `export function PackingItemForm({ submitLabel = "Save packing item", onSave }: { submitLabel?: string; onSave: () => void }) { return <form onSubmit={(event) => { event.preventDefault(); onSave(); }}><label htmlFor="item-name">Item name</label><input id="item-name" /><button type="submit">{submitLabel}</button></form>; }`,
        "src/components/voiceforge-reusable.tsx": `export function PlatformSignInGate() { return <button>Sign in to VoiceForge</button>; } export function AddButton({ children = "Add" }: { children?: string }) { return <button>{children}</button>; }`,
        "src/lib/outings.ts": `import { createPlatformRecord, listPlatformRecords, updatePlatformRecord } from "@/lib/platform-data"; export function createOuting() { return createPlatformRecord("outing", {}); } export function listOutings() { return listPlatformRecords("outing"); } export function updateOuting() { return updatePlatformRecord("outing-1", {}); }`,
        "src/lib/packing.ts": `import { createPlatformRecord, listPlatformRecords, updatePlatformRecord } from "@/lib/platform-data"; export function createPackingItem() { return createPlatformRecord("packing_item", {}); } export function listPackingItems() { return listPlatformRecords("packing_item"); } export function updatePackingItem() { return updatePlatformRecord("packing-1", {}); }`,
      },
      appArchitecture,
      familySpec,
    );

    expect(result.summary).toMatchObject({
      routesFound: 5,
      reachableRoutes: 5,
      workflowsPlanned: 5,
      workflowsDiscoverable: 5,
      controlsExpected: 22,
      controlsMatched: 22,
      hiddenRoutes: 0,
      placeholderPages: 0,
      vagueControls: 0,
    });
    expect(result.entities.every((entity) => entity.status === "available")).toBe(
      true,
    );
    expect(result.blockingIssues).toEqual([]);
  });

  it("passes reusable-field book forms and viewer controls beside writer-only actions", () => {
    const roles: WorkflowContractRole[] = ["owner", "editor"];
    const control = (
      id: string,
      kind: WorkflowContract["controls"][number]["kind"],
      accessibleName: string,
      route: string,
      controlRoles: WorkflowContractRole[],
    ): WorkflowContract["controls"][number] => ({
      id,
      kind,
      accessibleName,
      route,
      roles: controlRoles,
      action: accessibleName,
    });
    const workflow = (
      id: string,
      name: string,
      route: string,
      workflowRoles: WorkflowContractRole[],
      controls: WorkflowContract["controls"],
    ): WorkflowContract => ({
      ...rideContract(workflowRoles),
      id,
      name,
      actor: { persona: "Family member", roles: workflowRoles },
      start: { route, screen: name, preconditions: ["Signed in"] },
      controls,
      requiredData: [],
      expectedSaves: [],
      success: {
        route,
        message: `${name} complete.`,
        visibleResult: `${name} is visible.`,
      },
    });
    const contracts: WorkflowContract[] = [
      workflow("add-a-book", "Add a book", "/books", roles, [
        control("title", "textbox", "Title", "/books", roles),
        control("author", "textbox", "Author", "/books", roles),
        control("category", "textbox", "Category", "/books", roles),
        control("save-book", "button", "Save book", "/books", roles),
      ]),
      workflow("edit-a-book", "Edit a book", "/books", roles, [
        control("edit-title", "textbox", "Title", "/books", roles),
        control("edit-author", "textbox", "Author", "/books", roles),
        control("edit-category", "textbox", "Category", "/books", roles),
        control(
          "save-book-changes",
          "button",
          "Save book changes",
          "/books",
          roles,
        ),
      ]),
      workflow("view-current-loans", "View current loans", "/loans", ["viewer"], [
        control(
          "status-filter",
          "combobox",
          "Filter loans by status",
          "/loans",
          ["viewer"],
        ),
        control(
          "due-date-sort",
          "combobox",
          "Sort loans by due date",
          "/loans",
          ["viewer"],
        ),
      ]),
    ];
    const appArchitecture: ArchitecturePlan = {
      ...architecture(),
      dataModel: [],
      workflowContracts: contracts,
      pageMap: [
        { route: "/", name: "Home", purpose: "Open lending tools", primaryComponents: [], workflows: [] },
        { route: "/books", name: "Books", purpose: "Manage books", primaryComponents: [], workflows: [] },
        { route: "/loans", name: "Loans", purpose: "View loans", primaryComponents: [], workflows: [] },
      ],
    };
    const result = review(
      {
        "src/app/page.tsx": `import Link from "next/link"; export default function Home() { return <main><h1>Book Lending</h1><Link href="/books">Books</Link><Link href="/loans">Current Loans</Link></main>; }`,
        "src/app/books/page.tsx": `import { BooksPage } from "@/components/books-page"; export default function Books() { return <BooksPage session={{ canWrite: true }} />; }`,
        "src/app/loans/page.tsx": `import { LoansPage } from "@/components/loans-page"; export default function Loans() { return <LoansPage session={{ canWrite: true }} />; }`,
        "src/components/books-page.tsx": `import { BookForm } from "@/components/book-form"; export function BooksPage({ session }: { session: { canWrite: boolean } }) { return <main><h1>Books</h1>{session.canWrite && <BookForm mode="add" />}{session.canWrite && <BookForm mode="edit" />}</main>; }`,
        "src/components/book-form.tsx": `function Field({ id, label }: { id: string; label: string }) { return <div><label htmlFor={id}>{label}</label><input id={id} name={id} /></div>; } export function BookForm({ mode }: { mode: "add" | "edit" }) { const saving = false; const submitLabel = mode === "edit" ? "Save book changes" : "Save book"; return <form><Field id="title" label="Title" /><Field id="author" label="Author" /><Field id="category" label="Category" /><button type="submit">{saving ? "Saving book..." : submitLabel}</button></form>; }`,
        "src/components/loans-page.tsx": `import { LoanFilters } from "@/components/loan-filters"; export function LoansPage({ session }: { session: { canWrite: boolean } }) { return <main><h1>Current Loans</h1>{session.canWrite && <button>Mark loan returned</button>}<LoanFilters /></main>; }`,
        "src/components/loan-filters.tsx": `export function LoanFilters() { return <div><label htmlFor="status">Filter loans by status</label><select id="status" /><label htmlFor="due-date">Sort loans by due date</label><select id="due-date" /></div>; }`,
      },
      appArchitecture,
      { ...spec, dataEntities: [] },
    );

    expect(result.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contractId: "add-a-book", status: "discoverable" }),
        expect.objectContaining({ contractId: "edit-a-book", status: "discoverable" }),
        expect.objectContaining({ contractId: "view-current-loans", status: "discoverable" }),
      ]),
    );
    expect(
      result.routes
        .find((route) => route.route === "/loans")
        ?.controls.find((item) => item.label === "Filter loans by status")?.roles,
    ).toContain("viewer");
    expect(
      result.routes
        .find((route) => route.route === "/books")
        ?.controls.filter((control) => control.kind === "textbox")
        .map((control) => [control.label, control.labelConfidence]),
    ).toEqual(
      expect.arrayContaining([
        ["Title", "resolved"],
        ["Author", "resolved"],
        ["Category", "resolved"],
      ]),
    );
    expect(result.blockingIssues).toEqual([]);
  });
});
