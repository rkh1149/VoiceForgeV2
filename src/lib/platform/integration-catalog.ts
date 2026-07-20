import { z } from "zod";
import { PlatformDataError, type JsonObject } from "./data";
import { googleMapsProvider } from "./google-maps-provider";

export type IntegrationAuthType = "none" | "api_key" | "oauth2";
export type IntegrationRequiredRole = "viewer" | "editor" | "owner";

export type IntegrationActionDefinition = {
  actionKey: string;
  displayName: string;
  description: string;
  requiredRole: IntegrationRequiredRole;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
  invoke: (input: JsonObject, context: IntegrationInvokeContext) => Promise<JsonObject>;
};

export type IntegrationProviderDefinition = {
  providerKey: string;
  displayName: string;
  description: string;
  authType: IntegrationAuthType;
  credentialSchema: z.ZodType<unknown> | null;
  aliases: string[];
  actions: IntegrationActionDefinition[];
};

export type IntegrationInvokeContext = {
  appId: string;
  userId: string;
  credential?: {
    id?: string;
    scopes: string[];
    secrets: JsonObject;
  };
};

export type PublicIntegrationProvider = {
  providerKey: string;
  displayName: string;
  description: string;
  authType: IntegrationAuthType;
  actions: Array<{
    actionKey: string;
    displayName: string;
    description: string;
    requiredRole: IntegrationRequiredRole;
  }>;
};

const demoContacts = [
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
] as const;

const listContactsInputSchema = z
  .object({
    query: z.string().trim().max(80).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const contactSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    company: z.string(),
    role: z.string(),
  })
  .strict();

const listContactsOutputSchema = z
  .object({
    provider: z.literal("demo_directory"),
    contacts: z.array(contactSchema),
  })
  .strict();

const lookupContactInputSchema = z
  .object({
    contactId: z.string().min(1).max(80),
  })
  .strict();

const lookupContactOutputSchema = z
  .object({
    provider: z.literal("demo_directory"),
    contact: contactSchema,
  })
  .strict();

const noteInputSchema = z
  .object({
    contactId: z.string().min(1).max(80),
    note: z.string().min(1).max(1000),
  })
  .strict();

const noteOutputSchema = z
  .object({
    provider: z.literal("demo_directory"),
    saved: z.boolean(),
    contactId: z.string(),
    notePreview: z.string(),
  })
  .strict();

const demoDirectoryProvider: IntegrationProviderDefinition = {
  providerKey: "demo_directory",
  displayName: "Demo Directory",
  description:
    "Safe sample contacts for testing VoiceForge's locked integration flow without third-party credentials.",
  authType: "none",
  credentialSchema: null,
  aliases: [
    "demo directory",
    "voiceforge demo directory",
    "sample contacts",
    "demo contacts",
    "external demo contacts",
    "sample external directory",
  ],
  actions: [
    {
      actionKey: "list_contacts",
      displayName: "List contacts",
      description: "Search sample external contacts by name, email, company, or role.",
      requiredRole: "viewer",
      inputSchema: listContactsInputSchema,
      outputSchema: listContactsOutputSchema,
      invoke: async (input) => {
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
        return { provider: "demo_directory", contacts };
      },
    },
    {
      actionKey: "lookup_contact",
      displayName: "Lookup contact",
      description: "Retrieve one sample external contact by ID.",
      requiredRole: "viewer",
      inputSchema: lookupContactInputSchema,
      outputSchema: lookupContactOutputSchema,
      invoke: async (input) => {
        const contactId = String(input.contactId);
        const contact = demoContacts.find((item) => item.id === contactId);
        if (!contact) {
          throw new PlatformDataError(
            404,
            "integration_record_not_found",
            "The integration record was not found.",
          );
        }
        return { provider: "demo_directory", contact };
      },
    },
    {
      actionKey: "record_contact_note",
      displayName: "Record contact note",
      description: "Pretend to write a note back to the sample external system.",
      requiredRole: "editor",
      inputSchema: noteInputSchema,
      outputSchema: noteOutputSchema,
      invoke: async (input) => {
        const contactId = String(input.contactId);
        const contact = demoContacts.find((item) => item.id === contactId);
        if (!contact) {
          throw new PlatformDataError(
            404,
            "integration_record_not_found",
            "The integration record was not found.",
          );
        }
        const note = String(input.note).trim();
        return {
          provider: "demo_directory",
          saved: true,
          contactId,
          notePreview: note.slice(0, 120),
        };
      },
    },
  ],
};

export const INTEGRATION_CATALOG = [
  demoDirectoryProvider,
  googleMapsProvider,
] as const;

export function listPublicIntegrationProviders(): PublicIntegrationProvider[] {
  return INTEGRATION_CATALOG.map(publicProvider);
}

export function getIntegrationProvider(
  providerKey: string,
): IntegrationProviderDefinition | null {
  const normalized = normalizeIntegrationKey(providerKey);
  return (
    INTEGRATION_CATALOG.find(
      (provider) => normalizeIntegrationKey(provider.providerKey) === normalized,
    ) ?? null
  );
}

export function getIntegrationAction(
  providerKey: string,
  actionKey: string,
): {
  provider: IntegrationProviderDefinition;
  action: IntegrationActionDefinition;
} | null {
  const provider = getIntegrationProvider(providerKey);
  if (!provider) return null;
  const normalizedAction = normalizeIntegrationKey(actionKey);
  const action =
    provider.actions.find(
      (item) => normalizeIntegrationKey(item.actionKey) === normalizedAction,
    ) ?? null;
  return action ? { provider, action } : null;
}

export function resolveIntegrationProviderKey(text: string): string | null {
  const normalizedText = normalizeIntegrationKey(text);
  if (!normalizedText) return null;
  for (const provider of INTEGRATION_CATALOG) {
    const keys = [provider.providerKey, provider.displayName, ...provider.aliases];
    if (
      keys.some((key) => {
        const normalizedKey = normalizeIntegrationKey(key);
        return (
          normalizedText === normalizedKey ||
          normalizedText.includes(normalizedKey)
        );
      })
    ) {
      return provider.providerKey;
    }
  }
  return null;
}

export function isApprovedIntegrationRequirement(input: {
  name: string;
  purpose: string;
}): boolean {
  return (
    resolveIntegrationProviderKey(`${input.name} ${input.purpose}`) !== null
  );
}

export async function invokeCatalogIntegrationAction(input: {
  providerKey: string;
  actionKey: string;
  input: unknown;
  context: IntegrationInvokeContext;
}): Promise<JsonObject> {
  const match = getIntegrationAction(input.providerKey, input.actionKey);
  if (!match) {
    throw new PlatformDataError(
      404,
      "integration_action_not_found",
      "That integration provider or action is not approved in VoiceForge V2.",
    );
  }
  const parsedInput = match.action.inputSchema.safeParse(input.input ?? {});
  if (!parsedInput.success) throw parsedInput.error;
  const result = await match.action.invoke(parsedInput.data as JsonObject, input.context);
  const parsedOutput = match.action.outputSchema.safeParse(result);
  if (!parsedOutput.success) {
    throw new PlatformDataError(
      502,
      "invalid_integration_response",
      "The integration returned an unexpected response.",
      parsedOutput.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsedOutput.data as JsonObject;
}

export function normalizeIntegrationKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function publicProvider(
  provider: IntegrationProviderDefinition,
): PublicIntegrationProvider {
  return {
    providerKey: provider.providerKey,
    displayName: provider.displayName,
    description: provider.description,
    authType: provider.authType,
    actions: provider.actions.map((action) => ({
      actionKey: action.actionKey,
      displayName: action.displayName,
      description: action.description,
      requiredRole: action.requiredRole,
    })),
  };
}
