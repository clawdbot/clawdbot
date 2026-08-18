import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
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
import { readSkillProposalTargetTreeSha256 } from "../../skills/workshop/proposal-bundle.js";
import { stringEnum } from "../schema/typebox.js";
import { readToolStringParam, ToolInputError } from "./common.js";

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
        action: stringEnum(["keep", "write", "drop"] as const),
        name: Type.String(),
        description: Type.Optional(Type.String({ maxLength: 160 })),
        content: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    {
      maxItems: MAX_RECONCILED_SKILLS,
      description:
        "Exactly one decision for every current skill, plus optional new write decisions. Skills not created by Skill Workshop are read-only and require keep. write requires description and complete SKILL.md content; drop requires a reason.",
    },
  ),
);

export async function executeSkillCollectionReconcile(params: {
  toolParams: Record<string, unknown>;
  workspaceDir: string;
  readSkillHashes: ReadonlyMap<string, string>;
  context?: SkillCollectionReconcileContext;
  config?: OpenClawConfig;
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
      agentIds: params.context?.agentIds,
      approvedSkillNamesByAgent: params.context?.approvedSkillNamesByAgent,
      env: params.env,
    });
    if (params.context) {
      params.context.result = result;
    }
  } finally {
    if (params.context) {
      params.context.reconciling = false;
    }
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Reconciled the skill collection: kept ${result.kept.length}, wrote ${result.written.length}, dropped ${result.dropped.length}. Backup ${result.backupId}.`,
      },
    ],
    details: result,
  };
}

export async function executeSkillCollectionRestore(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}) {
  const result = await restoreLatestSkillCollectionBackup(params);
  return {
    content: [
      {
        type: "text" as const,
        text: `Restored skill collection backup ${result.backupId}: restored ${result.restored.length}, removed ${result.removed.length}.`,
      },
    ],
    details: result,
  };
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
    if (action === "keep") {
      return { action, name };
    }
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
    throw new ToolInputError(`collection[${index}].action must be keep, write, or drop`);
  });
}

export const SKILL_COLLECTION_ACTION_DESCRIPTION =
  "read = inspect one current skill; reconcile = atomically keep, rewrite, create, or drop the whole writable skill collection.";
