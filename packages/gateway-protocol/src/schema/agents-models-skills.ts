import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    alias: Type.Optional(NonEmptyString),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

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
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

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

export const AgentsUpdateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsDeleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    removedBindings: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

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

export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object(
  {
    view: Type.Optional(
      Type.Union([Type.Literal("default"), Type.Literal("configured"), Type.Literal("all")]),
    ),
  },
  { additionalProperties: false },
);

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

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

export const SkillsUploadChunkParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
    offset: Type.Integer({ minimum: 0 }),
    dataBase64: SkillUploadDataBase64String,
  },
  { additionalProperties: false },
);

export const SkillsUploadCommitParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
    sha256: Type.Optional(Sha256String),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Union([
  Type.Object(
    {
      name: NonEmptyString,
      installId: NonEmptyString,
      dangerouslyForceUnsafeInstall: Type.Optional(Type.Boolean()),
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

export const SkillsSearchParamsSchema = Type.Object(
  {
    query: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

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

export const SkillsDetailParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsSecurityVerdictsParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

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

export const SkillsSkillCardParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    skillKey: NonEmptyString,
  },
  { additionalProperties: false },
);

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
const SkillProposalKindSchema = Type.Union([Type.Literal("create"), Type.Literal("update")]);
const SkillProposalScanStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("clean"),
  Type.Literal("failed"),
  Type.Literal("quarantined"),
]);
const SkillProposalSourceSchema = Type.Union([
  Type.Literal("skill-workshop"),
  Type.Literal("cli"),
  Type.Literal("gateway"),
]);
const SkillProposalContentString = Type.String({ minLength: 1, maxLength: 1_048_576 });
const SkillProposalSupportFileInputSchema = Type.Object(
  {
    path: NonEmptyString,
    content: Type.String({ maxLength: 262_144 }),
  },
  { additionalProperties: false },
);
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

export const SkillsProposalsListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsProposalsListResultSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.skill-workshop.proposals-manifest.v1"),
    updatedAt: NonEmptyString,
    proposals: Type.Array(SkillProposalManifestEntrySchema),
  },
  { additionalProperties: false },
);

export const SkillsProposalInspectParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    proposalId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsProposalInspectResultSchema = Type.Object(
  {
    record: SkillProposalRecordSchema,
    content: Type.String(),
    supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);

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

export const SkillsProposalActionParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    proposalId: NonEmptyString,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SkillsProposalApplyResultSchema = Type.Object(
  {
    record: SkillProposalRecordSchema,
    targetSkillFile: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsProposalRecordResultSchema = SkillProposalRecordSchema;

export const ToolsCatalogParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includePlugins: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

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

export const ToolsCatalogResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profiles: Type.Array(ToolCatalogProfileSchema),
    groups: Type.Array(ToolCatalogGroupSchema),
  },
  { additionalProperties: false },
);

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

export const ToolsEffectiveNoticeSchema = Type.Object(
  {
    id: NonEmptyString,
    severity: Type.Union([Type.Literal("info"), Type.Literal("warning")]),
    message: Type.String(),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profile: NonEmptyString,
    groups: Type.Array(ToolsEffectiveGroupSchema),
    notices: Type.Optional(Type.Array(ToolsEffectiveNoticeSchema)),
  },
  { additionalProperties: false },
);

export const ToolsInvokeErrorSchema = Type.Object(
  {
    code: NonEmptyString,
    message: NonEmptyString,
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

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
