// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Agent, model, skill, and tool catalog schemas.
 *
 * These contracts back dashboard selectors, agent management, model catalogs,
 * skill upload/install flows, skill workshop proposals, and effective tool
 * discovery. Keep public request/result schemas documented because they are
 * shared by gateway RPC, CLI, and UI clients.
 */

/** Model option shown in selectors and model catalog results. */
export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    alias: Type.Optional(NonEmptyString),
    available: Type.Optional(Type.Boolean()),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Condensed agent record returned by list APIs. */
export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    identity: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    workspace: Type.Optional(NonEmptyString),
    model: Type.Optional(
      Type.Object(
        {
          primary: Type.Optional(NonEmptyString),
          fallbacks: Type.Optional(Type.Array(NonEmptyString)),
        },
        { additionalProperties: false },
      ),
    ),
    agentRuntime: Type.Optional(
      Type.Object(
        {
          id: NonEmptyString,
          fallback: Type.Optional(Type.Union([Type.Literal("openclaw"), Type.Literal("none")])),
          source: Type.Union([
            Type.Literal("env"),
            Type.Literal("agent"),
            Type.Literal("defaults"),
            Type.Literal("model"),
            Type.Literal("provider"),
            Type.Literal("implicit"),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    thinkingLevels: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: NonEmptyString,
            label: NonEmptyString,
          },
          { additionalProperties: false },
        ),
      ),
    ),
    thinkingOptions: Type.Optional(Type.Array(NonEmptyString)),
    thinkingDefault: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Empty request payload for listing configured agents. */
export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Agent list result including the default agent and session scoping mode. */
export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

/** Creates a configured agent with workspace, identity, and optional model. */
export const AgentsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    workspace: NonEmptyString,
    model: Type.Optional(NonEmptyString),
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Result returned after creating an agent. */
export const AgentsCreateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    name: NonEmptyString,
    workspace: NonEmptyString,
    model: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Updates mutable agent identity, workspace, and model fields. */
export const AgentsUpdateParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Result returned after updating an agent. */
export const AgentsUpdateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Deletes an agent and optionally its workspace/config files. */
export const AgentsDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Result returned after deleting an agent and unbinding sessions. */
export const AgentsDeleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    removedBindings: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** File metadata and optional content for agent-local editable files. */
export const AgentsFileEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Lists editable files for one agent. */
export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Editable file list for an agent workspace. */
export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

/** Reads one editable agent file by name. */
export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Result for reading one editable agent file. */
export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

/** Writes one editable agent file. */
export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

/** Result returned after writing an editable agent file. */
export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

/** Model catalog request with optional visibility scope. */
export const ModelsListParamsSchema = Type.Object(
  {
    view: Type.Optional(
      Type.Union([Type.Literal("default"), Type.Literal("configured"), Type.Literal("all")]),
    ),
  },
  { additionalProperties: false },
);

/** Model catalog result. */
export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

/** Reads installed skill status, optionally for a selected agent. */
export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Empty request payload for listing available skill bins. */
export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

/** Skill bin names available to the gateway. */
export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

const Sha256String = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-fA-F0-9]{64}$",
});
const SkillUploadIdempotencyKeyString = Type.String({
  minLength: 1,
  maxLength: 2048,
});
const SkillUploadDataBase64String = Type.String({
  minLength: 1,
  maxLength: 5_592_408,
});

/** Starts a chunked skill archive upload. */
export const SkillsUploadBeginParamsSchema = Type.Object(
  {
    kind: Type.Literal("skill-archive"),
    slug: NonEmptyString,
    sizeBytes: Type.Integer({ minimum: 1 }),
    sha256: Type.Optional(Sha256String),
    force: Type.Optional(Type.Boolean()),
    idempotencyKey: Type.Optional(SkillUploadIdempotencyKeyString),
  },
  { additionalProperties: false },
);

/** Uploads one base64-encoded chunk for a skill archive. */
export const SkillsUploadChunkParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
    offset: Type.Integer({ minimum: 0 }),
    dataBase64: SkillUploadDataBase64String,
  },
  { additionalProperties: false },
);

/** Commits a completed skill archive upload. */
export const SkillsUploadCommitParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
    sha256: Type.Optional(Sha256String),
  },
  { additionalProperties: false },
);

/** Installs a skill from legacy install id, ClawHub, or uploaded archive. */
export const SkillsInstallParamsSchema = Type.Union([
  Type.Object(
    {
      name: NonEmptyString,
      installId: NonEmptyString,
      dangerouslyForceUnsafeInstall: Type.Optional(
        Type.Boolean({
          deprecated: true,
          description:
            "Deprecated compatibility field. Current servers ignore it; install policy is controlled by security.installPolicy.",
        }),
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("clawhub"),
      slug: NonEmptyString,
      version: Type.Optional(NonEmptyString),
      force: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("upload"),
      uploadId: NonEmptyString,
      slug: NonEmptyString,
      force: Type.Optional(Type.Boolean()),
      sha256: Type.Optional(Sha256String),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
]);

/** Updates installed skill settings or refreshes ClawHub-installed skills. */
export const SkillsUpdateParamsSchema = Type.Union([
  Type.Object(
    {
      skillKey: NonEmptyString,
      enabled: Type.Optional(Type.Boolean()),
      apiKey: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("clawhub"),
      slug: Type.Optional(NonEmptyString),
      all: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

/** Searches the skill registry. */
export const SkillsSearchParamsSchema = Type.Object(
  {
    query: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

/** Ranked skill registry search results. */
export const SkillsSearchResultSchema = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          score: Type.Number(),
          slug: NonEmptyString,
          displayName: NonEmptyString,
          summary: Type.Optional(Type.String()),
          version: Type.Optional(NonEmptyString),
          updatedAt: Type.Optional(Type.Integer()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Reads registry detail for one skill slug. */
export const SkillsDetailParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Reads current security verdicts for configured skills. */
export const SkillsSecurityVerdictsParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Skill registry detail, latest version, metadata, and owner info. */
export const SkillsDetailResultSchema = Type.Object(
  {
    skill: Type.Union([
      Type.Object(
        {
          slug: NonEmptyString,
          displayName: NonEmptyString,
          summary: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Record(NonEmptyString, Type.String())),
          createdAt: Type.Integer(),
          updatedAt: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    latestVersion: Type.Optional(
      Type.Union([
        Type.Object(
          {
            version: NonEmptyString,
            createdAt: Type.Integer(),
            changelog: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    metadata: Type.Optional(
      Type.Union([
        Type.Object(
          {
            os: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
            systems: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    owner: Type.Optional(
      Type.Union([
        Type.Object(
          {
            handle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
            displayName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
            image: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Security verdict report for installed/requested skills. */
export const SkillsSecurityVerdictsResultSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.skills.security-verdicts.v1"),
    items: Type.Array(
      Type.Object(
        {
          registry: NonEmptyString,
          ok: Type.Boolean(),
          decision: NonEmptyString,
          reasons: Type.Array(Type.String()),
          requestedSlug: NonEmptyString,
          requestedVersion: NonEmptyString,
          slug: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
          version: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
          displayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          publisherHandle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          publisherDisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          createdAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
          checkedAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
          skillUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          securityAuditUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          securityStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          securityPassed: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
          error: Type.Optional(
            Type.Object(
              {
                code: Type.Optional(Type.String()),
                message: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Reads the rendered skill card for one installed skill. */
export const SkillsSkillCardParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    skillKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Rendered skill card content and file metadata. */
export const SkillsSkillCardResultSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.skills.skill-card.v1"),
    skillKey: NonEmptyString,
    path: NonEmptyString,
    sizeBytes: Type.Integer({ minimum: 0 }),
    content: Type.String(),
  },
  { additionalProperties: false },
);

const SkillProposalStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("applied"),
  Type.Literal("rejected"),
  Type.Literal("quarantined"),
  Type.Literal("stale"),
]);
/** Skill proposal operation type: new skill or update to an existing skill. */
const SkillProposalKindSchema = Type.Union([Type.Literal("create"), Type.Literal("update")]);
/** Scan state for proposed skill content before it can be applied. */
const SkillProposalScanStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("clean"),
  Type.Literal("failed"),
  Type.Literal("quarantined"),
]);
/** Source that created the skill proposal record. */
const SkillProposalSourceSchema = Type.Union([
  Type.Literal("skill-workshop"),
  Type.Literal("cli"),
  Type.Literal("gateway"),
]);
const SkillProposalContentString = Type.String({ minLength: 1, maxLength: 1_048_576 });
/** Support file payload accepted from proposal create/revise requests. */
const SkillProposalSupportFileInputSchema = Type.Object(
  {
    path: NonEmptyString,
    content: Type.String({ maxLength: 262_144 }),
  },
  { additionalProperties: false },
);
/** Stored support file metadata, including target conflict hashes for updates. */
const SkillProposalSupportFileSchema = Type.Object(
  {
    path: NonEmptyString,
    sizeBytes: Type.Integer({ minimum: 0, maximum: 262_144 }),
    hash: Sha256String,
    targetExisted: Type.Optional(Type.Boolean()),
    targetContentHash: Type.Optional(Sha256String),
  },
  { additionalProperties: false },
);

/** One static-scan finding against proposed skill content. */
const SkillProposalFindingSchema = Type.Object(
  {
    ruleId: NonEmptyString,
    severity: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("critical")]),
    file: NonEmptyString,
    line: Type.Integer({ minimum: 1 }),
    message: NonEmptyString,
    evidence: Type.String(),
  },
  { additionalProperties: false },
);

/** Aggregated scan report attached to a proposal record. */
const SkillProposalScanSchema = Type.Object(
  {
    state: SkillProposalScanStateSchema,
    scannedAt: NonEmptyString,
    critical: Type.Integer({ minimum: 0 }),
    warn: Type.Integer({ minimum: 0 }),
    info: Type.Integer({ minimum: 0 }),
    findings: Type.Array(SkillProposalFindingSchema),
  },
  { additionalProperties: false },
);

/** Skill file target that a proposal creates or updates. */
const SkillProposalTargetSchema = Type.Object(
  {
    skillName: NonEmptyString,
    skillKey: NonEmptyString,
    skillDir: NonEmptyString,
    skillFile: NonEmptyString,
    source: Type.Optional(NonEmptyString),
    currentContentHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Optional runtime origin tying a proposal back to an agent turn. */
const SkillProposalOriginSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    messageId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Full persisted skill proposal record. */
const SkillProposalRecordSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.skill-workshop.proposal.v1"),
    id: NonEmptyString,
    kind: SkillProposalKindSchema,
    status: SkillProposalStatusSchema,
    title: NonEmptyString,
    description: NonEmptyString,
    createdAt: NonEmptyString,
    updatedAt: NonEmptyString,
    createdBy: SkillProposalSourceSchema,
    origin: Type.Optional(SkillProposalOriginSchema),
    proposedVersion: NonEmptyString,
    draftFile: Type.Literal("PROPOSAL.md"),
    draftHash: NonEmptyString,
    supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileSchema, { maxItems: 64 })),
    target: SkillProposalTargetSchema,
    scan: SkillProposalScanSchema,
    goal: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
    appliedAt: Type.Optional(NonEmptyString),
    rejectedAt: Type.Optional(NonEmptyString),
    quarantinedAt: Type.Optional(NonEmptyString),
    staleAt: Type.Optional(NonEmptyString),
    statusReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Condensed proposal manifest entry for list views. */
const SkillProposalManifestEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    kind: SkillProposalKindSchema,
    status: SkillProposalStatusSchema,
    title: NonEmptyString,
    description: NonEmptyString,
    skillName: NonEmptyString,
    skillKey: NonEmptyString,
    createdAt: NonEmptyString,
    updatedAt: NonEmptyString,
    scanState: SkillProposalScanStateSchema,
  },
  { additionalProperties: false },
);

/** Lists skill-workshop proposals for the selected agent scope. */
export const SkillsProposalsListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Proposal manifest response for dashboard/workshop list views. */
export const SkillsProposalsListResultSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.skill-workshop.proposals-manifest.v1"),
    updatedAt: NonEmptyString,
    proposals: Type.Array(SkillProposalManifestEntrySchema),
  },
  { additionalProperties: false },
);

/** Reads a proposal record plus editable draft/support content. */
export const SkillsProposalInspectParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    proposalId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Full proposal inspection result used before apply/revise decisions. */
export const SkillsProposalInspectResultSchema = Type.Object(
  {
    record: SkillProposalRecordSchema,
    content: Type.String(),
    supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);

/** Creates a proposal for a new skill. */
export const SkillsProposalCreateParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    description: NonEmptyString,
    content: SkillProposalContentString,
    supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
    goal: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Creates a proposal to update an existing skill. */
export const SkillsProposalUpdateParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    skillName: NonEmptyString,
    description: Type.Optional(NonEmptyString),
    content: SkillProposalContentString,
    supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
    goal: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Replaces draft content/support files for an existing proposal. */
export const SkillsProposalReviseParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    proposalId: NonEmptyString,
    content: SkillProposalContentString,
    supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
    description: Type.Optional(NonEmptyString),
    goal: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Starts an agent turn that revises a pending proposal from natural-language instructions. */
export const SkillsProposalRequestRevisionParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    targetAgentId: Type.Optional(NonEmptyString),
    proposalId: NonEmptyString,
    instructions: Type.String({ minLength: 1, maxLength: 32_768 }),
    sessionKey: NonEmptyString,
    sessionId: Type.Optional(NonEmptyString),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Chat-run acknowledgement returned after queueing a Skill Workshop revision request. */
export const SkillsProposalRequestRevisionResultSchema = Type.Object(
  {
    runId: NonEmptyString,
    status: Type.Union([Type.Literal("started"), Type.Literal("in_flight"), Type.Literal("ok")]),
  },
  { additionalProperties: true },
);

/** Shared approve/reject/quarantine action payload for one proposal. */
export const SkillsProposalActionParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    proposalId: NonEmptyString,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Result returned after applying a skill proposal to disk. */
export const SkillsProposalApplyResultSchema = Type.Object(
  {
    record: SkillProposalRecordSchema,
    targetSkillFile: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Proposal record result returned after non-apply proposal actions. */
export const SkillsProposalRecordResultSchema = SkillProposalRecordSchema;

/** Reads the configured tool catalog for an agent. */
export const ToolsCatalogParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includePlugins: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Reads the effective tool set for one session. */
export const ToolsEffectiveParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Invokes one tool through the gateway tool dispatcher. */
export const ToolsInvokeParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    sessionKey: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    confirm: Type.Optional(Type.Boolean()),
    idempotencyKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Tool profile shown in catalog views. */
export const ToolCatalogProfileSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("minimal"),
      Type.Literal("coding"),
      Type.Literal("messaging"),
      Type.Literal("full"),
    ]),
    label: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Tool catalog entry before session-specific filtering is applied. */
export const ToolCatalogEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    optional: Type.Optional(Type.Boolean()),
    risk: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    tags: Type.Optional(Type.Array(NonEmptyString)),
    defaultProfiles: Type.Array(
      Type.Union([
        Type.Literal("minimal"),
        Type.Literal("coding"),
        Type.Literal("messaging"),
        Type.Literal("full"),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Group of related catalog tools from core or a plugin. */
export const ToolCatalogGroupSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    tools: Type.Array(ToolCatalogEntrySchema),
  },
  { additionalProperties: false },
);

/** Tool catalog result for agent configuration UI. */
export const ToolsCatalogResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profiles: Type.Array(ToolCatalogProfileSchema),
    groups: Type.Array(ToolCatalogGroupSchema),
  },
  { additionalProperties: false },
);

/** Effective tool entry after session/profile/channel/plugin filtering. */
export const ToolsEffectiveEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    rawDescription: Type.String(),
    source: Type.Union([
      Type.Literal("core"),
      Type.Literal("plugin"),
      Type.Literal("channel"),
      Type.Literal("mcp"),
    ]),
    pluginId: Type.Optional(NonEmptyString),
    channelId: Type.Optional(NonEmptyString),
    risk: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    tags: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

/** Effective tool group shown to runtime/session callers. */
export const ToolsEffectiveGroupSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("core"),
      Type.Literal("plugin"),
      Type.Literal("channel"),
      Type.Literal("mcp"),
    ]),
    label: NonEmptyString,
    source: Type.Union([
      Type.Literal("core"),
      Type.Literal("plugin"),
      Type.Literal("channel"),
      Type.Literal("mcp"),
    ]),
    tools: Type.Array(ToolsEffectiveEntrySchema),
  },
  { additionalProperties: false },
);

/** Notice explaining runtime filtering such as quarantined tool schemas. */
export const ToolsEffectiveNoticeSchema = Type.Object(
  {
    id: NonEmptyString,
    severity: Type.Union([Type.Literal("info"), Type.Literal("warning")]),
    message: Type.String(),
  },
  { additionalProperties: false },
);

/** Effective tool set for a session, including profile and filtering notices. */
export const ToolsEffectiveResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profile: NonEmptyString,
    groups: Type.Array(ToolsEffectiveGroupSchema),
    notices: Type.Optional(Type.Array(ToolsEffectiveNoticeSchema)),
  },
  { additionalProperties: false },
);

/** Normalized error shape for tool invocation failures. */
export const ToolsInvokeErrorSchema = Type.Object(
  {
    code: NonEmptyString,
    message: NonEmptyString,
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Tool invocation result, including approval handoff when required. */
export const ToolsInvokeResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    toolName: NonEmptyString,
    output: Type.Optional(Type.Unknown()),
    requiresApproval: Type.Optional(Type.Boolean()),
    approvalId: Type.Optional(NonEmptyString),
    source: Type.Optional(
      Type.Union([
        Type.Literal("core"),
        Type.Literal("plugin"),
        Type.Literal("mcp"),
        Type.Literal("channel"),
        Type.String(),
      ]),
    ),
    error: Type.Optional(ToolsInvokeErrorSchema),
  },
  { additionalProperties: false },
);
