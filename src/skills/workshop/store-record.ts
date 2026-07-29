import {
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
} from "../lifecycle/workspace-skill-write.js";
import { hasValidProposalOriginProvenance } from "./proposal-origin-validation.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalRecord,
  type SkillProposalRollback,
  type SkillProposalSupportFile,
} from "./types.js";

export const PROPOSAL_DRAFT_FILE = "PROPOSAL.md";
export const MAX_PROPOSAL_SUPPORT_FILES = 64;
const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/;

export function assertProposalId(proposalId: string): void {
  if (!PROPOSAL_ID_PATTERN.test(proposalId)) {
    throw new Error("Invalid skill proposal id.");
  }
}

export function parseSkillProposalRecord(raw: unknown): SkillProposalRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as SkillProposalRecord;
  if (
    record.schema !== SKILL_WORKSHOP_SCHEMA ||
    !PROPOSAL_ID_PATTERN.test(record.id) ||
    (record.kind !== "create" && record.kind !== "update") ||
    !["pending", "applied", "rejected", "quarantined", "stale"].includes(record.status) ||
    typeof record.title !== "string" ||
    typeof record.description !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    typeof record.draftHash !== "string" ||
    record.draftFile !== PROPOSAL_DRAFT_FILE ||
    !hasValidProposalOriginProvenance(record) ||
    !isValidSupportFileList(record.supportFiles) ||
    !record.target ||
    typeof record.target !== "object" ||
    typeof record.target.skillName !== "string" ||
    typeof record.target.skillKey !== "string" ||
    typeof record.target.skillDir !== "string" ||
    typeof record.target.skillFile !== "string" ||
    !record.scan ||
    typeof record.scan !== "object"
  ) {
    return null;
  }
  return record;
}

function isValidSupportFileList(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || value.length > MAX_PROPOSAL_SUPPORT_FILES) {
    return false;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const file = item as SkillProposalSupportFile;
    if (
      typeof file.path !== "string" ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(file.hash) ||
      typeof file.sizeBytes !== "number" ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES ||
      (file.targetExisted !== undefined && typeof file.targetExisted !== "boolean") ||
      (file.targetContentHash !== undefined &&
        (typeof file.targetContentHash !== "string" ||
          !/^[a-f0-9]{64}$/i.test(file.targetContentHash)))
    ) {
      return false;
    }
    let normalized: string;
    try {
      normalized = normalizeWorkspaceSkillSupportPath(file.path);
    } catch {
      return false;
    }
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
  }
  return true;
}

export function parseSkillProposalRollback(raw: unknown): SkillProposalRollback | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rollback = raw as SkillProposalRollback;
  if (
    rollback.schema !== SKILL_WORKSHOP_ROLLBACK_SCHEMA ||
    !PROPOSAL_ID_PATTERN.test(rollback.proposalId) ||
    typeof rollback.writtenAt !== "string" ||
    typeof rollback.targetSkillFile !== "string" ||
    (rollback.action !== "create" && rollback.action !== "update") ||
    (rollback.previousContentHash !== undefined &&
      (typeof rollback.previousContentHash !== "string" ||
        !/^[a-f0-9]{64}$/i.test(rollback.previousContentHash))) ||
    (rollback.previousContent !== undefined && typeof rollback.previousContent !== "string") ||
    (rollback.supportFiles !== undefined && !Array.isArray(rollback.supportFiles))
  ) {
    return null;
  }
  return rollback;
}
