import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type {
  PluginHookSkillEvaluationFinding,
  PluginHookSkillProposalEvaluateResult,
  PluginHookSkillProposalEvaluationOutcome,
} from "../../plugins/hook-types.js";
import {
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
} from "../lifecycle/workspace-skill-write.js";
import { hasValidProposalOriginProvenance } from "./proposal-origin-validation.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalEvaluation,
  type SkillProposalRecord,
  type SkillProposalRollback,
  type SkillProposalSupportFile,
} from "./types.js";

export const PROPOSAL_DRAFT_FILE = "PROPOSAL.md";
export const MAX_PROPOSAL_SUPPORT_FILES = 64;
export const MAX_SKILL_PROPOSAL_EVALUATION_BYTES = 512 * 1024;
const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/;

type SkillProposalRecordValidationError = {
  code: "invalid-proposal-metadata" | "invalid-rollback-metadata";
  message: string;
};

export function assertSkillProposalEvaluationWithinLimit(
  evaluation: SkillProposalEvaluation,
): void {
  const sizeBytes = Buffer.byteLength(JSON.stringify(evaluation), "utf8");
  if (sizeBytes > MAX_SKILL_PROPOSAL_EVALUATION_BYTES) {
    throw new Error(
      `Skill proposal evaluation exceeds ${MAX_SKILL_PROPOSAL_EVALUATION_BYTES} bytes.`,
    );
  }
}

export function assertProposalId(proposalId: string): void {
  if (!PROPOSAL_ID_PATTERN.test(proposalId)) {
    throw new Error("Invalid skill proposal id.");
  }
}

export function validateSkillProposalRecord(
  raw: unknown,
): Result<SkillProposalRecord, SkillProposalRecordValidationError> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidProposalMetadata();
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
    (record.autonomousCapture !== undefined && !record.autonomousCapture) ||
    typeof record.draftHash !== "string" ||
    record.draftFile !== PROPOSAL_DRAFT_FILE ||
    !hasValidProposalOriginProvenance(record) ||
    !isValidSupportFileList(record.supportFiles) ||
    (record.evaluation !== undefined && !parseSkillProposalEvaluation(record.evaluation)) ||
    !record.target ||
    typeof record.target !== "object" ||
    typeof record.target.skillName !== "string" ||
    typeof record.target.skillKey !== "string" ||
    typeof record.target.skillDir !== "string" ||
    typeof record.target.skillFile !== "string" ||
    !record.scan ||
    typeof record.scan !== "object"
  ) {
    return invalidProposalMetadata();
  }
  return ok(record);
}

export function parseSkillProposalRecord(raw: unknown): SkillProposalRecord | null {
  const result = validateSkillProposalRecord(raw);
  return result.ok ? result.value : null;
}

export function parseSkillProposalEvaluation(raw: unknown): SkillProposalEvaluation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as SkillProposalEvaluation;
  if (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    typeof value.proposedVersion === "string" &&
    typeof value.revisionHash === "string" &&
    /^[a-f0-9]{64}$/i.test(value.revisionHash) &&
    (value.trigger === "manual" || value.trigger === "apply") &&
    typeof value.startedAt === "string" &&
    typeof value.completedAt === "string" &&
    (value.correlationId === undefined ||
      (typeof value.correlationId === "string" &&
        value.correlationId.length > 0 &&
        Array.from(value.correlationId).length <= 256)) &&
    (value.targetTreeSha256 === undefined ||
      (typeof value.targetTreeSha256 === "string" &&
        /^[a-f0-9]{64}$/i.test(value.targetTreeSha256))) &&
    Array.isArray(value.outcomes) &&
    value.outcomes.length <= 64 &&
    value.outcomes.every(isValidEvaluationOutcome)
  ) {
    return value;
  }
  return null;
}

function isValidEvaluationOutcome(
  value: unknown,
): value is PluginHookSkillProposalEvaluationOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const outcome = value as PluginHookSkillProposalEvaluationOutcome;
  if (
    typeof outcome.evaluatorId !== "string" ||
    outcome.evaluatorId.length === 0 ||
    outcome.evaluatorId.length > 128 ||
    typeof outcome.pluginId !== "string" ||
    outcome.pluginId.length === 0 ||
    outcome.pluginId.length > 128 ||
    (outcome.pluginVersion !== undefined &&
      (typeof outcome.pluginVersion !== "string" || outcome.pluginVersion.length > 128))
  ) {
    return false;
  }
  if (outcome.status === "skipped") {
    return true;
  }
  if (outcome.status === "error") {
    return typeof outcome.error === "string" && outcome.error.length <= 2_000;
  }
  return outcome.status === "completed" && isValidEvaluationResult(outcome.result);
}

function isValidEvaluationResult(value: unknown): value is PluginHookSkillProposalEvaluateResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as PluginHookSkillProposalEvaluateResult;
  return (
    (result.summary === undefined ||
      (typeof result.summary === "string" && result.summary.length <= 8_000)) &&
    (result.evaluatorVersion === undefined ||
      (typeof result.evaluatorVersion === "string" && result.evaluatorVersion.length <= 128)) &&
    (result.mode === undefined || (typeof result.mode === "string" && result.mode.length <= 128)) &&
    (result.decision === undefined || ["pass", "revise", "block"].includes(result.decision)) &&
    (result.decisionReason === undefined ||
      (typeof result.decisionReason === "string" && result.decisionReason.length <= 2_000)) &&
    isValidEvaluationFindings(result.findings) &&
    isValidEvaluationMetrics(result.metrics)
  );
}

function isValidEvaluationFindings(value: PluginHookSkillEvaluationFinding[] | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every(
      (finding) =>
        finding &&
        typeof finding === "object" &&
        typeof finding.ruleId === "string" &&
        finding.ruleId.length > 0 &&
        finding.ruleId.length <= 256 &&
        ["info", "warn", "critical"].includes(finding.severity) &&
        typeof finding.message === "string" &&
        finding.message.length > 0 &&
        finding.message.length <= 4_000 &&
        (finding.file === undefined ||
          (typeof finding.file === "string" && finding.file.length <= 1_024)) &&
        (finding.line === undefined || (Number.isSafeInteger(finding.line) && finding.line >= 1)),
    )
  );
}

function isValidEvaluationMetrics(
  value: Record<string, string | number | boolean> | undefined,
): boolean {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(
      ([key, metric]) =>
        key.length > 0 &&
        key.length <= 128 &&
        ((typeof metric === "string" && metric.length <= 4_000) ||
          (typeof metric === "number" && Number.isFinite(metric)) ||
          typeof metric === "boolean"),
    )
  );
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

export function validateSkillProposalRollback(
  raw: unknown,
): Result<SkillProposalRollback, SkillProposalRecordValidationError> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidRollbackMetadata();
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
    return invalidRollbackMetadata();
  }
  return ok(rollback);
}

export function parseSkillProposalRollback(raw: unknown): SkillProposalRollback | null {
  const result = validateSkillProposalRollback(raw);
  return result.ok ? result.value : null;
}

function invalidProposalMetadata(): Result<
  SkillProposalRecord,
  SkillProposalRecordValidationError
> {
  return err({
    code: "invalid-proposal-metadata",
    message: "invalid proposal metadata",
  });
}

function invalidRollbackMetadata(): Result<
  SkillProposalRollback,
  SkillProposalRecordValidationError
> {
  return err({
    code: "invalid-rollback-metadata",
    message: "invalid rollback metadata",
  });
}
