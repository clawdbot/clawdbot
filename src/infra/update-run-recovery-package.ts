import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  PackageRecoveryEffectSchema,
  type PackageRecoveryHooks,
  type PackageRecoveryVerified,
} from "./package-update-recovery.js";
import {
  parseRecoveryPackageObservation,
  sameRecoveryPackage,
} from "./update-run-recovery-package-schema.js";
import {
  UpdateRecoveryConflictError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import { mutateRecovery, readRecoveries } from "./update-run-recovery-store.js";
import { assertExactUpdateRecoveryClaim, type UpdateRecoveryFence } from "./update-run-recovery.js";

function assertPackage(record: UpdateRecoveryRecord, observed: PackageRecoveryVerified): void {
  const descriptor = observed.descriptor;
  if (
    descriptor.transactionId !== record.transactionId ||
    descriptor.liveRoot !== record.from.root ||
    descriptor.candidate.version !== record.to.version ||
    (descriptor.previous && descriptor.previous.version !== record.from.version) ||
    (record.package && !sameRecoveryPackage(record.package.descriptor, descriptor))
  ) {
    throw new UpdateRecoveryConflictError();
  }
}

/**
 * Actual package-owner hooks. The executor carries returned records across its
 * other writers; no identity or receipt substitutes for the live fence.
 * Descriptor/intent/outcome are committed atomically in the existing shared DB.
 */
export function createUpdateRecoveryPackageHooks(params: {
  getRecord: () => UpdateRecoveryRecord;
  onRecord: (record: UpdateRecoveryRecord) => void;
  fence: UpdateRecoveryFence;
  options?: OpenClawStateDatabaseOptions;
}): PackageRecoveryHooks {
  const { fence } = params;
  const options = params.options ?? {};
  const transactionId = params.getRecord().transactionId;
  const accept = (record: UpdateRecoveryRecord) => {
    params.onRecord(record);
    return () => assertExactUpdateRecoveryClaim(record, fence, options);
  };
  return {
    transactionId,
    async persistDescriptor(input) {
      const observed = parseRecoveryPackageObservation(input);
      const record = mutateRecovery(
        params.getRecord(),
        fence,
        (current) => {
          assertPackage(current, observed);
          if (current.effects.some((effect) => effect.state === "intent")) {
            throw new UpdateRecoveryConflictError();
          }
          // Retention is a replay of an ALREADY committed decision, never a selector.
          if (
            observed.descriptor.retention !== null &&
            (!current.terminal ||
              !isDeepStrictEqual(
                observed.descriptor.retention,
                current.package?.descriptor.retention,
              ))
          ) {
            throw new UpdateRecoveryConflictError();
          }
          if (
            current.package &&
            !isDeepStrictEqual(observed.descriptor, current.package.descriptor)
          ) {
            throw new UpdateRecoveryConflictError();
          }
          if (
            !current.package &&
            (current.terminal ||
              current.effects.length ||
              observed.descriptor.retention ||
              observed.observation.candidate !== "staged" ||
              observed.observation.previous !== (observed.descriptor.previous ? "live" : "absent"))
          ) {
            throw new UpdateRecoveryConflictError();
          }
          current.package = { descriptor: observed.descriptor, observed };
        },
        options,
        false,
        true,
      );
      return { assertCurrent: accept(record) };
    },
    async beforeEffect(input, context) {
      const effect = PackageRecoveryEffectSchema.parse(input);
      const observed = parseRecoveryPackageObservation(context.observed);
      let accepted = params.getRecord();
      const found = accepted.effects.find((entry) => entry.effectId === effect.effectId);
      if (found && context.mode === "resume") {
        // This includes a committed observation whose acknowledgement was lost.
        // Reacquire the SAME effect; afterEffect verifies the exact prior outcome.
        assertExactUpdateRecoveryClaim(accepted, fence, options);
        if (
          !found.package ||
          !isDeepStrictEqual(found.package.intent, effect) ||
          accepted.effects.at(-1)?.effectId !== effect.effectId
        ) {
          throw new UpdateRecoveryConflictError();
        }
      } else {
        accepted = mutateRecovery(
          accepted,
          fence,
          (current, db) => {
            assertPackage(current, observed);
            if (
              !current.package ||
              !isDeepStrictEqual(effect.descriptor, current.package.descriptor) ||
              !isDeepStrictEqual(observed.descriptor, effect.descriptor) ||
              current.effects.some(
                (entry) => entry.state === "intent" || entry.effectId === effect.effectId,
              )
            ) {
              throw new UpdateRecoveryConflictError();
            }
            if (effect.action === "retire") {
              const decision = effect.descriptor.retention;
              const selected = readRecoveries(db).filter(
                (entry) => entry.retainedPair?.state === "selected",
              );
              if (
                decision?.state === "superseded" &&
                (selected.length !== 1 ||
                  selected[0]?.retainedPair?.pairId !== decision.replacement.pairId ||
                  selected[0]?.transactionId !== decision.replacement.transactionId)
              ) {
                throw new UpdateRecoveryConflictError();
              }

              if (
                !current.terminal ||
                !effect.descriptor.retention ||
                effect.descriptor.retention.state === "selected"
              ) {
                throw new UpdateRecoveryConflictError();
              }
            } else if (current.terminal || (effect.action === "activate" && !current.checkpoint)) {
              throw new UpdateRecoveryConflictError();
            }
            current.effects.push({
              effectId: effect.effectId,
              kind:
                effect.action === "activate"
                  ? "package-activation"
                  : effect.action === "restore"
                    ? "package-restore"
                    : "retirement",
              resourceId: effect.descriptor.liveRoot,
              runtime: effect.action === "activate" ? "candidate" : "previous",
              state: "intent",
              observedIdentity: null,
              package: { intent: effect },
            });
            current.package.observed = observed;
            if (effect.action !== "retire") {
              current.verification = null;
            }
          },
          options,
          false,
          true,
        );
        params.onRecord(accepted);
      }
      const assertCurrent = () => assertExactUpdateRecoveryClaim(accepted, fence, options);
      return {
        assertCurrent,
        async afterEffect(value, outcome) {
          const after = parseRecoveryPackageObservation(value);
          if (outcome === "completed") {
            const roles = after.observation;
            const coherent =
              effect.action === "activate"
                ? roles.candidate === "live" &&
                  roles.previous === (after.descriptor.previous ? "retained" : "absent") &&
                  ["candidate", "both"].includes(roles.launchers)
                : effect.action === "restore"
                  ? roles.previous === (after.descriptor.previous ? "live" : "absent") &&
                    roles.candidate !== "live" &&
                    ["previous", "both"].includes(roles.launchers)
                  : roles.candidate === "absent" &&
                    (after.descriptor.retention?.state === "superseded"
                      ? roles.previous === "absent" && roles.successorLive
                      : roles.previous === (after.descriptor.previous ? "live" : "absent"));
            if (!coherent) {
              throw new UpdateRecoveryConflictError();
            }
          }
          assertCurrent();
          const entry = accepted.effects.at(-1);
          if (entry?.state === "observed") {
            if (
              !entry.package ||
              entry.package.outcome !== outcome ||
              !isDeepStrictEqual(entry.package.observed, after)
            ) {
              throw new UpdateRecoveryConflictError();
            }
            return;
          }
          const next = mutateRecovery(
            accepted,
            fence,
            (current) => {
              assertPackage(current, after);
              const pending = current.effects.at(-1);
              if (
                !pending?.package ||
                pending.effectId !== effect.effectId ||
                pending.state !== "intent" ||
                !isDeepStrictEqual(pending.package.intent, effect) ||
                !isDeepStrictEqual(effect.descriptor.retention, after.descriptor.retention) ||
                (outcome === "interrupted" && effect.action !== "activate")
              ) {
                throw new UpdateRecoveryConflictError();
              }
              pending.state = "observed";
              pending.observedIdentity = after.observedIdentity;
              pending.package.observed = after;
              pending.package.outcome = outcome;
              current.package = { descriptor: after.descriptor, observed: after };
            },
            options,
            false,
            true,
          );
          accepted = next;
          params.onRecord(next);
        },
      };
    },
  };
}
