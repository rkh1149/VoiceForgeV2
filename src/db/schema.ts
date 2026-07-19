import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", ["admin", "user"]);

export const appStatus = pgEnum("app_status", [
  "draft", // idea captured, spec not approved
  "spec_approved", // user approved the build plan
  "building",
  "testing",
  "deployed",
  "failed",
  "archived",
]);

export const conversationChannel = pgEnum("conversation_channel", [
  "text",
  "voice",
]);

export const approvalType = pgEnum("approval_type", [
  "build", // approve building a new app
  "change", // approve a change to an existing app
  "deploy_production", // approve promoting preview to production
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
]);

export const buildRunStatus = pgEnum("build_run_status", [
  "queued",
  "generating",
  "testing",
  "debugging",
  "deploying",
  "awaiting_user_test",
  "complete",
  "failed",
  "needs_input",
]);

export const deploymentEnvironment = pgEnum("deployment_environment", [
  "preview",
  "production",
]);

export const deploymentStatus = pgEnum("deployment_status", [
  "queued",
  "building",
  "ready",
  "error",
  "canceled",
]);

export const testSuite = pgEnum("test_suite", [
  "typecheck",
  "lint",
  "unit",
  "component",
  "e2e",
  "accessibility",
  "security",
  "build",
  "smoke",
]);

export const testStatus = pgEnum("test_status", [
  "passed",
  "failed",
  "skipped",
]);

export const changeRequestStatus = pgEnum("change_request_status", [
  "intake",
  "clarifying",
  "awaiting_approval",
  "building",
  "complete",
  "rejected",
  "failed",
]);

export const appMembershipRole = pgEnum("app_membership_role", [
  "owner",
  "editor",
  "viewer",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Auth accounts. Identity comes from Clerk; this row adds app-level data. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: userRole("role").notNull().default("user"),
    monthlyBuildLimit: integer("monthly_build_limit").notNull().default(10),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_clerk_user_id_idx").on(t.clerkUserId)],
);

/** Generated apps: one row per app a user has created (or is creating). */
export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: appStatus("status").notNull().default("draft"),
    githubRepoUrl: text("github_repo_url"),
    vercelProjectId: text("vercel_project_id"),
    previewUrl: text("preview_url"),
    productionUrl: text("production_url"),
    // AI-enabled generated apps (Stage 7)
    aiToken: text("ai_token"), // secret the app uses to report/gate AI usage
    platformToken: text("platform_token"), // secret generated apps use for platform services
    aiDailyRequestLimit: integer("ai_daily_request_limit").notNull().default(50),
    aiDailyImageLimit: integer("ai_daily_image_limit").notNull().default(10),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("apps_owner_slug_idx").on(t.ownerId, t.slug),
    uniqueIndex("apps_platform_token_idx").on(t.platformToken),
    index("apps_owner_idx").on(t.ownerId),
  ],
);

/** Voice/text transcript for each app creation or change session. */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").references(() => apps.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    channel: conversationChannel("channel").notNull().default("text"),
    transcript: jsonb("transcript").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("conversations_app_idx").on(t.appId)],
);

/** Versioned structured app specs produced by the Product Spec agent. */
export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer("version").notNull().default(1),
    spec: jsonb("spec").notNull(), // structured requirements
    plainSummary: text("plain_summary"), // plain-English build summary shown to user
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("requirements_app_version_idx").on(t.appId, t.version)],
);

/** What the user approved, and when. Nothing builds without one. */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    requirementId: uuid("requirement_id").references(() => requirements.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    type: approvalType("type").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("approvals_app_idx").on(t.appId)],
);

/** Code generation jobs: durable state machine for the build pipeline. */
export const buildRuns = pgTable(
  "build_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    requirementId: uuid("requirement_id").references(() => requirements.id),
    approvalId: uuid("approval_id").references(() => approvals.id),
    status: buildRunStatus("status").notNull().default("queued"),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    logs: jsonb("logs").notNull().default([]),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("build_runs_app_idx").on(t.appId),
    index("build_runs_status_idx").on(t.status),
  ],
);

/** Stored architecture output for a build before code generation starts. */
export const architecturePlans = pgTable(
  "architecture_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id),
    buildRunId: uuid("build_run_id")
      .notNull()
      .references(() => buildRuns.id),
    capabilityTier: text("capability_tier").notNull(),
    complexityScore: integer("complexity_score").notNull().default(0),
    canBuildNow: boolean("can_build_now").notNull().default(true),
    summary: text("summary").notNull(),
    plan: jsonb("plan").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("architecture_plans_build_run_idx").on(t.buildRunId),
    index("architecture_plans_app_idx").on(t.appId),
  ],
);

/** Preview/production deployments and their URLs. */
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    buildRunId: uuid("build_run_id").references(() => buildRuns.id),
    environment: deploymentEnvironment("environment").notNull(),
    vercelDeploymentId: text("vercel_deployment_id"),
    url: text("url"),
    status: deploymentStatus("status").notNull().default("queued"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("deployments_app_idx").on(t.appId)],
);

/** Results of every test suite run inside a build. */
export const testResults = pgTable(
  "test_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    buildRunId: uuid("build_run_id")
      .notNull()
      .references(() => buildRuns.id),
    suite: testSuite("suite").notNull(),
    status: testStatus("status").notNull(),
    summary: text("summary"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("test_results_build_run_idx").on(t.buildRunId)],
);

/** "Change my recipe app to add printing" — future modifications by app. */
export const changeRequests = pgTable(
  "change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    description: text("description").notNull(),
    forceDeepDiagnostic: boolean("force_deep_diagnostic")
      .notNull()
      .default(false),
    status: changeRequestStatus("status").notNull().default("intake"),
    requirementId: uuid("requirement_id").references(() => requirements.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("change_requests_app_idx").on(t.appId)],
);

/** Platform-managed entity metadata for generated app records. */
export const appEntitySchemas = pgTable(
  "app_entity_schemas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    entityKey: text("entity_key").notNull(),
    displayName: text("display_name").notNull(),
    definition: jsonb("definition").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("app_entity_schemas_app_key_idx").on(t.appId, t.entityKey),
    index("app_entity_schemas_app_idx").on(t.appId),
  ],
);

/** People invited to a generated app and their server-enforced role. */
export const appMemberships = pgTable(
  "app_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: appMembershipRole("role").notNull().default("viewer"),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("app_memberships_app_user_idx").on(t.appId, t.userId),
    index("app_memberships_app_idx").on(t.appId),
    index("app_memberships_user_idx").on(t.userId),
  ],
);

/** JSONB records stored by the VoiceForge platform on behalf of apps. */
export const appRecords = pgTable(
  "app_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    entityKey: text("entity_key").notNull(),
    ownerId: uuid("owner_id").references(() => users.id),
    data: jsonb("data").notNull(),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("app_records_app_entity_idx").on(t.appId, t.entityKey),
    index("app_records_app_owner_idx").on(t.appId, t.ownerId),
    index("app_records_deleted_idx").on(t.deletedAt),
  ],
);

/** Append-only record snapshots for rollback/debug/history. */
export const appRecordVersions = pgTable(
  "app_record_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => appRecords.id),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer("version").notNull(),
    data: jsonb("data").notNull(),
    changedBy: uuid("changed_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("app_record_versions_record_idx").on(t.recordId),
    index("app_record_versions_app_idx").on(t.appId),
  ],
);

/** Per-app data activity log for record and membership operations. */
export const appRecordEvents = pgTable(
  "app_record_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    recordId: uuid("record_id").references(() => appRecords.id),
    userId: uuid("user_id").references(() => users.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("app_record_events_app_idx").on(t.appId),
    index("app_record_events_record_idx").on(t.recordId),
    index("app_record_events_user_idx").on(t.userId),
  ],
);

/** Per-entity search/report metadata selected from the app architecture. */
export const appRecordSearchConfigs = pgTable(
  "app_record_search_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    entityKey: text("entity_key").notNull(),
    indexedFields: jsonb("indexed_fields").notNull().default([]),
    defaultSort: jsonb("default_sort").notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("app_record_search_configs_app_entity_idx").on(
      t.appId,
      t.entityKey,
    ),
    index("app_record_search_configs_app_idx").on(t.appId),
  ],
);

/** Saved query/filter definitions for generated app record views. */
export const appSavedRecordFilters = pgTable(
  "app_saved_record_filters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    entityKey: text("entity_key").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").notNull(),
    visibility: text("visibility").notNull().default("app"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("app_saved_record_filters_app_entity_name_idx").on(
      t.appId,
      t.entityKey,
      t.name,
    ),
    index("app_saved_record_filters_app_idx").on(t.appId),
    index("app_saved_record_filters_entity_idx").on(t.appId, t.entityKey),
  ],
);

/** Platform-managed files and attachments owned by generated apps. */
export const appFiles = pgTable(
  "app_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    recordId: uuid("record_id").references(() => appRecords.id),
    ownerId: uuid("owner_id").references(() => users.id),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageProvider: text("storage_provider").notNull().default("neon"),
    storageKey: text("storage_key").notNull(),
    dataBase64: text("data_base64").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("app_files_app_idx").on(t.appId),
    index("app_files_record_idx").on(t.recordId),
    index("app_files_owner_idx").on(t.ownerId),
    index("app_files_deleted_idx").on(t.deletedAt),
  ],
);

/** Per-user notification preferences for generated apps. */
export const appNotificationPreferences = pgTable(
  "app_notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    emailEnabled: boolean("email_enabled").notNull().default(true),
    inAppEnabled: boolean("in_app_enabled").notNull().default(true),
    digestEnabled: boolean("digest_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("app_notification_preferences_app_user_idx").on(t.appId, t.userId),
    index("app_notification_preferences_app_idx").on(t.appId),
  ],
);

/** Notification outbox for in-app and email messages requested by apps. */
export const appNotifications = pgTable(
  "app_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    recordId: uuid("record_id").references(() => appRecords.id),
    senderUserId: uuid("sender_user_id").references(() => users.id),
    recipientUserId: uuid("recipient_user_id").references(() => users.id),
    recipientEmail: text("recipient_email"),
    channel: text("channel").notNull(),
    templateKey: text("template_key").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload"),
    status: text("status").notNull().default("queued"),
    provider: text("provider").notNull().default("outbox"),
    providerMessageId: text("provider_message_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("app_notifications_app_idx").on(t.appId),
    index("app_notifications_recipient_idx").on(t.recipientUserId),
    index("app_notifications_status_idx").on(t.status),
    index("app_notifications_created_idx").on(t.createdAt),
  ],
);

/** Platform-owned scheduled notification jobs for generated apps. */
export const appScheduledJobs = pgTable(
  "app_scheduled_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    jobKey: text("job_key").notNull(),
    displayName: text("display_name").notNull(),
    templateKey: text("template_key").notNull(),
    channel: text("channel").notNull().default("in_app"),
    recipientGroup: text("recipient_group").notNull().default("owner"),
    intervalMinutes: integer("interval_minutes").notNull(),
    payload: jsonb("payload"),
    status: text("status").notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("app_scheduled_jobs_app_key_idx").on(t.appId, t.jobKey),
    index("app_scheduled_jobs_app_idx").on(t.appId),
    index("app_scheduled_jobs_status_next_idx").on(t.status, t.nextRunAt),
  ],
);

/** Execution history for platform-managed generated-app jobs. */
export const appJobRuns = pgTable(
  "app_job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    jobId: uuid("job_id")
      .notNull()
      .references(() => appScheduledJobs.id),
    status: text("status").notNull().default("running"),
    attempts: integer("attempts").notNull().default(1),
    payload: jsonb("payload"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("app_job_runs_app_idx").on(t.appId),
    index("app_job_runs_job_idx").on(t.jobId),
    index("app_job_runs_status_idx").on(t.status),
  ],
);

/** Per-app credentials for approved external integrations. */
export const appIntegrationCredentials = pgTable(
  "app_integration_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    providerKey: text("provider_key").notNull(),
    credentialLabel: text("credential_label").notNull().default("Default"),
    authType: text("auth_type").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    encryptedPayload: jsonb("encrypted_payload"),
    status: text("status").notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("app_integration_credentials_app_provider_label_idx").on(
      t.appId,
      t.providerKey,
      t.credentialLabel,
    ),
    index("app_integration_credentials_app_idx").on(t.appId),
    index("app_integration_credentials_provider_idx").on(t.providerKey),
    index("app_integration_credentials_status_idx").on(t.status),
  ],
);

/** Sanitized audit trail for approved integration actions and failures. */
export const appIntegrationEvents = pgTable(
  "app_integration_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    credentialId: uuid("credential_id").references(
      () => appIntegrationCredentials.id,
    ),
    userId: uuid("user_id").references(() => users.id),
    providerKey: text("provider_key").notNull(),
    actionKey: text("action_key").notNull(),
    status: text("status").notNull().default("succeeded"),
    durationMs: integer("duration_ms").notNull().default(0),
    requestSummary: jsonb("request_summary"),
    responseSummary: jsonb("response_summary"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("app_integration_events_app_idx").on(t.appId),
    index("app_integration_events_provider_idx").on(t.providerKey),
    index("app_integration_events_status_idx").on(t.status),
    index("app_integration_events_created_idx").on(t.createdAt),
  ],
);

/** One row per AI request made by a generated app (gate + usage report). */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id),
    kind: text("kind").notNull().default("text"), // text | image
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_usage_app_created_idx").on(t.appId, t.createdAt)],
);

/** Every tool call, credential use, repo change, and deployment. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id),
    appId: uuid("app_id").references(() => apps.id),
    buildRunId: uuid("build_run_id").references(() => buildRuns.id),
    action: text("action").notNull(), // e.g. "createGitHubRepo", "user.signIn"
    payload: jsonb("payload"), // sanitized arguments / results — never secrets
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_user_idx").on(t.userId),
    index("audit_logs_app_idx").on(t.appId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type App = typeof apps.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Requirement = typeof requirements.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type BuildRun = typeof buildRuns.$inferSelect;
export type ArchitecturePlanRow = typeof architecturePlans.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type TestResult = typeof testResults.$inferSelect;
export type ChangeRequest = typeof changeRequests.$inferSelect;
export type AppEntitySchema = typeof appEntitySchemas.$inferSelect;
export type AppMembership = typeof appMemberships.$inferSelect;
export type AppRecord = typeof appRecords.$inferSelect;
export type AppRecordVersion = typeof appRecordVersions.$inferSelect;
export type AppRecordEvent = typeof appRecordEvents.$inferSelect;
export type AppRecordSearchConfig = typeof appRecordSearchConfigs.$inferSelect;
export type AppSavedRecordFilter = typeof appSavedRecordFilters.$inferSelect;
export type AppFile = typeof appFiles.$inferSelect;
export type AppNotificationPreference =
  typeof appNotificationPreferences.$inferSelect;
export type AppNotification = typeof appNotifications.$inferSelect;
export type AppScheduledJob = typeof appScheduledJobs.$inferSelect;
export type AppJobRun = typeof appJobRuns.$inferSelect;
export type AppIntegrationCredential =
  typeof appIntegrationCredentials.$inferSelect;
export type AppIntegrationEvent = typeof appIntegrationEvents.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
