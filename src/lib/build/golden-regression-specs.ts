import { normalizeAppSpec, type AppSpec } from "../spec";

export type GoldenRegressionSpecId =
  | "simple-local-storage"
  | "shared-platform-data"
  | "file-export"
  | "notification-reminder"
  | "integration-search-report"
  | "family-recipe-ai-shared"
  | "route-location-planner"
  | "board-calendar-planner";

export type GoldenRegressionSpec = {
  id: GoldenRegressionSpecId;
  label: string;
  purpose: string;
  expectedTier: AppSpec["capabilityTier"];
  expectedServices: string[];
  spec: AppSpec;
};

type GoldenSpecInput = Pick<
  AppSpec,
  | "appName"
  | "purpose"
  | "targetUsers"
  | "screens"
  | "features"
  | "dataToStore"
  | "needsLogin"
  | "sharingModel"
  | "capabilityTier"
  | "userRoles"
  | "dataEntities"
  | "workflows"
  | "permissionRules"
  | "acceptanceCriteria"
> &
  Partial<
    Pick<
      AppSpec,
      | "aiFeatures"
      | "testPlan"
      | "deploymentNotes"
      | "validationRules"
      | "searchRequirements"
      | "fileRequirements"
      | "integrations"
      | "notifications"
      | "reports"
      | "privacyRequirements"
      | "expectedDataVolume"
      | "offlineSupport"
      | "testScenarios"
      | "riskFlags"
    >
  >;

const baseUserRoles: AppSpec["userRoles"] = [
  {
    name: "Owner",
    description: "The person who created the app.",
    permissions: ["Can manage records and settings."],
  },
  {
    name: "Editor",
    description: "Trusted family member or helper.",
    permissions: ["Can add and update shared records."],
  },
  {
    name: "Viewer",
    description: "Read-only helper.",
    permissions: ["Can view shared records."],
  },
];

export const GOLDEN_REGRESSION_SPECS: GoldenRegressionSpec[] = [
  {
    id: "simple-local-storage",
    label: "Simple LocalStorage App",
    purpose: "Complete one-screen personal CRUD app that stays browser-only.",
    expectedTier: "personal",
    expectedServices: [],
    spec: makeSpec({
      appName: "My Quick List",
      purpose: "Maintain a small personal list entirely in the browser.",
      targetUsers: "One person",
      screens: [
        {
          name: "Quick List",
          description: "Add, edit, complete, delete, and filter list items.",
        },
      ],
      features: [
        "Add item",
        "Edit item name",
        "Mark complete or incomplete",
        "Delete item",
        "Filter All, Active, or Completed",
      ],
      dataToStore: ["List items with name and completed status"],
      needsLogin: false,
      sharingModel: "private",
      capabilityTier: "personal",
      userRoles: [],
      dataEntities: [
        {
          name: "List Item",
          description: "One personal list item.",
          ownership: "per_user",
          fields: [
            field("Name", "Name", "text", true),
            field("Completed", "Completed", "boolean", false),
          ],
          relationships: [],
        },
      ],
      workflows: [
        workflow("Add item", "User", "The user wants a new list item", [
          "Enter a required item name",
          "Choose Add item",
          "The app validates that the name is not blank",
          "The app creates the active item in localStorage",
          "See the new item in the list",
        ]),
        workflow("Edit item", "User", "The user wants to rename an item", [
          "Choose Edit for the existing item",
          "Enter a distinct updated item name",
          "Choose Save changes",
          "The app updates the item in localStorage",
          "See the updated name after refresh",
        ]),
        workflow("Change completion", "User", "The item status changes", [
          "Choose the item's completion checkbox",
          "The app updates the completed status in localStorage",
          "See the changed completion state after refresh",
        ]),
        workflow("Delete item", "User", "The user no longer needs an item", [
          "Choose Delete for the existing item",
          "The app removes the item from localStorage",
          "Confirm the deleted item remains absent after refresh",
        ]),
        {
          name: "Filter items",
          actor: "User",
          trigger: "The user wants to view all, active, or completed items.",
          steps: [
            "Choose the Active filter from All, Active, or Completed.",
            "Display only items matching that filter.",
          ],
          successOutcome: "Only list items matching the chosen filter are visible.",
          failureStates: [],
        },
      ],
      permissionRules: [],
      searchRequirements: [
        {
          target: "List Item",
          fields: ["Name"],
          filters: ["completed status"],
        },
      ],
      acceptanceCriteria: [
        criterion(
          "Save list item",
          "A user saves a list item",
          "The quick list is open",
          "The user enters a nonblank name and adds it",
          "The item appears in the list",
        ),
        criterion(
          "Edit list item",
          "A user renames an existing list item",
          "The item exists",
          "The user enters a distinct name and saves changes",
          "The changed name remains visible after refresh",
        ),
        criterion(
          "Change item completion",
          "A user changes an item's completed status",
          "The item exists",
          "The user changes the completion checkbox",
          "The changed state remains after refresh",
        ),
        criterion(
          "Delete list item",
          "A user deletes an existing list item",
          "The item exists",
          "The user chooses Delete",
          "The item remains absent after refresh",
        ),
        criterion(
          "Filter list items",
          "A user filters the quick list",
          "Active and completed items exist",
          "The user chooses All, Active, or Completed",
          "Only matching list items remain visible",
        ),
      ],
    }),
  },
  {
    id: "shared-platform-data",
    label: "Shared Platform Data App",
    purpose: "Shared chore app that must use platform data and sign-in.",
    expectedTier: "shared",
    expectedServices: ["data", "users"],
    spec: makeSpec({
      appName: "Family Chore Board",
      purpose: "Coordinate shared family chores with owner/editor/viewer roles.",
      targetUsers: "A family of five",
      screens: [
        { name: "Dashboard", description: "See chore status." },
        { name: "Chores", description: "Add and update chores." },
      ],
      features: ["Add chores", "Assign helper", "Mark complete"],
      dataToStore: ["Chores with assignee, due date, priority, and status"],
      needsLogin: true,
      sharingModel: "shared",
      capabilityTier: "shared",
      userRoles: baseUserRoles,
      dataEntities: [
        {
          name: "Chore",
          description: "A shared household chore.",
          ownership: "shared",
          fields: [
            field("Chore Title", "Chore title", "text", true),
            field("Assignee", "Assignee", "text", false),
            field("Due Date", "Due date", "date", false),
            field("Status", "Status", "select", true),
          ],
          relationships: [],
        },
      ],
      workflows: [
        workflow("Save chore", "Editor", "A chore needs tracking", [
          "Open Chores",
          "Enter chore details",
          "Save and see the chore on the shared board",
        ]),
      ],
      permissionRules: sharedPermissions("Chore"),
      searchRequirements: [
        {
          target: "Chore",
          fields: ["Chore Title", "Assignee", "Status"],
          filters: ["status", "due date", "assignee"],
        },
      ],
      acceptanceCriteria: [
        criterion(
          "Shared chore save",
          "An editor saves a chore",
          "The editor is signed in",
          "They save a chore",
          "The chore persists in platform data",
        ),
      ],
    }),
  },
  {
    id: "file-export",
    label: "File And Export App",
    purpose: "Shared document tracker with file attachments and PDF/CSV exports.",
    expectedTier: "advanced",
    expectedServices: ["data", "users", "files", "reports"],
    spec: makeSpec({
      appName: "Family Document Vault",
      purpose: "Store family documents, attachments, and export summaries.",
      targetUsers: "A family household",
      screens: [
        { name: "Vault", description: "Browse saved documents." },
        { name: "Document Detail", description: "View one document and files." },
        { name: "Exports", description: "Export CSV and PDF summaries." },
      ],
      features: ["Upload files", "Download files", "Export CSV", "Export PDF"],
      dataToStore: ["Documents with category, notes, and file references"],
      needsLogin: true,
      sharingModel: "shared",
      capabilityTier: "advanced",
      userRoles: baseUserRoles,
      dataEntities: [
        {
          name: "Document",
          description: "A saved family document.",
          ownership: "shared",
          fields: [
            field("Document Title", "Document title", "text", true),
            field("Category", "Category", "select", true),
            field("Notes", "Notes", "long_text", false),
          ],
          relationships: [],
        },
      ],
      workflows: [
        workflow("Upload document", "Editor", "A new file needs saving", [
          "Create a document record",
          "Upload an attachment",
          "See the file listed on the document",
        ]),
      ],
      permissionRules: sharedPermissions("Document"),
      fileRequirements: [
        {
          name: "Document attachment",
          attachedTo: "Document",
          acceptedTypes: ["application/pdf", "image/*", "text/plain"],
          maxSizeMb: 10,
          required: false,
        },
      ],
      reports: [
        {
          name: "Vault summary",
          description: "CSV and PDF summary of saved documents.",
          dataNeeded: ["Document Title", "Category", "Notes"],
          exportFormats: ["screen", "csv", "pdf"],
        },
      ],
      acceptanceCriteria: [
        criterion(
          "Export document summary",
          "A user exports a vault summary",
          "Documents exist",
          "The user clicks export PDF",
          "A valid PDF file is downloaded",
        ),
      ],
    }),
  },
  {
    id: "notification-reminder",
    label: "Notification Reminder App",
    purpose: "Reminder app using platform notifications and scheduled jobs.",
    expectedTier: "advanced",
    expectedServices: ["data", "users", "email", "jobs"],
    spec: makeSpec({
      appName: "Family Reminder Center",
      purpose: "Schedule and send household reminders.",
      targetUsers: "A family household",
      screens: [
        { name: "Reminders", description: "Create and review reminders." },
        { name: "Inbox", description: "View in-app notifications." },
      ],
      features: ["Create reminder", "Send notification", "Schedule reminder"],
      dataToStore: ["Reminders with due date, status, and recipient group"],
      needsLogin: true,
      sharingModel: "shared",
      capabilityTier: "advanced",
      userRoles: baseUserRoles,
      dataEntities: [
        {
          name: "Reminder",
          description: "A household reminder.",
          ownership: "shared",
          fields: [
            field("Reminder Title", "Reminder title", "text", true),
            field("Due At", "Due at", "datetime", true),
            field("Recipient Group", "Recipient group", "select", true),
            field("Status", "Status", "select", true),
          ],
          relationships: [],
        },
      ],
      workflows: [
        workflow("Schedule reminder", "Editor", "A household reminder is needed", [
          "Enter reminder details",
          "Choose recipient group",
          "Schedule the reminder",
        ]),
      ],
      permissionRules: sharedPermissions("Reminder"),
      notifications: [
        {
          name: "Reminder due",
          trigger: "Reminder due time is approaching",
          recipients: ["owner", "editors", "members"],
          channel: "both",
        },
      ],
      acceptanceCriteria: [
        criterion(
          "Send reminder",
          "An editor sends a reminder",
          "A reminder exists",
          "The editor sends notification",
          "The notification is queued through VoiceForge",
        ),
      ],
    }),
  },
  {
    id: "integration-search-report",
    label: "Integration Search Report App",
    purpose: "Approved integration app with search, saved filters, reports, and export.",
    expectedTier: "advanced",
    expectedServices: ["data", "users", "integrations", "search", "reports"],
    spec: makeSpec({
      appName: "Follow Up Hub",
      purpose: "Track follow-ups from the approved demo directory integration.",
      targetUsers: "A family coordinator and helpers",
      screens: [
        { name: "Dashboard", description: "See open follow-ups and reports." },
        { name: "Contacts", description: "Search imported demo contacts." },
        { name: "Reports", description: "Run saved filters and exports." },
      ],
      features: ["Search contacts", "Save follow-up", "Run report", "Export CSV"],
      dataToStore: ["Follow-ups linked to demo contacts"],
      needsLogin: true,
      sharingModel: "shared",
      capabilityTier: "advanced",
      userRoles: baseUserRoles,
      dataEntities: [
        {
          name: "Follow Up",
          description: "A follow-up task linked to an external contact.",
          ownership: "shared",
          fields: [
            field("Contact Name", "Contact name", "text", true),
            field("Next Step", "Next step", "long_text", true),
            field("Due Date", "Due date", "date", false),
            field("Status", "Status", "select", true),
          ],
          relationships: [],
        },
      ],
      workflows: [
        workflow("Create follow-up", "Editor", "A demo contact needs follow-up", [
          "Search demo contacts",
          "Select a contact",
          "Save a follow-up task",
        ]),
      ],
      permissionRules: sharedPermissions("Follow Up"),
      searchRequirements: [
        {
          target: "Follow Up",
          fields: ["Contact Name", "Next Step", "Status"],
          filters: ["status", "due date", "contact"],
        },
      ],
      integrations: [
        {
          name: "Demo Directory",
          purpose: "Search sample external contacts for follow-ups.",
          direction: "import",
          requiredForLaunch: true,
        },
      ],
      reports: [
        {
          name: "Open follow-ups",
          description: "Summarize open follow-ups by status and due date.",
          dataNeeded: ["Contact Name", "Status", "Due Date"],
          exportFormats: ["screen", "csv"],
        },
      ],
      acceptanceCriteria: [
        criterion(
          "Search and save contact follow-up",
          "An editor searches the approved demo directory",
          "The editor is signed in",
          "They search contacts and save a follow-up",
          "The saved follow-up appears in search and reports",
        ),
      ],
    }),
  },
  {
    id: "family-recipe-ai-shared",
    label: "Family Recipe AI Shared App",
    purpose: "Regression app for AI recipe parsing, creator ownership, suggestions, history, files, and search.",
    expectedTier: "advanced",
    expectedServices: ["ai", "data", "users", "files", "search"],
    spec: makeSpec({
      appName: "Family Recipe Library",
      purpose: "Share searchable family recipes while only creators edit their recipes and relatives submit suggestions.",
      targetUsers: "Invited family and friends",
      screens: [
        { name: "Recipes", description: "Search and browse family recipes." },
        { name: "Add Recipe", description: "Create, scan, or generate a recipe." },
        { name: "Recipe Details", description: "View nutrition, history, and suggestions." },
      ],
      features: ["Generate recipe with AI", "Read recipe photos", "Search recipes", "Suggest a change", "View recipe history"],
      dataToStore: ["recipes, ingredients, suggestions, history, nutrition, and photo references"],
      needsLogin: true,
      sharingModel: "shared",
      capabilityTier: "advanced",
      userRoles: baseUserRoles,
      aiFeatures: ["Extract recipes from photos", "Generate recipes", "Estimate nutrition"],
      dataEntities: [
        {
          name: "Recipe",
          description: "A family recipe owned by its creator.",
          ownership: "shared",
          fields: [
            field("Title", "Title", "text", true),
            field("Creator ID", "Creator", "text", true),
            field("Ingredients", "Ingredients", "json", true),
            field("Instructions", "Instructions", "json", true),
            field("Nutrition", "Nutrition", "json", false),
            field("Photo File IDs", "Photos", "json", false),
          ],
          relationships: [],
        },
        {
          name: "Recipe Suggestion",
          description: "A suggestion submitted to a recipe creator.",
          ownership: "shared",
          fields: [field("Suggestion", "Suggestion", "long_text", true)],
          relationships: [{ type: "belongs_to", targetEntity: "Recipe", description: "Suggestion for one recipe." }],
        },
        {
          name: "Recipe History",
          description: "Append-only audit history for recipe changes.",
          ownership: "shared",
          fields: [field("Summary", "Summary", "text", true)],
          relationships: [{ type: "belongs_to", targetEntity: "Recipe", description: "History for one recipe." }],
        },
      ],
      workflows: [
        workflow("Create recipe", "Editor", "A family member wants to share a recipe", ["Open Add Recipe", "Enter or generate recipe fields", "Save recipe"]),
        workflow("Suggest recipe change", "Viewer", "A relative has an improvement", ["Open recipe details", "Enter a suggestion", "Send suggestion to creator"]),
        workflow("Review recipe history", "Viewer", "A relative wants to see prior changes", ["Open recipe details", "View recipe history"]),
      ],
      permissionRules: [
        { role: "Owner", entity: "Recipe", actions: ["create", "read", "update", "delete"], condition: "Only the record creator may update or delete their recipe." },
        { role: "Editor", entity: "Recipe", actions: ["create", "read", "update", "delete"], condition: "Only the record creator may update or delete their recipe." },
        { role: "Viewer", entity: "Recipe", actions: ["read"], condition: "All members may read recipes." },
        ...sharedPermissions("Recipe Suggestion"),
        { role: "Owner", entity: "Recipe History", actions: ["create", "read"], condition: "History is append-only." },
        { role: "Editor", entity: "Recipe History", actions: ["create", "read"], condition: "History is append-only." },
        { role: "Viewer", entity: "Recipe History", actions: ["read"], condition: "History is visible to members." },
      ],
      searchRequirements: [{ target: "Recipe", fields: ["Title", "Creator ID", "Ingredients"], filters: ["creator"] }],
      fileRequirements: [{ name: "Recipe photos", attachedTo: "Recipe", acceptedTypes: ["image/jpeg", "image/png", "image/heic", "image/tiff"], maxSizeMb: 10, required: false }],
      acceptanceCriteria: [
        criterion("Create AI recipe", "A creator generates and saves a recipe", "The creator is signed in", "They generate a recipe and save normalized fields", "The recipe remains visible after refresh"),
        criterion("Submit suggestion", "A non-creator suggests a change", "A recipe exists", "They submit a suggestion", "The creator can see the saved suggestion"),
      ],
    }),
  },
  {
    id: "route-location-planner",
    label: "Route And Location Planner",
    purpose: "Generic regression app for maps, durable route handoff, GPS tracking, files, and exports.",
    expectedTier: "advanced",
    expectedServices: ["data", "users", "files", "integrations", "device_location", "reports"],
    spec: makeSpec({
      appName: "Outdoor Route Planner",
      purpose: "Plan dated outdoor routes with Google Maps, save one route, track device location against it, attach photos, and export the result.",
      targetUsers: "A signed-in planning group",
      screens: [
        { name: "Plan", description: "Create a dated itinerary." },
        { name: "Routes", description: "Calculate route alternatives, distance, and elevation." },
        { name: "Track", description: "Select a saved route and record device location points." },
        { name: "Export", description: "Download GPX, CSV, or PDF route summaries." },
      ],
      features: ["Calculate Google Maps route alternatives", "Save a selected route", "Track GPS location", "Upload route photos", "Export GPX CSV and PDF"],
      dataToStore: ["Dated itineraries, selected route alternatives, GPS track points, and photo file references"],
      needsLogin: true,
      sharingModel: "shared",
      capabilityTier: "advanced",
      userRoles: baseUserRoles,
      dataEntities: [
        {
          name: "Itinerary",
          description: "A dated shared plan.",
          ownership: "shared",
          fields: [field("Title", "Title", "text", true), field("Trip Date", "Trip date", "date", true)],
          relationships: [],
        },
        {
          name: "Route Option",
          description: "A calculated route selected for one itinerary.",
          ownership: "shared",
          fields: [
            field("Itinerary ID", "Itinerary", "relation", true),
            field("Route Name", "Route name", "text", true),
            field("Distance Metres", "Distance", "number", true),
            field("Elevation Gain Metres", "Elevation gain", "number", false),
            field("Encoded Path", "Encoded path", "long_text", true),
          ],
          relationships: [{ type: "belongs_to", targetEntity: "Itinerary", description: "Route belongs to one itinerary." }],
        },
        {
          name: "Track Point",
          description: "One GPS point saved against a selected route.",
          ownership: "shared",
          fields: [
            field("Route Option ID", "Route option", "relation", true),
            field("Latitude", "Latitude", "number", true),
            field("Longitude", "Longitude", "number", true),
            field("Recorded At", "Recorded at", "datetime", true),
          ],
          relationships: [{ type: "belongs_to", targetEntity: "Route Option", description: "Track point belongs to one saved route." }],
        },
      ],
      workflows: [
        workflow("Create itinerary", "Editor", "A dated plan is needed", ["Open Plan", "Enter a title and date", "Save the itinerary"]),
        workflow("Calculate and save route", "Editor", "An itinerary needs a route", ["Open Routes", "Choose origin and destination", "Calculate alternatives", "Save one route option"]),
        workflow("Track saved route", "Editor", "A saved route is ready to follow", ["Open Track", "Select the saved route", "Start GPS tracking", "Save a track point"]),
        workflow("Export tracked route", "Viewer", "A route summary is needed", ["Open Export", "Select a saved route", "Download GPX or PDF"]),
      ],
      permissionRules: [
        ...sharedPermissions("Itinerary"),
        ...sharedPermissions("Route Option"),
        ...sharedPermissions("Track Point"),
      ],
      fileRequirements: [{ name: "Route photos", attachedTo: "Itinerary", acceptedTypes: ["image/jpeg", "image/png"], maxSizeMb: 10, required: false }],
      integrations: [{ name: "Google Maps", purpose: "Find places, calculate route alternatives, and retrieve elevation profiles.", direction: "import", requiredForLaunch: true }],
      reports: [{ name: "Route summary", description: "Summarize the selected route and GPS track.", dataNeeded: ["Route Name", "Distance Metres", "Elevation Gain Metres", "Track Point"], exportFormats: ["screen", "csv", "pdf"] }],
      acceptanceCriteria: [
        criterion("Saved route reaches tracking", "An editor calculates and selects a route", "A dated itinerary exists", "They save a route and open Track", "The saved route appears in Route to Track and accepts a GPS point"),
        criterion("Export tracked route", "A member exports a route", "A route and track point exist", "They download the route summary", "A valid route export is downloaded"),
      ],
    }),
  },
  {
    id: "board-calendar-planner",
    label: "Board And Calendar Planner",
    purpose: "Generic regression app for drag-and-drop persistence, search, dates, and cross-screen handoff.",
    expectedTier: "shared",
    expectedServices: ["data", "users", "search"],
    spec: makeSpec({
      appName: "Shared Planning Board",
      purpose: "Create shared dated work items, move them between board columns, and confirm the saved status on a calendar.",
      targetUsers: "A small signed-in group",
      screens: [
        { name: "Items", description: "Create, edit, search, filter, and sort work items." },
        { name: "Board", description: "Move work items between status columns." },
        { name: "Calendar", description: "View saved work items by date and status." },
      ],
      features: ["Create work item", "Search and filter items", "Drag and drop status", "View dated calendar"],
      dataToStore: ["Shared work items with title, due date, status, and board order"],
      needsLogin: true,
      sharingModel: "shared",
      capabilityTier: "shared",
      userRoles: baseUserRoles,
      dataEntities: [
        {
          name: "Work Item",
          description: "A dated item shown in lists, board columns, and calendar.",
          ownership: "shared",
          fields: [
            field("Title", "Title", "text", true),
            field("Due Date", "Due date", "date", true),
            field("Status", "Status", "select", true),
            field("Board Order", "Board order", "number", true),
          ],
          relationships: [],
        },
      ],
      workflows: [
        workflow("Create work item", "Editor", "A new item needs planning", ["Open Items", "Enter title and due date", "Save the work item"]),
        workflow("Move work item", "Editor", "An item changes status", ["Open Board", "Drag the item to another status column", "Save the new status and order"]),
        workflow("Find item on calendar", "Viewer", "A member needs the dated plan", ["Open Calendar", "Choose the saved date", "See the item with its current status"]),
      ],
      permissionRules: sharedPermissions("Work Item"),
      searchRequirements: [{ target: "Work Item", fields: ["Title", "Status"], filters: ["due date", "status", "sort by due date or board order"] }],
      acceptanceCriteria: [
        criterion("Persist board move", "An editor moves an item", "A dated work item exists", "They drag it to Done and reload", "The item remains in Done and the calendar shows the saved status"),
      ],
    }),
  },
];

function makeSpec(input: GoldenSpecInput): AppSpec {
  return normalizeAppSpec({
    appName: input.appName,
    purpose: input.purpose,
    targetUsers: input.targetUsers,
    screens: input.screens,
    features: input.features,
    dataToStore: input.dataToStore,
    needsLogin: input.needsLogin,
    sharingModel: input.sharingModel,
    aiFeatures: input.aiFeatures ?? [],
    testPlan:
      input.testPlan ?? input.acceptanceCriteria.map((item) => item.name),
    deploymentNotes: input.deploymentNotes ?? "",
    capabilityTier: input.capabilityTier,
    userRoles: input.userRoles,
    dataEntities: input.dataEntities,
    workflows: input.workflows,
    permissionRules: input.permissionRules,
    validationRules:
      input.validationRules ?? ["Required fields must be validated before saving."],
    searchRequirements: input.searchRequirements ?? [],
    fileRequirements: input.fileRequirements ?? [],
    integrations: input.integrations ?? [],
    notifications: input.notifications ?? [],
    reports: input.reports ?? [],
    privacyRequirements:
      input.privacyRequirements ?? [
        input.needsLogin
          ? "Only signed-in VoiceForge app members should access shared data."
          : "Personal data stays in the browser.",
      ],
    expectedDataVolume: input.expectedDataVolume ?? "small",
    offlineSupport:
      input.offlineSupport ?? (input.needsLogin ? "none" : "basic"),
    acceptanceCriteria: input.acceptanceCriteria,
    testScenarios:
      input.testScenarios ??
      input.acceptanceCriteria.map((criterion) => ({
        name: criterion.name,
        type: "workflow",
        steps: [criterion.given, criterion.when],
        expectedResult: criterion.then,
      })),
    riskFlags: input.riskFlags ?? [],
  });
}

function field(
  name: string,
  label: string,
  type: AppSpec["dataEntities"][number]["fields"][number]["type"],
  required: boolean,
): AppSpec["dataEntities"][number]["fields"][number] {
  return { name, label, type, required, validation: "" };
}

function workflow(
  name: string,
  actor: string,
  trigger: string,
  steps: string[],
): AppSpec["workflows"][number] {
  return {
    name,
    actor,
    trigger,
    steps,
    successOutcome: "The workflow completes and the saved data is visible.",
    failureStates: ["Validation error", "Save error"],
  };
}

function criterion(
  name: string,
  scenario: string,
  given: string,
  when: string,
  then: string,
): AppSpec["acceptanceCriteria"][number] {
  return { name, scenario, given, when, then };
}

function sharedPermissions(entity: string): AppSpec["permissionRules"] {
  return [
    {
      role: "Owner",
      entity,
      actions: ["create", "read", "update", "delete", "admin"],
      condition: "Owner can manage shared records.",
    },
    {
      role: "Editor",
      entity,
      actions: ["create", "read", "update"],
      condition: "Editor can maintain shared records.",
    },
    {
      role: "Viewer",
      entity,
      actions: ["read"],
      condition: "Viewer can only read records.",
    },
  ];
}
