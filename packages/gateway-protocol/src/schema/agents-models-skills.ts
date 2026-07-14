// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
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
export const ModelChoiceSchema = closedObject({
  id: NonEmptyString,
  name: NonEmptyString,
  provider: NonEmptyString,
  alias: Type.Optional(NonEmptyString),
  available: Type.Optional(Type.Boolean()),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  apiKeySupported: Type.Optional(Type.Boolean()),
  input: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("text"),
        Type.Literal("image"),
        Type.Literal("audio"),
        Type.Literal("video"),
        Type.Literal("document"),
      ]),
    ),
  ),
});

/** Condensed agent record returned by list APIs. */
export const AgentSummarySchema = closedObject({
  id: NonEmptyString,
  name: Type.Optional(NonEmptyString),
  identity: Type.Optional(
    closedObject({
      name: Type.Optional(NonEmptyString),
      theme: Type.Optional(NonEmptyString),
      emoji: Type.Optional(NonEmptyString),
      avatar: Type.Optional(NonEmptyString),
      avatarUrl: Type.Optional(NonEmptyString),
    }),
  ),
  workspace: Type.Optional(NonEmptyString),
  workspaceGit: Type.Optional(Type.Boolean()),
  model: Type.Optional(
    closedObject({
      primary: Type.Optional(NonEmptyString),
      fallbacks: Type.Optional(Type.Array(NonEmptyString)),
    }),
  ),
  agentRuntime: Type.Optional(
    closedObject({
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
    }),
  ),
  thinkingLevels: Type.Optional(
    Type.Array(
      closedObject({
        id: NonEmptyString,
        label: NonEmptyString,
      }),
    ),
  ),
  thinkingOptions: Type.Optional(Type.Array(NonEmptyString)),
  thinkingDefault: Type.Optional(NonEmptyString),
});

/** Empty request payload for listing configured agents. */
export const AgentsListParamsSchema = closedObject({});

/** Agent list result including the default agent and session scoping mode. */
export const AgentsListResultSchema = closedObject({
  defaultId: NonEmptyString,
  mainKey: NonEmptyString,
  scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
  agents: Type.Array(AgentSummarySchema),
});

/** Creates a configured agent with workspace, identity, and optional model. */
export const AgentsCreateParamsSchema = closedObject({
  name: NonEmptyString,
  workspace: NonEmptyString,
  model: Type.Optional(NonEmptyString),
  emoji: Type.Optional(Type.String()),
  avatar: Type.Optional(Type.String()),
});

/** Result returned after creating an agent. */
export const AgentsCreateResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
  name: NonEmptyString,
  workspace: NonEmptyString,
  model: Type.Optional(NonEmptyString),
});

/** Updates mutable agent identity, workspace, and model fields. */
export const AgentsUpdateParamsSchema = closedObject({
  agentId: NonEmptyString,
  name: Type.Optional(NonEmptyString),
  workspace: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
  emoji: Type.Optional(Type.String()),
  avatar: Type.Optional(Type.String()),
});

/** Result returned after updating an agent. */
export const AgentsUpdateResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
});

/** Deletes an agent and optionally its workspace/config files. */
export const AgentsDeleteParamsSchema = closedObject({
  agentId: NonEmptyString,
  deleteFiles: Type.Optional(Type.Boolean()),
});

/** Result returned after deleting an agent and unbinding sessions. */
export const AgentsDeleteResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
  removedBindings: Type.Integer({ minimum: 0 }),
});

/** File metadata and optional content for agent-local editable files. */
export const AgentsFileEntrySchema = closedObject({
  name: NonEmptyString,
  path: NonEmptyString,
  missing: Type.Boolean(),
  size: Type.Optional(Type.Integer({ minimum: 0 })),
  updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  content: Type.Optional(Type.String()),
});

/** Lists editable files for one agent. */
export const AgentsFilesListParamsSchema = closedObject({
  agentId: NonEmptyString,
});

/** Editable file list for an agent workspace. */
export const AgentsFilesListResultSchema = closedObject({
  agentId: NonEmptyString,
  workspace: NonEmptyString,
  files: Type.Array(AgentsFileEntrySchema),
});

/** Reads one editable agent file by name. */
export const AgentsFilesGetParamsSchema = closedObject({
  agentId: NonEmptyString,
  name: NonEmptyString,
});

/** Result for reading one editable agent file. */
export const AgentsFilesGetResultSchema = closedObject({
  agentId: NonEmptyString,
  workspace: NonEmptyString,
  file: AgentsFileEntrySchema,
});

/** Writes one editable agent file. */
export const AgentsFilesSetParamsSchema = closedObject({
  agentId: NonEmptyString,
  name: NonEmptyString,
  content: Type.String(),
});

/** Result returned after writing an editable agent file. */
export const AgentsFilesSetResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
  workspace: NonEmptyString,
  file: AgentsFileEntrySchema,
});

/** Model catalog request with optional visibility scope. */
export const ModelsListParamsSchema = closedObject({
  includeProviderCapabilities: Type.Optional(Type.Boolean()),
  view: Type.Optional(
    Type.Union([
      Type.Literal("default"),
      Type.Literal("configured"),
      Type.Literal("provider-config"),
      Type.Literal("all"),
    ]),
  ),
});

/** Model catalog result. */
export const ModelsListResultSchema = closedObject({
  models: Type.Array(ModelChoiceSchema),
});

/** Runs a bounded live credential probe for one model provider. */
export const ModelsProbeParamsSchema = closedObject({
  provider: NonEmptyString,
  profileId: Type.Optional(NonEmptyString),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const AuthProbeStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("auth"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("format"),
  Type.Literal("unknown"),
  Type.Literal("no_model"),
]);

/** Secret-free result for one provider credential target. */
export const ModelsProbeTargetResultSchema = closedObject({
  profileId: Type.Optional(NonEmptyString),
  label: NonEmptyString,
  status: AuthProbeStatusSchema,
  latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
});

/** Provider-level live probe rollup plus per-credential results. */
export const ModelsProbeResultSchema = closedObject({
  provider: NonEmptyString,
  status: AuthProbeStatusSchema,
  latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
  results: Type.Array(ModelsProbeTargetResultSchema),
});

/** Reads installed skill status, optionally for a selected agent. */
export const SkillsStatusParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

/** Empty request payload for listing available skill bins. */
export const SkillsBinsParamsSchema = closedObject({});

/** Skill bin names available to the gateway. */
export const SkillsBinsResultSchema = closedObject({
  bins: Type.Array(NonEmptyString),
});

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
export const SkillsUploadBeginParamsSchema = closedObject({
  kind: Type.Literal("skill-archive"),
  slug: NonEmptyString,
  sizeBytes: Type.Integer({ minimum: 1 }),
  sha256: Type.Optional(Sha256String),
  force: Type.Optional(Type.Boolean()),
  idempotencyKey: Type.Optional(SkillUploadIdempotencyKeyString),
});

/** Uploads one base64-encoded chunk for a skill archive. */
export const SkillsUploadChunkParamsSchema = closedObject({
  uploadId: NonEmptyString,
  offset: Type.Integer({ minimum: 0 }),
  dataBase64: SkillUploadDataBase64String,
});

/** Commits a completed skill archive upload. */
export const SkillsUploadCommitParamsSchema = closedObject({
  uploadId: NonEmptyString,
  sha256: Type.Optional(Sha256String),
});

/** Installs a skill from legacy install id, ClawHub, or uploaded archive. */
export const SkillsInstallParamsSchema = Type.Union([
  closedObject({
    agentId: Type.Optional(NonEmptyString),
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
  }),
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    source: Type.Literal("clawhub"),
    slug: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    force: Type.Optional(Type.Boolean()),
    acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  }),
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    source: Type.Literal("upload"),
    uploadId: NonEmptyString,
    slug: NonEmptyString,
    force: Type.Optional(Type.Boolean()),
    sha256: Type.Optional(Sha256String),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  }),
]);

/** Updates installed skill settings or refreshes ClawHub-installed skills. */
export const SkillsUpdateParamsSchema = Type.Union([
  closedObject({
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  }),
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    source: Type.Literal("clawhub"),
    slug: Type.Optional(NonEmptyString),
    all: Type.Optional(Type.Boolean()),
    acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
  }),
]);

/** Searches the skill registry. */
export const SkillsSearchParamsSchema = closedObject({
  query: Type.Optional(NonEmptyString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/** Ranked skill registry search results. */
export const SkillsSearchResultSchema = closedObject({
  results: Type.Array(
    closedObject({
      score: Type.Number(),
      slug: NonEmptyString,
      displayName: NonEmptyString,
      summary: Type.Optional(Type.String()),
      version: Type.Optional(NonEmptyString),
      updatedAt: Type.Optional(Type.Integer()),
    }),
  ),
});

/** Reads registry detail for one skill slug. */
export const SkillsDetailParamsSchema = closedObject({
  slug: NonEmptyString,
});

/** Reads current security verdicts for configured skills. */
export const SkillsSecurityVerdictsParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

/** Skill registry detail, latest version, metadata, and owner info. */
export const SkillsDetailResultSchema = closedObject({
  skill: Type.Union([
    closedObject({
      slug: NonEmptyString,
      displayName: NonEmptyString,
      summary: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Record(NonEmptyString, Type.String())),
      channel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      isOfficial: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      createdAt: Type.Integer(),
      updatedAt: Type.Integer(),
    }),
    Type.Null(),
  ]),
  latestVersion: Type.Optional(
    Type.Union([
      closedObject({
        version: NonEmptyString,
        createdAt: Type.Integer(),
        changelog: Type.Optional(Type.String()),
      }),
      Type.Null(),
    ]),
  ),
  metadata: Type.Optional(
    Type.Union([
      closedObject({
        os: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        systems: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
  owner: Type.Optional(
    Type.Union([
      closedObject({
        handle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
        displayName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
        image: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        official: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
        channel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        isOfficial: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
});

/** Security verdict report for installed/requested skills. */
export const SkillsSecurityVerdictsResultSchema = closedObject({
  schema: Type.Literal("openclaw.skills.security-verdicts.v1"),
  items: Type.Array(
    closedObject({
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
        closedObject({
          code: Type.Optional(Type.String()),
          message: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),
});

/** Reads the rendered skill card for one installed skill. */
export const SkillsSkillCardParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  skillKey: NonEmptyString,
});

/** Rendered skill card content and file metadata. */
export const SkillsSkillCardResultSchema = closedObject({
  schema: Type.Literal("openclaw.skills.skill-card.v1"),
  skillKey: NonEmptyString,
  path: NonEmptyString,
  sizeBytes: Type.Integer({ minimum: 0 }),
  content: Type.String(),
});

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
const SkillProposalSupportFileInputSchema = closedObject({
  path: NonEmptyString,
  content: Type.String({ maxLength: 262_144 }),
});
/** Stored support file metadata, including target conflict hashes for updates. */
const SkillProposalSupportFileSchema = closedObject({
  path: NonEmptyString,
  sizeBytes: Type.Integer({ minimum: 0, maximum: 262_144 }),
  hash: Sha256String,
  targetExisted: Type.Optional(Type.Boolean()),
  targetContentHash: Type.Optional(Sha256String),
});

/** One static-scan finding against proposed skill content. */
const SkillProposalFindingSchema = closedObject({
  ruleId: NonEmptyString,
  severity: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("critical")]),
  file: NonEmptyString,
  line: Type.Integer({ minimum: 1 }),
  message: NonEmptyString,
  evidence: Type.String(),
});

/** Aggregated scan report attached to a proposal record. */
const SkillProposalScanSchema = closedObject({
  state: SkillProposalScanStateSchema,
  scannedAt: NonEmptyString,
  critical: Type.Integer({ minimum: 0 }),
  warn: Type.Integer({ minimum: 0 }),
  info: Type.Integer({ minimum: 0 }),
  findings: Type.Array(SkillProposalFindingSchema),
});

/** Skill file target that a proposal creates or updates. */
const SkillProposalTargetSchema = closedObject({
  skillName: NonEmptyString,
  skillKey: NonEmptyString,
  skillDir: NonEmptyString,
  skillFile: NonEmptyString,
  source: Type.Optional(NonEmptyString),
  currentContentHash: Type.Optional(NonEmptyString),
});

/** Optional runtime origin tying a proposal back to an agent turn. */
const SkillProposalOriginSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  messageId: Type.Optional(NonEmptyString),
});

/** Full persisted skill proposal record. */
const SkillProposalRecordSchema = closedObject({
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
});

/** Condensed proposal manifest entry for list views. */
const SkillProposalManifestEntrySchema = closedObject({
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
});

/** Lists skill-workshop proposals for the selected agent scope. */
export const SkillsProposalsListParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

/** Proposal manifest response for dashboard/workshop list views. */
export const SkillsProposalsListResultSchema = closedObject({
  schema: Type.Literal("openclaw.skill-workshop.proposals-manifest.v1"),
  updatedAt: NonEmptyString,
  proposals: Type.Array(SkillProposalManifestEntrySchema),
});

/** Reads a proposal record plus editable draft/support content. */
export const SkillsProposalInspectParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  proposalId: NonEmptyString,
});

/** Full proposal inspection result used before apply/revise decisions. */
export const SkillsProposalInspectResultSchema = closedObject({
  record: SkillProposalRecordSchema,
  content: Type.String(),
  supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
});

/** Creates a proposal for a new skill. */
export const SkillsProposalCreateParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  name: NonEmptyString,
  description: NonEmptyString,
  content: SkillProposalContentString,
  supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
  goal: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
});

/** Creates a proposal to update an existing skill. */
export const SkillsProposalUpdateParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  skillName: NonEmptyString,
  description: Type.Optional(NonEmptyString),
  content: SkillProposalContentString,
  supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
  goal: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
});

/** Replaces draft content/support files for an existing proposal. */
export const SkillsProposalReviseParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  proposalId: NonEmptyString,
  content: SkillProposalContentString,
  supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
  description: Type.Optional(NonEmptyString),
  goal: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
});

/** Starts an agent turn that revises a pending proposal from natural-language instructions. */
export const SkillsProposalRequestRevisionParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  targetAgentId: Type.Optional(NonEmptyString),
  proposalId: NonEmptyString,
  instructions: Type.String({ minLength: 1, maxLength: 32_768 }),
  sessionKey: NonEmptyString,
  sessionId: Type.Optional(NonEmptyString),
  idempotencyKey: NonEmptyString,
});

/** Chat-run acknowledgement returned after queueing a Skill Workshop revision request. */
export const SkillsProposalRequestRevisionResultSchema = Type.Object(
  {
    runId: NonEmptyString,
    status: Type.Union([
      Type.Literal("started"),
      Type.Literal("in_flight"),
      Type.Literal("ok"),
      Type.Literal("timeout"),
      Type.Literal("error"),
    ]),
  },
  { additionalProperties: true },
);

/** Shared approve/reject/quarantine action payload for one proposal. */
export const SkillsProposalActionParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  proposalId: NonEmptyString,
  reason: Type.Optional(Type.String()),
});

/** Result returned after applying a skill proposal to disk. */
export const SkillsProposalApplyResultSchema = closedObject({
  record: SkillProposalRecordSchema,
  targetSkillFile: NonEmptyString,
});

/** Proposal record result returned after non-apply proposal actions. */
export const SkillsProposalRecordResultSchema = SkillProposalRecordSchema;

const SkillLifecycleStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("stale"),
  Type.Literal("archived"),
]);

const SkillCuratorEntrySchema = closedObject({
  skillFile: NonEmptyString,
  skillKey: NonEmptyString,
  skillName: NonEmptyString,
  state: SkillLifecycleStateSchema,
  pinned: Type.Boolean(),
  createdAtMs: Type.Number(),
  stateChangedAtMs: Type.Number(),
  lastUsedAtMs: Type.Union([Type.Number(), Type.Null()]),
  useCount: Type.Number(),
  archivedReason: Type.Union([Type.String(), Type.Null()]),
});

const SkillOverlapCandidateSchema = closedObject({
  left: NonEmptyString,
  right: NonEmptyString,
  score: Type.Number(),
});

/** Reads persisted skill lifecycle curation state. */
export const SkillsCuratorStatusParamsSchema = closedObject({});

export const SkillsCuratorStatusResultSchema = closedObject({
  lastAttemptAtMs: Type.Union([Type.Number(), Type.Null()]),
  lastSuccessAtMs: Type.Union([Type.Number(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  counts: closedObject({
    active: Type.Number(),
    stale: Type.Number(),
    archived: Type.Number(),
  }),
  skills: Type.Array(SkillCuratorEntrySchema),
  overlaps: Type.Array(SkillOverlapCandidateSchema),
});

/** Pins, unpins, or explicitly restores one curated skill. */
export const SkillsCuratorActionParamsSchema = closedObject({ skill: NonEmptyString });

export const SkillsCuratorActionResultSchema = SkillCuratorEntrySchema;

/** Reads the configured tool catalog for an agent. */
export const ToolsCatalogParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  includePlugins: Type.Optional(Type.Boolean()),
});

/** Reads the effective tool set for one session. */
export const ToolsEffectiveParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: NonEmptyString,
});

/** Invokes one tool through the gateway tool dispatcher. */
export const ToolsInvokeParamsSchema = closedObject({
  name: NonEmptyString,
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  confirm: Type.Optional(Type.Boolean()),
  idempotencyKey: Type.Optional(NonEmptyString),
  /**
   * Explicit operation-local marker for an authenticated direct operator.
   * Missing values remain delegated, and agent runtime identity wins server-side.
   */
  conversationReadOrigin: Type.Optional(Type.Literal("direct-operator")),
});

/** Tool profile shown in catalog views. */
export const ToolCatalogProfileSchema = closedObject({
  id: Type.Union([
    Type.Literal("minimal"),
    Type.Literal("coding"),
    Type.Literal("messaging"),
    Type.Literal("full"),
  ]),
  label: NonEmptyString,
});

/** Tool catalog entry before session-specific filtering is applied. */
export const ToolCatalogEntrySchema = closedObject({
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
});

/** Group of related catalog tools from core or a plugin. */
export const ToolCatalogGroupSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
  pluginId: Type.Optional(NonEmptyString),
  tools: Type.Array(ToolCatalogEntrySchema),
});

/** Tool catalog result for agent configuration UI. */
export const ToolsCatalogResultSchema = closedObject({
  agentId: NonEmptyString,
  profiles: Type.Array(ToolCatalogProfileSchema),
  groups: Type.Array(ToolCatalogGroupSchema),
});

/** Effective tool entry after session/profile/channel/plugin filtering. */
export const ToolsEffectiveEntrySchema = closedObject({
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
});

/** Effective tool group shown to runtime/session callers. */
export const ToolsEffectiveGroupSchema = closedObject({
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
});

/** Notice explaining runtime filtering such as quarantined tool schemas. */
export const ToolsEffectiveNoticeSchema = closedObject({
  id: NonEmptyString,
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning")]),
  message: Type.String(),
});

/** Effective tool set for a session, including profile and filtering notices. */
export const ToolsEffectiveResultSchema = closedObject({
  agentId: NonEmptyString,
  profile: NonEmptyString,
  groups: Type.Array(ToolsEffectiveGroupSchema),
  notices: Type.Optional(Type.Array(ToolsEffectiveNoticeSchema)),
});

/** Normalized error shape for tool invocation failures. */
export const ToolsInvokeErrorSchema = closedObject({
  code: NonEmptyString,
  message: NonEmptyString,
  details: Type.Optional(Type.Unknown()),
});

/** Tool invocation result, including approval handoff when required. */
export const ToolsInvokeResultSchema = closedObject({
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
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type AgentSummary = Static<typeof AgentSummarySchema>;
export type AgentsFileEntry = Static<typeof AgentsFileEntrySchema>;
export type AgentsCreateParams = Static<typeof AgentsCreateParamsSchema>;
export type AgentsCreateResult = Static<typeof AgentsCreateResultSchema>;
export type AgentsUpdateParams = Static<typeof AgentsUpdateParamsSchema>;
export type AgentsUpdateResult = Static<typeof AgentsUpdateResultSchema>;
export type AgentsDeleteParams = Static<typeof AgentsDeleteParamsSchema>;
export type AgentsDeleteResult = Static<typeof AgentsDeleteResultSchema>;
export type AgentsFilesListParams = Static<typeof AgentsFilesListParamsSchema>;
export type AgentsFilesListResult = Static<typeof AgentsFilesListResultSchema>;
export type AgentsFilesGetParams = Static<typeof AgentsFilesGetParamsSchema>;
export type AgentsFilesGetResult = Static<typeof AgentsFilesGetResultSchema>;
export type AgentsFilesSetParams = Static<typeof AgentsFilesSetParamsSchema>;
export type AgentsFilesSetResult = Static<typeof AgentsFilesSetResultSchema>;
export type AgentsListParams = Static<typeof AgentsListParamsSchema>;
export type AgentsListResult = Static<typeof AgentsListResultSchema>;
export type ModelChoice = Static<typeof ModelChoiceSchema>;
export type ModelsListParams = Static<typeof ModelsListParamsSchema>;
export type ModelsListResult = Static<typeof ModelsListResultSchema>;
export type AuthProbeStatus = Static<typeof AuthProbeStatusSchema>;
export type ModelsProbeParams = Static<typeof ModelsProbeParamsSchema>;
export type ModelsProbeTargetResult = Static<typeof ModelsProbeTargetResultSchema>;
export type ModelsProbeResult = Static<typeof ModelsProbeResultSchema>;
export type SkillsStatusParams = Static<typeof SkillsStatusParamsSchema>;
export type ToolsCatalogParams = Static<typeof ToolsCatalogParamsSchema>;
export type ToolCatalogProfile = Static<typeof ToolCatalogProfileSchema>;
export type ToolCatalogEntry = Static<typeof ToolCatalogEntrySchema>;
export type ToolCatalogGroup = Static<typeof ToolCatalogGroupSchema>;
export type ToolsCatalogResult = Static<typeof ToolsCatalogResultSchema>;
export type ToolsEffectiveParams = Static<typeof ToolsEffectiveParamsSchema>;
export type ToolsEffectiveEntry = Static<typeof ToolsEffectiveEntrySchema>;
export type ToolsEffectiveGroup = Static<typeof ToolsEffectiveGroupSchema>;
export type ToolsEffectiveNotice = Static<typeof ToolsEffectiveNoticeSchema>;
export type ToolsEffectiveResult = Static<typeof ToolsEffectiveResultSchema>;
export type ToolsInvokeParams = Static<typeof ToolsInvokeParamsSchema>;
export type ToolsInvokeResult = Static<typeof ToolsInvokeResultSchema>;
export type SkillsBinsParams = Static<typeof SkillsBinsParamsSchema>;
export type SkillsBinsResult = Static<typeof SkillsBinsResultSchema>;
export type SkillsSearchParams = Static<typeof SkillsSearchParamsSchema>;
export type SkillsSearchResult = Static<typeof SkillsSearchResultSchema>;
export type SkillsDetailParams = Static<typeof SkillsDetailParamsSchema>;
export type SkillsDetailResult = Static<typeof SkillsDetailResultSchema>;
export type SkillsProposalsListParams = Static<typeof SkillsProposalsListParamsSchema>;
export type SkillsProposalsListResult = Static<typeof SkillsProposalsListResultSchema>;
export type SkillsProposalInspectParams = Static<typeof SkillsProposalInspectParamsSchema>;
export type SkillsProposalInspectResult = Static<typeof SkillsProposalInspectResultSchema>;
export type SkillsProposalCreateParams = Static<typeof SkillsProposalCreateParamsSchema>;
export type SkillsProposalUpdateParams = Static<typeof SkillsProposalUpdateParamsSchema>;
export type SkillsProposalReviseParams = Static<typeof SkillsProposalReviseParamsSchema>;
export type SkillsProposalRequestRevisionParams = Static<
  typeof SkillsProposalRequestRevisionParamsSchema
>;
export type SkillsProposalRequestRevisionResult = Static<
  typeof SkillsProposalRequestRevisionResultSchema
>;
export type SkillsProposalActionParams = Static<typeof SkillsProposalActionParamsSchema>;
export type SkillsProposalApplyResult = Static<typeof SkillsProposalApplyResultSchema>;
export type SkillsProposalRecordResult = Static<typeof SkillsProposalRecordResultSchema>;
export type SkillsCuratorStatusParams = Static<typeof SkillsCuratorStatusParamsSchema>;
export type SkillsCuratorStatusResult = Static<typeof SkillsCuratorStatusResultSchema>;
export type SkillsCuratorActionParams = Static<typeof SkillsCuratorActionParamsSchema>;
export type SkillsCuratorActionResult = Static<typeof SkillsCuratorActionResultSchema>;
export type SkillsSecurityVerdictsParams = Static<typeof SkillsSecurityVerdictsParamsSchema>;
export type SkillsSecurityVerdictsResult = Static<typeof SkillsSecurityVerdictsResultSchema>;
export type SkillsSkillCardParams = Static<typeof SkillsSkillCardParamsSchema>;
export type SkillsSkillCardResult = Static<typeof SkillsSkillCardResultSchema>;
export type SkillsUploadBeginParams = Static<typeof SkillsUploadBeginParamsSchema>;
export type SkillsUploadChunkParams = Static<typeof SkillsUploadChunkParamsSchema>;
export type SkillsUploadCommitParams = Static<typeof SkillsUploadCommitParamsSchema>;
export type SkillsInstallParams = Static<typeof SkillsInstallParamsSchema>;
export type SkillsUpdateParams = Static<typeof SkillsUpdateParamsSchema>;
