import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { z } from "zod";
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
} from "./types.js";

export const PROPOSAL_DRAFT_FILE = "PROPOSAL.md";
export const MAX_PROPOSAL_SUPPORT_FILES = 64;
export const MAX_SKILL_PROPOSAL_EVALUATION_BYTES = 512 * 1024;
const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/;
const PROPOSAL_DRAFT_FILE_PATTERN =
  /^(?:PROPOSAL\.md|generations\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/PROPOSAL\.md)$/u;

type SkillProposalRecordValidationError = {
  code: "invalid-proposal-metadata" | "invalid-rollback-metadata";
  message: string;
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const skillProposalFindingSchema = z.looseObject({
  ruleId: z.string().min(1).max(256),
  severity: z.enum(["info", "warn", "critical"]),
  message: z.string().min(1).max(4_000),
  file: z.string().max(1_024).optional(),
  line: z
    .number()
    .refine(Number.isSafeInteger)
    .refine((value) => value >= 1)
    .optional(),
});
const skillProposalMetricValueSchema = z.union([
  z.string().max(4_000),
  z.number().finite(),
  z.boolean(),
]);
const skillProposalMetricsSchema = z
  .custom<Record<string, unknown>>(isRecord)
  .transform((metrics) => new Map(Object.entries(metrics)))
  .pipe(z.map(z.string().min(1).max(128), skillProposalMetricValueSchema))
  .refine((metrics) => metrics.size <= 64);
const skillProposalEvaluationResultSchema = z.looseObject({
  summary: z.string().max(8_000).optional(),
  evaluatorVersion: z.string().max(128).optional(),
  mode: z.string().max(128).optional(),
  decision: z.enum(["pass", "revise", "block"]).optional(),
  decisionReason: z.string().max(2_000).optional(),
  findings: z.array(skillProposalFindingSchema).max(200).optional(),
  metrics: skillProposalMetricsSchema.optional(),
});
const skillProposalEvaluationOutcomeBaseShape = {
  evaluatorId: z.string().min(1).max(128),
  pluginId: z.string().min(1).max(128),
  pluginVersion: z.string().max(128).optional(),
};
const skillProposalEvaluationOutcomeSchema = z.discriminatedUnion("status", [
  z.looseObject({ ...skillProposalEvaluationOutcomeBaseShape, status: z.literal("skipped") }),
  z.looseObject({
    ...skillProposalEvaluationOutcomeBaseShape,
    status: z.literal("error"),
    error: z.string().max(2_000),
  }),
  z.looseObject({
    ...skillProposalEvaluationOutcomeBaseShape,
    status: z.literal("completed"),
    result: skillProposalEvaluationResultSchema,
  }),
]);
const skillProposalEvaluationSchema = z.looseObject({
  id: z.string().min(1).max(128),
  proposedVersion: z.string(),
  revisionHash: sha256Schema,
  trigger: z.enum(["manual", "apply"]),
  startedAt: z.string(),
  completedAt: z.string(),
  correlationId: z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= 256)
    .optional(),
  targetTreeSha256: sha256Schema.optional(),
  outcomes: z.array(skillProposalEvaluationOutcomeSchema).max(64),
});
const skillProposalSupportFileSchema = z.looseObject({
  path: z.string(),
  hash: sha256Schema,
  sizeBytes: z
    .number()
    .refine(Number.isSafeInteger)
    .refine((value) => value >= 0 && value <= MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES),
  targetExisted: z.boolean().optional(),
  targetContentHash: sha256Schema.optional(),
});
const skillProposalSupportFilesSchema = z
  .array(skillProposalSupportFileSchema)
  .max(MAX_PROPOSAL_SUPPORT_FILES)
  .superRefine((files, context) => {
    const seen = new Set<string>();
    for (const [index, file] of files.entries()) {
      let normalized: string;
      try {
        normalized = normalizeWorkspaceSkillSupportPath(file.path);
      } catch {
        context.addIssue({
          code: "custom",
          message: "invalid support path",
          path: [index, "path"],
        });
        continue;
      }
      if (seen.has(normalized)) {
        context.addIssue({
          code: "custom",
          message: "duplicate support path",
          path: [index, "path"],
        });
      }
      seen.add(normalized);
    }
  });
const skillProposalRecordSchema = z
  .looseObject({
    schema: z.literal(SKILL_WORKSHOP_SCHEMA),
    id: z.string().regex(PROPOSAL_ID_PATTERN),
    kind: z.enum(["create", "update"]),
    status: z.enum(["pending", "applied", "rejected", "quarantined", "stale"]),
    title: z.string(),
    description: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    autonomousCapture: z.literal(true).optional(),
    draftHash: z.string(),
    draftFile: z.string().regex(PROPOSAL_DRAFT_FILE_PATTERN),
    origin: z.unknown().optional(),
    originRunIds: z.unknown().optional(),
    originRunMutationCounts: z.unknown().optional(),
    supportFiles: skillProposalSupportFilesSchema.optional(),
    evaluation: skillProposalEvaluationSchema.optional(),
    target: z.looseObject({
      skillName: z.string(),
      skillKey: z.string(),
      skillDir: z.string(),
      skillFile: z.string(),
    }),
    scan: z.custom<object>((value) => value !== null && typeof value === "object"),
  })
  .refine(hasValidProposalOriginProvenance);
const skillProposalRollbackSchema = z.looseObject({
  schema: z.literal(SKILL_WORKSHOP_ROLLBACK_SCHEMA),
  proposalId: z.string().regex(PROPOSAL_ID_PATTERN),
  writtenAt: z.string(),
  targetSkillFile: z.string(),
  action: z.enum(["create", "update"]),
  previousContentHash: sha256Schema.optional(),
  previousContent: z.string().optional(),
  supportFiles: z.array(z.unknown()).optional(),
});

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
  if (!skillProposalRecordSchema.safeParse(raw).success) {
    return invalidMetadata("proposal");
  }
  return ok(raw as SkillProposalRecord);
}

export function parseSkillProposalRecord(raw: unknown): SkillProposalRecord | null {
  const result = validateSkillProposalRecord(raw);
  return result.ok ? result.value : null;
}

export function parseSkillProposalEvaluation(raw: unknown): SkillProposalEvaluation | null {
  return skillProposalEvaluationSchema.safeParse(raw).success
    ? (raw as SkillProposalEvaluation)
    : null;
}

export function validateSkillProposalRollback(
  raw: unknown,
): Result<SkillProposalRollback, SkillProposalRecordValidationError> {
  if (!skillProposalRollbackSchema.safeParse(raw).success) {
    return invalidMetadata("rollback");
  }
  return ok(raw as SkillProposalRollback);
}

export function parseSkillProposalRollback(raw: unknown): SkillProposalRollback | null {
  const result = validateSkillProposalRollback(raw);
  return result.ok ? result.value : null;
}

function invalidMetadata<T>(
  kind: "proposal" | "rollback",
): Result<T, SkillProposalRecordValidationError> {
  return err({
    code: `invalid-${kind}-metadata`,
    message: `invalid ${kind} metadata`,
  });
}
