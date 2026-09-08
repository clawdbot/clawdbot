import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { PackageRecoveryVerified } from "./package-update-recovery.js";
import { finishVerifiedUpdateRunInTransaction } from "./update-run-ledger.js";
import { UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import { parseRecoveryPackageObservation } from "./update-run-recovery-package-schema.js";
import {
  encodeUpdateRecovery,
  UpdateRecoveryConflictError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import { mutateRecovery, readRecoveries, requireRevision } from "./update-run-recovery-store.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

/**
 * Executor must finish awaited package/checkpoint/readiness verification first.
 * assertReady revalidates that live authority and current final proof synchronously
 * inside the same transaction. Neither persisted receipts nor package roles are
 * service authority. No filesystem retirement occurs in this function.
 */
export function commitUpdateRecoveryTerminal(
  expected: UpdateRecoveryRecord,
  input: {
    status: "succeeded" | "rolled-back";
    package: PackageRecoveryVerified;
    assertReady: () => void;
  },
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  const observed = parseRecoveryPackageObservation(input.package);
  return mutateRecovery(
    expected,
    fence,
    (record, db) => {
      const verification = record.verification;
      const runtime = input.status === "succeeded" ? "candidate" : "previous";
      const identity = runtime === "candidate" ? record.to : record.from;
      const restart = record.effects.at(-1);
      const packageEffect = record.effects.findLast((effect) => effect.package)?.package;
      if (
        !isDeepStrictEqual(record, expected) ||
        !record.package ||
        !record.checkpoint ||
        !isDeepStrictEqual(record.package.descriptor, observed.descriptor) ||
        observed.descriptor.retention !== null ||
        !verification ||
        verification.runtime !== runtime ||
        verification.receipt.runId !== record.runId ||
        verification.receipt.transactionId !== record.transactionId ||
        verification.receipt.claimId !== record.claimId ||
        verification.receipt.revision + 1 !== record.revision ||
        verification.receipt.runtime !== runtime ||
        verification.receipt.effectId !== verification.effectId ||
        verification.receipt.gateway.version !== identity.version ||
        verification.receipt.gateway.buildId !== identity.buildId ||
        restart?.kind !== "service-restart" ||
        restart.state !== "observed" ||
        restart.effectId !== verification.effectId ||
        restart.observedIdentity !== verification.receipt.gateway.bootId ||
        record.effects.some((effect) => effect.state === "intent") ||
        packageEffect?.outcome !== "completed" ||
        packageEffect.intent.action !== (runtime === "candidate" ? "activate" : "restore") ||
        !record.effects.some(
          (effect) =>
            effect.package?.intent.action === (runtime === "candidate" ? "activate" : "restore") &&
            effect.package.outcome === "completed",
        ) ||
        (input.status === "succeeded"
          ? record.primaryFailure !== null
          : !record.primaryFailure ||
            !record.effects.some(
              (effect) => effect.kind === "checkpoint-restore" && effect.state === "observed",
            )) ||
        observed.observation.successorLive ||
        observed.observation.previous !==
          (observed.descriptor.previous
            ? runtime === "candidate"
              ? "retained"
              : "live"
            : "absent") ||
        (runtime === "candidate"
          ? observed.observation.candidate !== "live"
          : observed.observation.candidate === "live") ||
        ![runtime, "both"].includes(observed.observation.launchers)
      ) {
        throw new UpdateRecoveryConflictError();
      }
      if (input.assertReady() !== undefined) {
        throw new Error("Terminal readiness must complete synchronously");
      }
      const selected = readRecoveries(db).filter(
        (entry) => entry.retainedPair?.state === "selected",
      );
      if (selected.length > 1) {
        throw new UpdateRecoveryConflictError();
      }
      const prior = selected[0];
      const revision = record.revision + 1;
      const pairId = input.status === "succeeded" ? randomUUID() : null;
      record.terminal = {
        status: input.status,
        committedAtMs: Date.now(),
        commitRevision: revision,
        receipt: verification.receipt,
        pairId,
      };
      record.package.observed = observed;
      if (pairId) {
        const descriptor = record.package.descriptor;
        if (!descriptor.previous || record.restore || !record.afterImages?.length) {
          throw new UpdateRecoveryConflictError();
        }
        // Require an after-image for every mutation before the final serving restart.
        const covered = record.afterImages.flatMap((image) => image.effectIds);
        if (
          !isDeepStrictEqual(
            covered,
            record.effects.slice(0, -1).map((effect) => effect.effectId),
          )
        ) {
          throw new UpdateRecoveryConflictError();
        }
        record.retainedPair = { pairId, state: "selected" };
        descriptor.retention = { state: "selected", pairId, ownerRevision: revision };
        if (prior) {
          if (
            !prior.terminal ||
            !prior.package ||
            !prior.retainedPair ||
            prior.effects.some((effect) => effect.state === "intent") ||
            !isDeepStrictEqual(prior.package.descriptor.candidate, descriptor.previous) ||
            prior.package.descriptor.liveRoot !== descriptor.liveRoot ||
            prior.package.descriptor.binDir !== descriptor.binDir
          ) {
            throw new UpdateRecoveryConflictError();
          }
          const { raw } = requireRevision(db, prior);
          prior.revision++;
          prior.updatedAtMs = Math.max(Date.now(), prior.updatedAtMs + 1);
          prior.retainedPair = {
            ...prior.retainedPair,
            state: "superseded",
            replacementRunId: record.runId,
          };
          prior.package.descriptor.retention = {
            state: "superseded",
            pairId: prior.retainedPair.pairId,
            ownerRevision: prior.revision,
            replacement: {
              pairId,
              transactionId: record.transactionId,
              live: descriptor.candidate,
              retainedRoot: descriptor.backupRoot,
              retained: descriptor.previous,
              launchers: descriptor.launchers.map((entry) => ({
                name: entry.name,
                fingerprint: entry.candidate,
              })),
            },
          };
          const changed = executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "config_machine_state">>(db)
              .updateTable("config_machine_state")
              .set({ value_json: encodeUpdateRecovery(prior), updated_at_ms: prior.updatedAtMs })
              .where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + prior.runId)
              .where("value_json", "=", raw),
          );
          if (changed.numAffectedRows !== 1n) {
            throw new UpdateRecoveryConflictError();
          }
        }
      } else {
        // A failed update cannot replace the previously selected pair.
        record.package.descriptor.retention = { state: "unselected", ownerRevision: revision };
      }
      finishVerifiedUpdateRunInTransaction(
        db,
        record.runId,
        {
          status: input.status,
          receipt: verification.receipt,
          ...(record.primaryFailure ? { reason: record.primaryFailure.code } : {}),
        },
        options,
      );
      if (input.assertReady() !== undefined) {
        throw new Error("Terminal readiness must complete synchronously");
      }
    },
    options,
  );
}
