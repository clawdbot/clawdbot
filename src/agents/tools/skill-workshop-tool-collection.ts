import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import {
  MAX_RECONCILED_SKILLS,
  MAX_RECONCILED_SKILL_BYTES,
  type SkillCollectionPlanEntry,
  type SkillCollectionReconcileContext,
  type SkillCollectionReconcileResult,
} from "../../skills/workshop/collection-contracts.js";
import {
  reconcileSkillCollection,
  restoreLatestSkillCollectionBackup,
} from "../../skills/workshop/collection-reconcile.js";
import { listSkillCollectionReviewOutcomes } from "../../skills/workshop/collection-review-state.js";
import { readSkillProposalTargetTreeSha256 } from "../../skills/workshop/proposal-bundle.js";
import { stringEnum } from "../schema/typebox.js";
import { readToolStringParam, ToolInputError } from "./common.js";
import { textResult } from "./tool-results.js";

const SKILL_COLLECTION_HISTORY_REASON_MAX_CHARS = 300;
const SKILL_COLLECTION_HISTORY_NAME_LIMIT = 10;
const SKILL_COLLECTION_HISTORY_TRUNCATION_MARKER = "\n(history truncated)";

function summarizeSkillNames(names: string[]) {
  const remaining = names.length - SKILL_COLLECTION_HISTORY_NAME_LIMIT;
  return {
    count: names.length,
    names: [
      ...names.slice(0, SKILL_COLLECTION_HISTORY_NAME_LIMIT),
      ...(remaining > 0 ? [`+${remaining} more`] : []),
    ],
  };
}

export async function recordSkillCollectionReadReceipt(params: {
  context: SkillCollectionReconcileContext;
  readSkillHashes: Map<string, string>;
  skill: { skillKey: string; skillFile: string; content: string };
  truncated: boolean;
}): Promise<void> {
  const bytes = Buffer.byteLength(params.skill.content);
  const readSkillBytes = params.context.readSkillBytes ?? new Map();
  const previousBytes = readSkillBytes.get(params.skill.skillKey) ?? 0;
  const readByteCount = (params.context.readByteCount ?? 0) - previousBytes + bytes;
  if (readByteCount > MAX_RECONCILED_SKILL_BYTES) {
    throw new ToolInputError(
      `skill collection exceeds the ${MAX_RECONCILED_SKILL_BYTES}-byte review limit`,
    );
  }
  readSkillBytes.set(params.skill.skillKey, bytes);
  params.context.readSkillBytes = readSkillBytes;
  params.context.readByteCount = readByteCount;
  if (params.truncated) {
    params.readSkillHashes.delete(params.skill.skillKey);
    params.context.readSkillTreeHashes?.delete(params.skill.skillKey);
    return;
  }
  params.readSkillHashes.set(params.skill.skillKey, sha256Hex(params.skill.content));
  params.context.readSkillTreeHashes?.set(
    params.skill.skillKey,
    await readSkillProposalTargetTreeSha256(path.dirname(params.skill.skillFile)),
  );
}

export const skillCollectionPlanSchema = Type.Optional(
  Type.Array(
    Type.Object(
      {
        action: stringEnum(["write", "drop"] as const),
        name: Type.String(),
        description: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    {
      maxItems: MAX_RECONCILED_SKILLS,
      description:
        "Only Workshop-generated skills to change; unlisted skills stay. write requires description and complete SKILL.md content; drop requires a reason.",
    },
  ),
);

export async function executeSkillCollectionReconcile(params: {
  toolParams: Record<string, unknown>;
  workspaceDir: string;
  readSkillHashes: ReadonlyMap<string, string>;
  context?: SkillCollectionReconcileContext;
  config: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}) {
  if (params.context?.result || params.context?.reconciling) {
    throw new ToolInputError("this skill collection has already been reconciled");
  }
  if (params.context) {
    params.context.reconciling = true;
  }
  let result: SkillCollectionReconcileResult;
  try {
    result = await reconcileSkillCollection({
      workspaceDir: params.workspaceDir,
      plan: readCollectionPlanParam(params.toolParams),
      readSkillHashes: params.readSkillHashes,
      readSkillTreeHashes: params.context?.readSkillTreeHashes ?? new Map(),
      config: params.config,
      agentId: params.agentId,
      env: params.env,
      ...(params.context?.assertCurrent ? { assertCurrent: params.context.assertCurrent } : {}),
    });
    if (params.context) {
      params.context.result = result;
    }
  } finally {
    if (params.context) {
      params.context.reconciling = false;
    }
  }
  return textResult(
    `Reconciled the skill collection: kept ${result.kept.length}, wrote ${result.written.length}, dropped ${result.dropped.length}. Backup ${result.backupId}.`,
    result,
  );
}

export async function executeSkillCollectionRestore(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}) {
  if (!params.agentId) {
    throw new ToolInputError(
      "Skill Workshop restore requires the active agent configuration and id",
    );
  }
  const result = await restoreLatestSkillCollectionBackup({
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  return textResult(
    `Restored skill collection backup ${result.backupId}: restored ${result.restored.length}, removed ${result.removed.length}.`,
    result,
  );
}

export function executeSkillCollectionHistory(
  params: {
    workspaceDir: string;
    config: OpenClawConfig;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
  },
  maxChars: number,
) {
  if (!params.agentId) {
    throw new ToolInputError("Skill Workshop history requires the active agent id");
  }
  const outcomes = listSkillCollectionReviewOutcomes(
    params.agentId,
    params.env ? { env: params.env } : {},
  );
  const reviews = [];
  let text = "Recent collection reviews, newest first:";
  let truncated = false;
  const textLimit = maxChars - SKILL_COLLECTION_HISTORY_TRUNCATION_MARKER.length;
  for (const outcome of outcomes) {
    const review = {
      createTime: new Date(outcome.createTime).toISOString(),
      backupId: outcome.backupId,
      kept: summarizeSkillNames(outcome.kept),
      written: summarizeSkillNames(outcome.written),
      dropped: outcome.dropped.map((entry) => ({
        name: entry.name,
        reason:
          entry.reason.length > SKILL_COLLECTION_HISTORY_REASON_MAX_CHARS
            ? `${truncateUtf16Safe(entry.reason, SKILL_COLLECTION_HISTORY_REASON_MAX_CHARS - 1)}…`
            : entry.reason,
      })),
    };
    const candidate = `${text}\n${JSON.stringify(review)}`;
    if (truncateUtf16Safe(candidate, textLimit) !== candidate) {
      truncated = true;
      break;
    }
    reviews.push(review);
    text = candidate;
  }
  if (truncated) {
    text = `${truncateUtf16Safe(text, textLimit)}${SKILL_COLLECTION_HISTORY_TRUNCATION_MARKER}`;
  }
  return textResult(outcomes.length === 0 ? "No recorded collection reviews." : text, {
    reviews,
    truncated,
  });
}

function readCollectionPlanParam(params: Record<string, unknown>): SkillCollectionPlanEntry[] {
  if (!Array.isArray(params.collection)) {
    throw new ToolInputError("collection required for reconcile");
  }
  return params.collection.map((value, index) => {
    const entry = asNullableRecord(value);
    if (!entry) {
      throw new ToolInputError(`collection[${index}] must be an object`);
    }
    const action = readToolStringParam(entry, "action", { required: true });
    const name = readToolStringParam(entry, "name", { required: true });
    if (action === "drop") {
      return {
        action,
        name,
        reason: readToolStringParam(entry, "reason", { required: true }),
      };
    }
    if (action === "write") {
      return {
        action,
        name,
        description: readToolStringParam(entry, "description", { required: true }),
        content: readToolStringParam(entry, "content", { required: true, trim: false }),
      };
    }
    throw new ToolInputError(`collection[${index}].action must be write or drop`);
  });
}

export const SKILL_COLLECTION_ACTION_DESCRIPTION =
  "read = inspect one current skill; reconcile = one atomic call that rewrites, creates, or drops the listed skills; unlisted skills stay.";
