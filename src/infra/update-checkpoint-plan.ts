import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { sha256Hex } from "./crypto-digest.js";
import { checkpointContentMatches } from "./update-checkpoint-files.js";
import {
  CheckpointFileStateSchema,
  reopenUpdateCheckpoint,
  UpdateCheckpointRefSchema,
  type UpdateCheckpointReadAccess,
} from "./update-checkpoint.js";
import type { UpdateRecoveryDatabaseBinding } from "./update-run-recovery.js";

const databaseBindingSchema: z.ZodType<UpdateRecoveryDatabaseBinding> = z
  .object({
    runId: z.string().uuid(),
    transactionId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const sharedBindingSchema = z
  .object({
    sourceBinding: databaseBindingSchema,
    stagedBinding: databaseBindingSchema,
  })
  .strict();
export const planSchema = z
  .object({
    restoreId: z.string().uuid(),
    checkpointRef: UpdateCheckpointRefSchema,
    afterUpdateRef: UpdateCheckpointRefSchema,
    resources: z.array(
      z
        .object({
          sourcePath: z.string(),
          stageDirectory: z.string(),
          before: CheckpointFileStateSchema.nullable(),
          after: CheckpointFileStateSchema.nullable(),
          sqlite: z.boolean(),
          userVersion: z.number().int().nullable(),
          recovery: sharedBindingSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
/** Discoverable preparation locator, not a sealed plan or publication authority. */
export const UpdateCheckpointRestorePlanIdentitySchema = z
  .object({
    restoreId: z.string().uuid(),
    checkpointId: z.string().uuid(),
    planPath: z.string(),
  })
  .strict();
export type UpdateCheckpointRestorePlanIdentity = z.infer<
  typeof UpdateCheckpointRestorePlanIdentitySchema
>;
export const UpdateCheckpointRestorePlanRefSchema =
  UpdateCheckpointRestorePlanIdentitySchema.extend({
    planSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict();
export type UpdateCheckpointRestorePlanRef = z.infer<typeof UpdateCheckpointRestorePlanRefSchema>;
type RestorePlan = z.infer<typeof planSchema>;
export type RestoreResource = RestorePlan["resources"][number];
export function assertSqliteFamilyClosed(file: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (fsSync.existsSync(`${file}${suffix}`)) {
      throw new Error(`SQLite writers/readers must close before checkpoint publication: ${file}`);
    }
  }
}
export function sameIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: fsSync.Stats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Read-only reopening is allowed before recovery has acquired a mutation claim. */
export async function reopenUpdateCheckpointRestorePlan(
  ref: UpdateCheckpointRestorePlanRef,
  access: UpdateCheckpointReadAccess,
) {
  UpdateCheckpointRestorePlanRefSchema.parse(ref);
  const expected = path.join(
    access.artifactRoot,
    ref.checkpointId,
    `restore-${ref.restoreId}.json`,
  );
  if (ref.planPath !== expected || (await fs.realpath(expected)) !== expected) {
    throw new Error("Restore plan path mismatch");
  }
  const stat = await fs.lstat(expected);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
    throw new Error("Invalid restore plan file");
  }
  const bytes = await fs.readFile(expected, "utf8");
  if (sha256Hex(bytes) !== ref.planSha256) {
    throw new Error("Restore plan digest mismatch");
  }
  const plan = planSchema.parse(JSON.parse(bytes));
  if (plan.restoreId !== ref.restoreId || plan.checkpointRef.checkpointId !== ref.checkpointId) {
    throw new Error("Restore plan identity mismatch");
  }
  const checkpoint = await reopenUpdateCheckpoint(plan.checkpointRef, access);
  const afterUpdate = await reopenUpdateCheckpoint(plan.afterUpdateRef, access);
  const remaining = new Set(
    checkpoint.manifest.resources
      .filter((entry) => entry.restore === "replace")
      .map((entry) => entry.sourcePath),
  );
  for (const resource of plan.resources) {
    const index = checkpoint.manifest.resources.findIndex(
      (entry) => entry.sourcePath === resource.sourcePath,
    );
    const captured = checkpoint.manifest.resources[index];
    if (
      !captured ||
      !remaining.delete(resource.sourcePath) ||
      resource.sqlite !== (captured.kind === "sqlite") ||
      resource.userVersion !== captured.userVersion ||
      resource.stageDirectory !==
        path.join(path.dirname(resource.sourcePath), `.openclaw-restore-${ref.restoreId}-${index}`)
    ) {
      throw new Error("Restore resource binding mismatch");
    }
    if (
      resource.recovery &&
      (!resource.sqlite ||
        resource.sourcePath !== path.join(access.binding.stateDir, "state", "openclaw.sqlite") ||
        plan.resources[0] !== resource ||
        resource.recovery.sourceBinding.runId !== access.binding.runId ||
        resource.recovery.stagedBinding.runId !== access.binding.runId ||
        resource.recovery.sourceBinding.transactionId !==
          resource.recovery.stagedBinding.transactionId)
    ) {
      throw new Error("Restore recovery binding mismatch");
    }
    if (!resource.sqlite) {
      const mutation = afterUpdate.manifest.resources.find(
        (entry) => entry.sourcePath === captured.sourcePath && entry.kind === captured.kind,
      );
      // Replays bypass preparation. Validate the owner-bound source facts here
      // too; a digest-valid older plan must not adopt a late observed after-image.
      if (
        mutation?.sourceBindingValidated !== true ||
        (!isDeepStrictEqual(resource.before, mutation.sourceState) &&
          !isDeepStrictEqual(resource.before, captured.sourceState))
      ) {
        throw new Error("Restore plan lacks an owner-bound after-image");
      }
      if (!checkpointContentMatches(resource.after, captured.captured)) {
        throw new Error("Restore target does not match checkpoint");
      }
    }
  }
  if (remaining.size !== 0) {
    throw new Error("Restore plan is missing checkpoint resources");
  }
  return {
    ref,
    plan,
    binding: checkpoint.manifest.binding,
    exclusions: checkpoint.manifest.exclusions,
  };
}
