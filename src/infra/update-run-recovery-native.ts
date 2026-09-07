import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  RecoveryNativeActionSchema,
  RecoveryNativeFactsSchema,
  RecoveryNativeIdentitySchema,
  RecoveryNativeObservationSchema,
  validNativeTransition,
  currentUpdateRecoveryNativeFacts,
  type UpdateRecoveryNativeAction,
  type UpdateRecoveryNativeFacts,
  type UpdateRecoveryNativeIdentity,
  type UpdateRecoveryNativeObservation,
} from "./update-run-recovery-native-schema.js";
import {
  UpdateRecoveryConflictError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import {
  assertExecutingClaim,
  assertRecoveryFence,
  mutateRecovery,
  requireRevision,
} from "./update-run-recovery-store.js";
import type { UpdateRecoveryFence, UpdateRecoveryRevision } from "./update-run-recovery.js";

export type {
  UpdateRecoveryNativeAction,
  UpdateRecoveryNativeFacts,
  UpdateRecoveryNativeIdentity,
  UpdateRecoveryNativeObservation,
} from "./update-run-recovery-native-schema.js";

/** Daemon-owned read only inspection. No commands or mutations in this callback. */
type Observe = () => Promise<UpdateRecoveryNativeObservation>;
type Inspection = {
  record: UpdateRecoveryRecord;
  observation: UpdateRecoveryNativeObservation;
  status: "before" | "after" | "conflict";
};

function readCurrent(
  expected: UpdateRecoveryRevision,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions,
): UpdateRecoveryRecord {
  assertRecoveryFence(fence);
  const record = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => requireRevision(db, expected).record,
    options,
  );
  if (!record) {
    throw new UpdateRecoveryConflictError();
  }
  assertRecoveryFence(fence);
  return record;
}

function assertIdentity(
  record: UpdateRecoveryRecord,
  identity: UpdateRecoveryNativeIdentity,
): void {
  if (
    !record.source ||
    identity.runId !== record.runId ||
    identity.stateDir !== record.source.stateDir ||
    identity.configPath !== record.source.configPath ||
    record.source.profile === undefined ||
    identity.profile !== record.source.profile ||
    (record.nativeManager && !isDeepStrictEqual(identity, record.nativeManager.identity))
  ) {
    throw new UpdateRecoveryConflictError();
  }
}

/** Fresh daemon observations are evidence only; every await is followed by exact CAS/fence revalidation. */
async function inspect(
  expected: UpdateRecoveryRevision,
  observe: Observe,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions,
) {
  const record = readCurrent(expected, fence, options);
  const observation = RecoveryNativeObservationSchema.parse(await observe());
  assertIdentity(record, observation.identity);
  if (!isDeepStrictEqual(readCurrent(expected, fence, options), record)) {
    throw new UpdateRecoveryConflictError();
  }
  return { record, observation };
}

function write(
  current: UpdateRecoveryRecord,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions,
  change: (record: UpdateRecoveryRecord) => void,
): UpdateRecoveryRecord {
  return mutateRecovery(
    current,
    fence,
    (record) => {
      if (!isDeepStrictEqual(record, current)) {
        throw new UpdateRecoveryConflictError();
      }
      change(record);
      record.verification = null;
    },
    options,
    false,
    false,
    true,
  );
}

/**
 * Bind once BEFORE native suppression/stop and full capture. File preimages must
 * already be bound; no retry-time observation can replace the original facts.
 * Caller retains daemon/executor exclusion throughout observation and persistence.
 */
export async function bindUpdateRecoveryNativeManager(
  expected: UpdateRecoveryRevision,
  input: { identity: UpdateRecoveryNativeIdentity; observe: Observe },
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRecoveryRecord> {
  const identity = RecoveryNativeIdentitySchema.parse(input.identity);
  const { record, observation } = await inspect(expected, input.observe, fence, options);
  if (!isDeepStrictEqual(identity, observation.identity)) {
    throw new UpdateRecoveryConflictError();
  }
  return write(record, fence, options, (current) => {
    if (
      !current.preimages ||
      current.checkpoint ||
      current.effects.length ||
      current.restore ||
      current.primaryFailure ||
      current.nativeManager?.effects.length
    ) {
      throw new UpdateRecoveryConflictError();
    }
    if (current.nativeManager) {
      if (!isDeepStrictEqual(current.nativeManager.original, observation.facts)) {
        throw new UpdateRecoveryConflictError();
      }
    } else {
      current.nativeManager = {
        identity,
        original: observation.facts,
        boundAtRevision: current.revision + 1,
        effects: [],
      };
    }
  });
}

/**
 * Read-only reconciliation before claim/general runtime open. No migration,
 * observation commit, native effect, or adopted claim. A before/after result
 * is evidence, not authority; reobserve under the newly acquired claim.
 */
export async function inspectUpdateRecoveryNativeManager(
  expected: UpdateRecoveryRevision,
  observe: Observe,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): Promise<Inspection> {
  const inspected = await inspect(expected, observe, fence, options);
  const pending = inspected.record.nativeManager?.effects.at(-1);
  if (!pending) {
    throw new UpdateRecoveryConflictError();
  }
  const facts = inspected.observation.facts;
  const status = isDeepStrictEqual(facts, pending.after)
    ? "after"
    : isDeepStrictEqual(facts, pending.before)
      ? "before"
      : "conflict";
  return { ...inspected, status };
}

/**
 * Persist BEFORE each daemon mutation. Retry uses the SAME effectId/action/target
 * and current claim; never infer the original enabled state from the retry.
 * On "after" do not repeat the mutation: record its freshly inspected outcome.
 * Compound daemon actions must be split at observable transitions. A conflict
 * remains pending and requires daemon-owner reconciliation, not blind replay.
 */
export async function recordUpdateRecoveryNativeIntent(
  expected: UpdateRecoveryRevision,
  input: {
    effectId: string;
    action: UpdateRecoveryNativeAction;
    target: UpdateRecoveryNativeFacts;
    observe: Observe;
    /** Correlate the native start with its boot observation in the SAME commit.
     * This is an intent only; neither native readback nor this field is readiness. */
    restart?: { runtime: "candidate" | "previous"; resourceId: string };
  },
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): Promise<{ record: UpdateRecoveryRecord; status: "before" | "after" }> {
  const effectId = z.uuid().parse(input.effectId);
  const action = RecoveryNativeActionSchema.parse(input.action);
  const target = RecoveryNativeFactsSchema.parse(input.target);
  const { record, observation } = await inspect(expected, input.observe, fence, options);
  assertExecutingClaim(record);
  const manager = record.nativeManager;
  const prior = manager?.effects.at(-1);
  const paired = record.effects.find((effect) => effect.effectId === effectId);
  const restart = input.restart;
  const sameRestart = Boolean(
    restart &&
    prior?.effectId === effectId &&
    paired &&
    paired === record.effects.at(-1) &&
    paired.kind === "service-restart" &&
    paired.runtime === restart.runtime &&
    paired.resourceId === restart.resourceId,
  );
  const pendingRestart = record.effects.at(-1);
  const dispatched = manager?.effects.find(
    (effect) => effect.effectId === pendingRestart?.effectId,
  );
  // After independent start readback, restore only the original disabled job
  // policy while the separate boot observation is still pending. No other native
  // transition may cross the restart barrier and no boot identity is synthesized.
  const restoringStartedTaskPolicy =
    !restart &&
    action === "restore" &&
    (manager?.identity.platform === "win32" || manager?.identity.platform === "darwin") &&
    manager.original.enabled === false &&
    pendingRestart?.kind === "service-restart" &&
    pendingRestart.state === "intent" &&
    dispatched?.action === "restore" &&
    dispatched.state === "observed" &&
    dispatched.before.stopped &&
    !dispatched.after.stopped &&
    dispatched.after.enabled === true &&
    (prior === dispatched || (prior?.effectId === effectId && prior.action === "restore")) &&
    isDeepStrictEqual(target, { ...dispatched.after, enabled: false });
  const failureQuiescence = Boolean(
    record.primaryFailure &&
    record.checkpoint &&
    !restart &&
    (action === "suppress" || action === "stop"),
  );
  const quiescingUnverifiedStart =
    failureQuiescence &&
    pendingRestart?.kind === "service-restart" &&
    dispatched?.action === "restore" &&
    dispatched.state === "observed" &&
    dispatched.before.stopped &&
    !dispatched.after.stopped;
  if (
    !manager ||
    record.terminal ||
    record.effects.some(
      (effect) =>
        effect.state === "intent" &&
        !(sameRestart && effect === paired) &&
        !(restoringStartedTaskPolicy && effect === pendingRestart) &&
        !(quiescingUnverifiedStart && effect === pendingRestart),
    ) ||
    (paired && !sameRestart)
  ) {
    throw new UpdateRecoveryConflictError();
  }
  if (
    restart &&
    (!record.checkpoint ||
      action !== "restore" ||
      target.stopped ||
      !target.loaded ||
      !(prior?.effectId === effectId ? prior.before : observation.facts).stopped ||
      (!sameRestart &&
        (restart.runtime === "previous"
          ? !record.primaryFailure
          : record.primaryFailure !== null)) ||
      (prior?.effectId === effectId && !sameRestart))
  ) {
    throw new UpdateRecoveryConflictError();
  }
  if (prior?.effectId === effectId) {
    if (
      prior.state === "not-applied" ||
      prior.action !== action ||
      !isDeepStrictEqual(prior.after, target) ||
      (prior.state === "observed" && !isDeepStrictEqual(observation.facts, target))
    ) {
      throw new UpdateRecoveryConflictError();
    }
    const status = isDeepStrictEqual(observation.facts, target)
      ? "after"
      : isDeepStrictEqual(observation.facts, prior.before)
        ? "before"
        : "conflict";
    if (status === "conflict") {
      throw new UpdateRecoveryConflictError();
    }
    return { record, status };
  }
  if (
    !isDeepStrictEqual(observation.facts, currentUpdateRecoveryNativeFacts(manager)) ||
    prior?.state === "intent" ||
    manager.effects.some((effect) => effect.effectId === effectId) ||
    (action === "enable-for-start" && !record.checkpoint) ||
    (action !== "restore" &&
      action !== "enable-for-start" &&
      !failureQuiescence &&
      (record.checkpoint || record.effects.length || record.restore || record.primaryFailure)) ||
    !validNativeTransition(
      action,
      observation.facts,
      target,
      manager.original,
      manager.identity.platform,
    )
  ) {
    throw new UpdateRecoveryConflictError();
  }
  const next = write(record, fence, options, (current) => {
    if (restart) {
      current.effects.push({
        effectId,
        kind: "service-restart",
        resourceId: restart.resourceId,
        runtime: restart.runtime,
        state: "intent",
        observedIdentity: null,
      });
    }
    current.nativeManager!.effects.push({
      effectId,
      action,
      before: observation.facts,
      after: target,
      state: "intent",
      intentRevision: current.revision + 1,
    });
  });
  return {
    record: next,
    status: isDeepStrictEqual(observation.facts, target) ? "after" : "before",
  };
}

/**
 * Fresh daemon readback only. Before/conflict leaves the exact intent untouched,
 * including after an ambiguous failure. There is no generic observedIdentity
 * substitute, no restart/disposal, and no replacement of the primary failure.
 */
export async function recordUpdateRecoveryNativeObservation(
  expected: UpdateRecoveryRevision,
  effectId: string,
  observe: Observe,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): Promise<Inspection> {
  const inspected = await inspectUpdateRecoveryNativeManager(expected, observe, fence, options);
  const { record } = inspected;
  assertExecutingClaim(record);
  const pending = record.nativeManager!.effects.at(-1)!;
  if (record.terminal || pending.effectId !== effectId || pending.state === "not-applied") {
    throw new UpdateRecoveryConflictError();
  }
  if (inspected.status !== "after" || pending.state === "observed") {
    return inspected;
  }
  const next = write(record, fence, options, (current) => {
    const effect = current.nativeManager!.effects.at(-1)!;
    effect.state = "observed";
    effect.observedRevision = current.revision + 1;
  });
  return { ...inspected, record: next };
}

/** Called only after admitted native work has settled under its source owner.
 * An independent before readback resolves an unapplied dispatch, not readiness. */
export async function recordUpdateRecoveryNativeNotApplied(
  expected: UpdateRecoveryRevision,
  effectId: string,
  observe: Observe,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRecoveryRecord> {
  const inspected = await inspectUpdateRecoveryNativeManager(expected, observe, fence, options);
  const { record } = inspected;
  assertExecutingClaim(record);
  const pending = record.nativeManager!.effects.at(-1)!;
  if (
    !record.primaryFailure ||
    record.terminal ||
    pending.effectId !== effectId ||
    pending.state !== "intent" ||
    inspected.status !== "before"
  ) {
    throw new UpdateRecoveryConflictError();
  }
  return write(record, fence, options, (current) => {
    const entry = current.nativeManager!.effects.at(-1)!;
    entry.state = "not-applied";
    entry.observedRevision = current.revision + 1;
  });
}

/** Cancel only the outstanding boot intent after fresh, resolved native stop.
 * No boot ID is manufactured and the original failure remains authoritative. */
export async function cancelUpdateRecoveryRestart(
  expected: UpdateRecoveryRevision,
  observe: Observe,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRecoveryRecord> {
  const { record, observation } = await inspect(expected, observe, fence, options);
  assertExecutingClaim(record);
  const restart = record.effects.at(-1);
  const manager = record.nativeManager;
  const last = manager?.effects.at(-1);
  const startIndex =
    manager?.effects.findIndex((entry) => entry.effectId === restart?.effectId) ?? -1;
  const start = manager?.effects[startIndex];
  if (
    !record.primaryFailure ||
    record.terminal ||
    !manager ||
    !last ||
    last.state === "intent" ||
    !observation.facts.stopped ||
    !isDeepStrictEqual(observation.facts, currentUpdateRecoveryNativeFacts(manager)) ||
    restart?.kind !== "service-restart" ||
    restart.state !== "intent" ||
    !start ||
    start.action !== "restore" ||
    !start.before.stopped ||
    start.after.stopped ||
    !(last === start
      ? last.state === "not-applied"
      : last.action === "stop" &&
        last.state === "observed" &&
        startIndex < manager.effects.length - 1)
  ) {
    throw new UpdateRecoveryConflictError();
  }
  return write(record, fence, options, (current) => {
    const entry = current.effects.at(-1)!;
    entry.state = "cancelled";
    entry.cancelledByNativeEffectId = last.effectId;
  });
}
