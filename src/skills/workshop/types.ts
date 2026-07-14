// Workshop types define generated skill draft, policy, and config contracts.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillScanFinding } from "../security/scanner.js";

/** Schema id for persisted skill workshop proposal records. */
export const SKILL_WORKSHOP_SCHEMA = "openclaw.skill-workshop.proposal.v1" as const;
export const SKILL_WORKSHOP_MANIFEST_SCHEMA =
  "openclaw.skill-workshop.proposals-manifest.v1" as const;
export const SKILL_WORKSHOP_ROLLBACK_SCHEMA = "openclaw.skill-workshop.rollback.v1" as const;

type SkillProposalKind = "create" | "update";
export type SkillProposalStatus = "pending" | "applied" | "rejected" | "quarantined" | "stale";
type SkillProposalScannerState = "pending" | "clean" | "failed" | "quarantined";
type SkillProposalSource = "skill-workshop" | "cli" | "gateway";

export type SkillProposalOrigin = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
};

/** Run-scoped budget shared by every workshop tool instance created across runner retries. */
export type SkillWorkshopProposalMutationBudget = {
  remaining: number;
};

export type SkillWorkshopRunOptions = {
  proposalOnly?: boolean;
  origin?: SkillProposalOrigin;
  proposalMutationBudget?: SkillWorkshopProposalMutationBudget;
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
  origin?: SkillProposalOrigin;
  proposedVersion: string;
  draftFile: "PROPOSAL.md";
  draftHash: string;
  supportFiles?: SkillProposalSupportFile[];
  target: SkillProposalTarget;
  scan: SkillProposalScan;
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
  config?: OpenClawConfig;
  name: string;
  description: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
  createdBy?: SkillProposalSource;
  origin?: SkillProposalOrigin;
  goal?: string;
  evidence?: string;
};

export type SkillProposalUpdateInput = {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillName: string;
  description?: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
  createdBy?: SkillProposalSource;
  origin?: SkillProposalOrigin;
  goal?: string;
  evidence?: string;
};

export type SkillProposalReviseInput = {
  workspaceDir: string;
  config?: OpenClawConfig;
  proposalId: string;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
  description?: string;
  origin?: SkillProposalOrigin;
  goal?: string;
  evidence?: string;
};

export type SkillProposalActionInput = {
  workspaceDir: string;
  config?: OpenClawConfig;
  proposalId: string;
  reason?: string;
};

export type SkillProposalReadResult = {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
};

export type SkillProposalApplyResult = {
  record: SkillProposalRecord;
  targetSkillFile: string;
};
