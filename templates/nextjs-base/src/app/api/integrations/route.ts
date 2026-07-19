import { NextResponse } from "next/server";

/**
 * LOCKED PLATFORM FILE — managed by VoiceForge. Do not modify.
 *
 * Browser code in generated apps calls this same-origin route. This route
 * adds the server-only VoiceForge app token and forwards approved integration
 * requests to VoiceForge V2. Tokens and provider credentials are never sent
 * to the browser.
 */

type IntegrationAction = "listProviders" | "invoke";

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

const ACTIONS = new Set<IntegrationAction>(["listProviders", "invoke"]);

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
      return NextResponse.json({ providers: [demoProvider] });
    case "invoke":
      return invokeLocalIntegration(body);
  }
}

function invokeLocalIntegration(body: IntegrationBody) {
  if (body.providerKey !== "demo_directory") {
    return localPlatformError(
      404,
      "integration_provider_not_found",
      "That integration provider is not approved in VoiceForge V2.",
    );
  }
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
