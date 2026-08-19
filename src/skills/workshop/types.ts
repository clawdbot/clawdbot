// Workshop types define generated skill draft, policy, and config contracts.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookSkillProposalEvaluationOutcome } from "../../plugins/hook-types.js";
import type { SkillScanFinding } from "../security/scanner.js";
import type { SkillCollectionReconcileContext } from "./collection-contracts.js";

/** Schema id for persisted skill workshop proposal records. */
export const SKILL_WORKSHOP_SCHEMA = "openclaw.skill-workshop.proposal.v1" as const;
export const SKILL_WORKSHOP_MANIFEST_SCHEMA =
  "openclaw.skill-workshop.proposals-manifest.v1" as const;
export const SKILL_WORKSHOP_ROLLBACK_SCHEMA = "openclaw.skill-workshop.rollback.v1" as const;
export const MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS = 4096;

type SkillProposalKind = "create" | "update";
export type SkillProposalStatus = "pending" | "applied" | "rejected" | "quarantined" | "stale";
type SkillProposalScannerState = "pending" | "clean" | "failed" | "quarantined";
type SkillProposalSource = "skill-workshop" | "cli" | "gateway";
type SkillProposalEvaluationTrigger = "manual" | "apply";
export type SkillProposalEventType =
  | "created"
  | "revised"
  | "evaluation_completed"
  | "applied"
  | "rejected"
  | "quarantined"
  | "stale";

export type SkillProposalEvaluation = {
  id: string;
  proposedVersion: string;
  revisionHash: string;
  trigger: SkillProposalEvaluationTrigger;
  startedAt: string;
  completedAt: string;
  correlationId?: string;
  targetTreeSha256?: string;
  outcomes: PluginHookSkillProposalEvaluationOutcome[];
};

export type SkillProposalEventActor = {
  type: "agent" | "gateway" | "plugin" | "system";
  id?: string;
};

export type SkillProposalEvent = {
  sequence: number;
  eventId: string;
  proposalId: string;
  proposedVersion: string;
  revisionHash: string;
  type: SkillProposalEventType;
  occurredAt: string;
  actor: SkillProposalEventActor;
  correlationId?: string;
  payload?: Record<string, string | number | boolean | null>;
  evaluation?: SkillProposalEvaluation;
};

export type SkillProposalOrigin = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
};

/** Run-scoped budget shared by every workshop tool instance created across runner retries. */
export type SkillWorkshopProposalMutationBudget = {
  remaining: number;
  /** Distinct proposal records successfully mutated by this run. */
  completed?: number;
  /** Successful persisted mutation calls, including repeated revisions. */
  successfulMutations?: number;
  /** Failed or incompletely checkpointed reservations in the current model run. */
  failedMutations?: number;
  /** Run-local identity set used to keep idea counts distinct. */
  mutatedProposalIds?: Set<string>;
  /** Content hash per live skill read this run; autonomous updates require a matching receipt. */
  readSkillHashes?: Map<string, string>;
};

export type SkillWorkshopProposalReviewProgress = {
  proposalIds: string[];
  remaining: number;
  successfulMutations: number;
};

/** Shared completion latch for proposal-only reviewers that require a durable final checkpoint. */
export type SkillWorkshopProposalReviewCompletion = {
  activeMutations?: Set<Promise<void>>;
  completed: boolean;
  complete: () => Promise<void>;
  phase?: "open" | "completing" | "completed";
  recordProgress?: (progress: SkillWorkshopProposalReviewProgress) => Promise<void>;
};

/** Exact proposal revision an operator reviewed before requesting an agent-authored revision. */
export type SkillWorkshopProposalRevisionConstraint = {
  readonly agentId: string;
  readonly workspaceDir: string;
  readonly proposalId: string;
  readonly expectedRevisionHash: string;
};

export type SkillWorkshopRunOptions = {
  env?: NodeJS.ProcessEnv;
  proposalOnly?: boolean;
  updateProposals?: boolean;
  autonomousCapture?: boolean;
  origin?: SkillProposalOrigin;
  proposalMutationBudget?: SkillWorkshopProposalMutationBudget;
  proposalReviewCompletion?: SkillWorkshopProposalReviewCompletion;
  collectionReconcile?: SkillCollectionReconcileContext;
  proposalRevision?: SkillWorkshopProposalRevisionConstraint;
};

export type SkillProposalScan = {
  state: SkillProposalScannerState;
  scannedAt: string;
  critical: number;
  warn: number;
  info: number;
  findings: SkillScanFinding[];
};

type SkillProposalTarget = {
  skillName: string;
  skillKey: string;
  skillDir: string;
  skillFile: string;
  source?: string;
  currentContentHash?: string;
};

export type SkillProposalSupportFile = {
  path: string;
  sizeBytes: number;
  hash: string;
  targetExisted?: boolean;
  targetContentHash?: string;
};

export type SkillProposalRecord = {
  schema: typeof SKILL_WORKSHOP_SCHEMA;
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy: SkillProposalSource;
  /** True only for proposals created by autonomous correction or experience capture. */
  autonomousCapture?: true;
  origin?: SkillProposalOrigin;
  /** Immutable run attribution used to recover interrupted proposal-only reviews. */
  originRunIds?: string[];
  /** Durable mutation counts keyed by run id for bounded interrupted-run recovery. */
  originRunMutationCounts?: Record<string, number>;
  proposedVersion: string;
  draftFile: "PROPOSAL.md";
  draftHash: string;
  supportFiles?: SkillProposalSupportFile[];
  target: SkillProposalTarget;
  scan: SkillProposalScan;
  evaluation?: SkillProposalEvaluation;
  goal?: string;
  evidence?: string;
  appliedAt?: string;
  rejectedAt?: string;
  quarantinedAt?: string;
  staleAt?: string;
  statusReason?: string;
};

export type SkillProposalManifestEntry = {
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  title: string;
  description: string;
  skillName: string;
  skillKey: string;
  createdAt: string;
  updatedAt: string;
  scanState: SkillProposalScannerState;
  /** The proposal remains bound to an earlier workspace for this agent. */
  workspaceMismatch?: true;
  /** The durable proposal body is unavailable; metadata remains inspectable in list output. */
  degradedState?: "draft-missing";
};

export type SkillProposalManifest = {
  schema: typeof SKILL_WORKSHOP_MANIFEST_SCHEMA;
  updatedAt: string;
  proposals: SkillProposalManifestEntry[];
};

export type SkillProposalRollback = {
  schema: typeof SKILL_WORKSHOP_ROLLBACK_SCHEMA;
  proposalId: string;
  writtenAt: string;
  targetSkillFile: string;
  action: "create" | "update";
  previousContentHash?: string;
  previousContent?: string;
  supportFiles?: Array<{
    path: string;
    existed: boolean;
    previousContentHash?: string;
    previousContent?: string;
  }>;
};

export type SkillProposalSupportFileInput = {
  path: string;
  content: string;
};

export type SkillProposalCreateInput = {
  workspaceDir: string;
  agentId?: string;
  eventActor?: SkillProposalEventActor;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  name: string;
  description: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
  createdBy?: SkillProposalSource;
  autonomousCapture?: boolean;
  origin?: SkillProposalOrigin;
  goal?: string;
  evidence?: string;
};

export type SkillProposalUpdateInput = {
  workspaceDir: string;
  agentId?: string;
  eventActor?: SkillProposalEventActor;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  skillName: string;
  description?: string;
  /** Complete replacement body. Exactly one of content or composePatch is required. */
  content?: string;
  /**
   * Targeted find-and-replace composed onto the live body inside the same read that
   * hash-binds the proposal. An empty oldString appends newString to the end.
   */
  composePatch?: { oldString: string; newString: string };
  /** Refuse composition when the service's own read hashes differently (reviewer receipt). */
  expectedCurrentContentHash?: string;
  supportFiles?: SkillProposalSupportFileInput[];
  createdBy?: SkillProposalSource;
  autonomousCapture?: boolean;
  origin?: SkillProposalOrigin;
  goal?: string;
  evidence?: string;
};

export type SkillProposalReviseInput = {
  workspaceDir: string;
  agentId?: string;
  eventActor?: SkillProposalEventActor;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  proposalId: string;
  expectedRevisionHash?: string;
  correlationId?: string;
  content?: string;
  supportFiles?: SkillProposalSupportFileInput[];
  description?: string;
  origin?: SkillProposalOrigin;
  goal?: string;
  evidence?: string;
};

export type SkillProposalActionInput = {
  workspaceDir: string;
  agentId?: string;
  eventActor?: SkillProposalEventActor;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  proposalId: string;
  expectedRevisionHash?: string;
  correlationId?: string;
  reason?: string;
};

export type SkillProposalEvaluateInput = {
  workspaceDir: string;
  agentId?: string;
  eventActor?: SkillProposalEventActor;
  env?: NodeJS.ProcessEnv;
  proposalId: string;
  expectedRevisionHash?: string;
  correlationId?: string;
  trigger?: SkillProposalEvaluationTrigger;
};

export type SkillProposalEventsListInput = {
  workspaceDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  proposalId?: string;
  afterSequence?: number;
  limit?: number;
};

export type SkillProposalEventsListResult = {
  events: SkillProposalEvent[];
  nextSequence?: number;
};

export type SkillProposalReadResult = {
  record: SkillProposalRecord;
  revisionHash: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
};

export type SkillProposalApplyResult = {
  record: SkillProposalRecord;
  targetSkillFile: string;
};

export type SkillProposalEvaluateResult = {
  record: SkillProposalRecord;
  evaluation: SkillProposalEvaluation;
};
