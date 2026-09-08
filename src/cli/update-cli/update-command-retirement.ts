import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import {
  retireUpdateCheckpoint,
  retireUpdateCheckpointPreimages,
} from "../../infra/update-checkpoint.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import { UpdateRecoveryRecordSchema } from "../../infra/update-run-recovery-schema.js";
import {
  assertExactUpdateRecoveryClaim,
  claimUpdateRecovery,
  inspectUpdateRecoveries,
  type UpdateRecoveryRecord,
} from "../../infra/update-run-recovery.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";

function retirementCopies(record: UpdateRecoveryRecord) {
  const copies = [
    ...(record.preimages ? [{ ...record.preimages, purpose: "preimage" as const }] : []),
    ...(record.checkpoint ? [{ ...record.checkpoint, purpose: "checkpoint" as const }] : []),
    ...(record.afterImages ?? []).map((image) => ({
      ref: image.afterUpdate.ref,
      binding: image.afterUpdate.binding,
      purpose: "checkpoint" as const,
    })),
  ];
  const unique = new Map<string, (typeof copies)[number]>();
  for (const copy of copies) {
    const previous = unique.get(copy.ref.manifestPath);
    if (previous && !isDeepStrictEqual(previous, copy)) {
      throw new Error("Conflicting retained checkpoint references");
    }
    unique.set(copy.ref.manifestPath, copy);
  }
  return [...unique.values()];
}
async function absent(directory: string) {
  try {
    await fs.lstat(directory);
    return false;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

/** Called while the replacement's actual serving connection/source/executor are
 * still held. The old terminal receipt is history, never retirement authority.
 * Checkpoint deletion joins the SAME package retirement intent before its final
 * observation, so interruption remains replayable instead of looking complete. */
export async function retireSupersededUpdateCommandPair(
  recovery: UpdateCommandRecovery,
): Promise<void> {
  const selected = recovery.getRecord();
  const assertReplacement = () => {
    if (recovery.fence.assertCurrent() !== undefined || recovery.assertReady() !== undefined) {
      throw new UpdateCommandRecoveryPendingError(
        "Retirement readiness must complete synchronously.",
      );
    }
    if (
      !isDeepStrictEqual(recovery.getRecord(), selected) ||
      selected.terminal?.status !== "succeeded" ||
      selected.retainedPair?.state !== "selected" ||
      selected.package?.descriptor.retention?.state !== "selected"
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Retirement requires the current selected serving pair.",
      );
    }
    assertExactUpdateRecoveryClaim(selected, recovery.fence, recovery.options);
  };
  assertReplacement();
  for (const inspected of inspectUpdateRecoveries(recovery.options)) {
    if (
      inspected.format !== "current" ||
      inspected.record.retainedPair?.state !== "superseded" ||
      inspected.record.retainedPair.replacementRunId !== selected.runId
    ) {
      continue;
    }
    let old = UpdateRecoveryRecordSchema.parse(inspected.record);
    const decision = old.package?.descriptor.retention;
    if (
      old.terminal?.status !== "succeeded" ||
      !old.checkpoint ||
      old.restore ||
      decision?.state !== "superseded" ||
      old.from.root !== selected.from.root ||
      decision.replacement.transactionId !== selected.transactionId ||
      decision.replacement.pairId !== selected.retainedPair!.pairId ||
      !isDeepStrictEqual(decision.replacement.live, selected.package!.descriptor.candidate) ||
      !isDeepStrictEqual(decision.replacement.retained, selected.package!.descriptor.previous) ||
      decision.replacement.retainedRoot !== selected.package!.descriptor.backupRoot
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Superseded pair does not match the selected replacement.",
      );
    }
    const copies = retirementCopies(old);
    const last = old.effects.at(-1);
    const copiesAbsent = (
      await Promise.all(copies.map((copy) => absent(path.dirname(copy.ref.manifestPath))))
    ).every(Boolean);
    assertReplacement();
    if (
      last?.kind === "retirement" &&
      last.state === "observed" &&
      last.package?.outcome === "completed" &&
      copiesAbsent
    ) {
      continue;
    }
    old = claimUpdateRecovery(old, { assertCurrent: assertReplacement }, recovery.options);
    const assertCurrent = () => {
      assertReplacement();
      assertExactUpdateRecoveryClaim(old, { assertCurrent: assertReplacement }, recovery.options);
    };
    const hooks = createUpdateRecoveryPackageHooks({
      getRecord: () => old,
      onRecord(next) {
        old = next;
      },
      fence: { assertCurrent: assertReplacement },
      options: recovery.options,
    });
    const pending = old.effects.at(-1);
    if (pending?.state === "intent" && pending.package?.intent.action !== "retire") {
      throw new UpdateCommandRecoveryPendingError(
        "Superseded material has an unrelated pending effect.",
      );
    }
    const opened = await reopenPackageUpdateTransaction({
      descriptor: old.package!.descriptor,
      expectedLiveRoot: old.from.root,
      expectedBinDir: old.package!.descriptor.binDir,
      expectedTransactionId: old.transactionId,
      pendingEffect: pending?.state === "intent" ? pending.package?.intent : undefined,
      hooks: {
        ...hooks,
        async beforeEffect(effect, context) {
          const receipt = await hooks.beforeEffect(effect, context);
          return {
            assertCurrent: () => receipt.assertCurrent(),
            async afterEffect(observed, outcome) {
              if (effect.action !== "retire" || outcome !== "completed") {
                throw new UpdateCommandRecoveryPendingError(
                  "Checkpoint retirement requires completed package retirement.",
                );
              }
              for (const copy of copies) {
                assertCurrent();
                receipt.assertCurrent();
                const artifactRoot = path.join(
                  path.dirname(copy.binding.stateDir),
                  `.${path.basename(copy.binding.stateDir)}-update-checkpoints`,
                );
                const access = {
                  artifactRoot,
                  binding: copy.binding,
                  assertQuiescent: assertCurrent,
                  assertSuperseded: assertCurrent,
                };
                if (copy.purpose === "preimage") {
                  await retireUpdateCheckpointPreimages(copy.ref, access);
                } else {
                  await retireUpdateCheckpoint(copy.ref, access);
                }
                assertCurrent();
                if (!(await absent(path.dirname(copy.ref.manifestPath)))) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Checkpoint retirement left unresolved material.",
                  );
                }
              }
              await receipt.afterEffect(observed, outcome);
            },
          };
        },
      },
    });
    assertCurrent();
    if (opened.status !== "ready") {
      throw new UpdateCommandRecoveryPendingError("Superseded package custody is unavailable.");
    }
    const retired = await opened.transaction.retire(decision);
    assertCurrent();
    if (retired.status !== "verified") {
      throw new UpdateCommandRecoveryPendingError("Superseded pair retirement remains pending.");
    }
  }
  assertReplacement();
}
