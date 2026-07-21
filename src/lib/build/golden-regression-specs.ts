import { normalizeAppSpec, type AppSpec } from "../spec";

export type GoldenRegressionSpecId =
  | "simple-local-storage"
  | "shared-platform-data"
  | "file-export"
  | "notification-reminder"
  | "integration-search-report";

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
    purpose: "Personal checklist app that should stay browser-only.",
    expectedTier: "personal",
    expectedServices: [],
    spec: makeSpec({
      appName: "Packing Checklist",
      purpose: "Track a personal packing checklist before a short trip.",
      targetUsers: "One person",
      screens: [
        { name: "Checklist", description: "Add and complete packing items." },
      ],
      features: ["Add item", "Mark packed", "Filter unpacked"],
      dataToStore: ["Packing items with packed status"],
      needsLogin: false,
      sharingModel: "private",
      capabilityTier: "personal",
      userRoles: [],
      dataEntities: [
        {
          name: "Packing Item",
          description: "One item to pack.",
          ownership: "per_user",
          fields: [
            field("Item Name", "Item name", "text", true),
            field("Packed", "Packed", "boolean", false),
          ],
          relationships: [],
        },
      ],
      workflows: [
        workflow("Add item", "Traveler", "An item needs to be packed", [
          "Enter an item name",
          "Save the item",
          "See it in the unpacked list",
        ]),
      ],
      permissionRules: [],
      searchRequirements: [
        {
          target: "Packing Item",
          fields: ["Item Name"],
          filters: ["packed status"],
        },
      ],
      acceptanceCriteria: [
        criterion(
          "Save packing item",
          "A traveler saves a checklist item",
          "The checklist is open",
          "The traveler enters an item and saves",
          "The item appears in the list",
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
