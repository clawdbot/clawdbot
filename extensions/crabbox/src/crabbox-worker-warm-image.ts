import { createHash, randomUUID } from "node:crypto";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  buildCrabboxAllocationArgs,
  nonEmptyString,
  type parseCrabboxProfile,
  type resolveCrabboxProvisionProfile,
} from "./crabbox-worker-profile.js";
import {
  parseCheckpointAvailability,
  parseCheckpointJson,
  parseCreatedCheckpoint,
} from "./crabbox-worker-warm-image-checkpoint.js";
import { SCRUB_WORKER_STATE } from "./crabbox-worker-warm-image-scrub.js";
import {
  assertCrabboxWarmImageMigrationReady,
  crabboxWarmImageCaptureStatus,
  crabboxWarmImageRecoveryHint,
  clearCrabboxWarmImageCapture,
  isCrabboxWarmImageCapturePaused,
  openCrabboxWarmImageStore,
  WARM_IMAGE_MAX_ENTRIES,
  WARM_IMAGE_MAX_ALLOCATIONS,
  withoutCrabboxWarmImageOperation,
  type WarmImageRecord,
  type WarmProfileRecord,
  type WarmAllocationRecord,
} from "./crabbox-worker-warm-image-store.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type LeaseContext = {
  binary: string;
  id: string;
  provider: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
type AllocationContext = LeaseContext & {
  profile: ReturnType<typeof resolveCrabboxProvisionProfile>["profile"];
  slug: string;
  projectKey?: string;
  timeoutMs: () => number;
};

// Match the existing paired-device dormancy ceiling before reclaiming idle images.
const WARM_IMAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const WARM_IMAGE_REFRESH_MS = 24 * 60 * 60 * 1_000;
const WARM_IMAGE_COMMAND_TIMEOUT_MS = 60_000;
// Scrub and create ride a full `crabbox run`/snapshot round trip (SSH, workspace
// owner, coordinator posts); 60s starves them under coordinator latency and the
// capture silently degrades to cold-only. Live-measured on AWS 2026-08-26.
const WARM_IMAGE_CAPTURE_TIMEOUT_MS = 180_000;
// Machine0 image save stops the source and waits for image availability even with --wait=false.
const WARM_IMAGE_MACHINE0_CAPTURE_TIMEOUT_MS = 600_000;

const checkpointCaptureTimeoutMs = (provider: string) =>
  provider === "machine0" ? WARM_IMAGE_MACHINE0_CAPTURE_TIMEOUT_MS : WARM_IMAGE_CAPTURE_TIMEOUT_MS;

export function resolveCrabboxWarmImageCaptureTimeoutMs(provider: string): number {
  // Bound collection, verification, missing-image deletion, capacity reclamation,
  // and predecessor retirement as well as scrub/create; core must await the owner.
  return (
    5 * WARM_IMAGE_COMMAND_TIMEOUT_MS +
    WARM_IMAGE_CAPTURE_TIMEOUT_MS +
    checkpointCaptureTimeoutMs(provider)
  );
}

function resolveCrabboxWarmImageProfileKey(profile: CrabboxProfile, projectKey?: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        backendProvider: profile.provider,
        setup: profile.setup ?? "",
        setupEnvKeys: [...(profile.setupEnv ?? [])].toSorted(),
        desktop: profile.desktop ?? false,
        // Exact class is intentionally conservative; cross-class reuse comes later.
        machineClass: profile.class,
        ...(projectKey ? { projectKey } : {}),
      }),
    )
    .digest("hex");
}

export function createCrabboxWarmImageManager(dependencies: {
  runCommand: CrabboxCommandRunner;
  runArgs: (context: LeaseContext) => string[];
  warn: (message: string) => void;
}) {
  let store: ReturnType<typeof openCrabboxWarmImageStore> | undefined;
  const warned = new Set<string>();
  const openStore = () => (store ??= openCrabboxWarmImageStore());
  const assertCurrent = (context: LeaseContext) => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
  };
  const warnOnce = (action: string, error: unknown) => {
    const message = `Crabbox warm image ${action} failed: ${coerceErrorMessage(error)}`;
    if (!warned.has(message)) {
      warned.add(message);
      dependencies.warn(message);
    }
  };
  const checkpointCommand = async (
    context: LeaseContext,
    action: "create" | "delete" | "fork" | "inspect" | "scrub",
    args: string[],
    timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
    input?: string,
  ): Promise<string> => {
    assertCurrent(context);
    const result = await runCrabboxCommand({
      action: action === "scrub" ? action : `checkpoint ${action}`,
      args,
      binary: context.binary,
      runCommand: dependencies.runCommand,
      timeoutMs,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(input === undefined ? {} : { input }),
    });
    if (result.termination !== "exit" || result.code !== 0) {
      throw crabboxCommandError(action === "scrub" ? action : `checkpoint ${action}`, result);
    }
    return result.stdout;
  };
  const sameImage = (left: WarmImageRecord | undefined, right: WarmImageRecord | undefined) =>
    left?.checkpointId === right?.checkpointId && left?.createdAtMs === right?.createdAtMs;
  const pinned = (record: WarmProfileRecord, checkpointId: string) =>
    Object.values(record.allocations).some(
      ({ choice }) => choice.kind === "checkpoint" && choice.checkpointId === checkpointId,
    );
  const retiringCurrent = (record: WarmProfileRecord) =>
    record.operation?.type === "retire" &&
    record.operation.checkpointId === record.image?.checkpointId;
  const deleteEmptyProfile = (key: string) =>
    openStore().deleteIf?.(
      key,
      (record) =>
        !record.image && !record.operation && Object.keys(record.allocations).length === 0,
    );

  const lookupLease = (id: string) => {
    const entries = openStore()
      .entries()
      .filter(({ value }) => Object.hasOwn(value.allocations, id));
    if (entries.length > 1) {
      throw new Error(
        `Crabbox lease ${id} has conflicting warm-image owners; run openclaw doctor --fix.`,
      );
    }
    const entry = entries[0];
    return entry
      ? { key: entry.key, projectKey: entry.value.projectKey, ...entry.value.allocations[id]! }
      : undefined;
  };

  const retireImage = async (
    context: LeaseContext,
    key: string,
    record: WarmProfileRecord,
    timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
  ): Promise<void> => {
    const operation = record.operation;
    if (operation?.type !== "retire" || pinned(record, operation.checkpointId)) {
      return;
    }
    const matches = (current: WarmProfileRecord | undefined) =>
      current?.operation?.type === "retire" &&
      current.operation.checkpointId === operation.checkpointId &&
      sameImage(current.image, record.image) &&
      !pinned(current, operation.checkpointId);
    if (!matches(openStore().lookup(key))) {
      return;
    }
    try {
      await checkpointCommand(
        context,
        "delete",
        ["checkpoint", "delete", operation.checkpointId],
        timeoutMs,
      );
    } catch (error) {
      if (matches(openStore().lookup(key))) {
        warnOnce(
          `checkpoint retirement (${operation.checkpointId} deletion obligation retained; retry on next warm-image-enabled worker teardown; inspect with openclaw crabbox warm-images)`,
          error,
        );
      }
      return;
    }
    openStore().update(key, (current) => {
      if (!current || !matches(current)) {
        return undefined;
      }
      const next = withoutCrabboxWarmImageOperation(current);
      if (next.image?.checkpointId === operation.checkpointId) {
        delete next.image;
      }
      return next;
    });
    deleteEmptyProfile(key);
  };

  const deleteImage = async (
    context: LeaseContext,
    key: string,
    record: WarmProfileRecord,
    timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
  ) => {
    if (!record.image || record.operation || pinned(record, record.image.checkpointId)) {
      return;
    }
    assertCurrent(context);
    const retiring: WarmProfileRecord = {
      ...record,
      operation: { type: "retire", checkpointId: record.image.checkpointId },
    };
    // Choice admission and retirement claim the same row; neither can pass an older observation.
    if (
      openStore().update(key, (current) =>
        JSON.stringify(current) === JSON.stringify(record) ? retiring : undefined,
      )
    ) {
      await retireImage(context, key, retiring, timeoutMs);
    }
  };

  const collectImages = async (context: LeaseContext, phase: "allocation" | "teardown") => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    for (const { key, value } of openStore().entries()) {
      const capture = crabboxWarmImageCaptureStatus(key, value);
      if (capture) {
        if (isCrabboxWarmImageCapturePaused(capture)) {
          warnOnce("capture paused", crabboxWarmImageRecoveryHint(capture.selector));
        }
        continue;
      }
      if (
        value.operation
          ? phase === "allocation"
          : !value.image || Date.now() - value.image.lastUsedAtMs < WARM_IMAGE_RETENTION_MS
      ) {
        continue;
      }
      const remaining = () => deadline - Date.now();
      if (remaining() <= 0) {
        break;
      }
      await retireImage(context, key, value, remaining());
      const current = openStore().lookup(key);
      if (
        current?.image &&
        sameImage(current.image, value.image) &&
        !current.operation &&
        Date.now() - current.image.lastUsedAtMs >= WARM_IMAGE_RETENTION_MS &&
        remaining() > 0
      ) {
        await deleteImage(context, key, current, remaining());
      }
    }
  };

  const makeRoom = async (context: LeaseContext) => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    const candidates = openStore()
      .entries()
      .filter(({ value }) => !value.operation && Object.keys(value.allocations).length === 0)
      .toSorted((a, b) => (a.value.image?.lastUsedAtMs ?? 0) - (b.value.image?.lastUsedAtMs ?? 0));
    for (const { key, value } of candidates) {
      if (openStore().entries().length < WARM_IMAGE_MAX_ENTRIES) {
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      if (value.image) {
        await deleteImage(context, key, value, remaining);
      } else {
        deleteEmptyProfile(key);
      }
    }
    if (openStore().entries().length >= WARM_IMAGE_MAX_ENTRIES) {
      throw new Error(
        "Crabbox warm-image profile capacity is full; stop outstanding workers or resolve cleanup with openclaw crabbox warm-images before retrying.",
      );
    }
  };

  const verifyImage = async (context: LeaseContext, checkpointId: string) => {
    const args = ["checkpoint", "inspect", checkpointId, "--verify", "--json"];
    return parseCheckpointAvailability(await checkpointCommand(context, "inspect", args));
  };

  const selectAllocation = async (
    context: AllocationContext,
    profile: CrabboxProfile & { class: string },
  ) => {
    const key = resolveCrabboxWarmImageProfileKey(profile, context.projectKey);
    const replay = lookupLease(context.id);
    if (replay) {
      if (replay.key !== key || replay.machineClass !== profile.class) {
        throw new Error(
          "Crabbox provision retry changed its recorded profile or project identity.",
        );
      }
      return replay;
    }
    await collectImages(context, "allocation");
    const observed = openStore().lookup(key);
    let available = Boolean(observed?.image && !retiringCurrent(observed));
    if (available && observed?.image?.state === "pending") {
      try {
        const state = await verifyImage(context, observed.image.checkpointId);
        available = state === "available";
        if (state === "missing") {
          await deleteImage(context, key, observed);
        }
      } catch (error) {
        available = false;
        warnOnce("verification", error);
      }
    }
    if (!openStore().lookup(key)) {
      await makeRoom(context);
    }
    assertCurrent(context);
    // Crabbox binds even a cold (empty checkpoint) intent to the fixed lease.
    // Freeze the choice before the first CLI call so a lost response cannot select a newer image.
    let rejection: string | undefined;
    openStore().update(key, (current) => {
      const record: WarmProfileRecord = current ?? {
        version: 2,
        allocations: {},
        ...(context.projectKey ? { projectKey: context.projectKey } : {}),
      };
      if (Object.hasOwn(record.allocations, context.id)) {
        return undefined;
      }
      if (Object.keys(record.allocations).length >= WARM_IMAGE_MAX_ALLOCATIONS) {
        rejection =
          "Crabbox warm-image allocation capacity is full; stop outstanding workers before retrying.";
        return undefined;
      }
      const choice: WarmAllocationRecord["choice"] =
        available &&
        record.image &&
        sameImage(record.image, observed?.image) &&
        !retiringCurrent(record)
          ? { kind: "checkpoint", checkpointId: record.image.checkpointId }
          : { kind: "cold" };
      return {
        ...record,
        allocations: {
          ...record.allocations,
          [context.id]: {
            choice,
            machineClass: profile.class,
            phase: "pending",
          },
        },
      };
    });
    // Domain rejections are not database failures; the store wraps callback exceptions.
    if (rejection) {
      throw new Error(rejection);
    }
    return lookupLease(context.id)!;
  };

  const markPhase = (id: string, phase: "prepared" | "enrolled", baseCommit?: string) => {
    const owner = lookupLease(id);
    if (!owner) {
      return;
    }
    if (
      phase === "prepared" &&
      (!baseCommit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit))
    ) {
      throw new Error("Crabbox project preparation requires a verified Git commit.");
    }
    let rejection: string | undefined;
    openStore().update(owner.key, (record) => {
      const allocation = record?.allocations[id];
      if (!record || !allocation) {
        rejection = "Crabbox allocation closed before preparation completed.";
        return undefined;
      }
      if (record.operation?.type === "capture" && record.operation.leaseId === id) {
        rejection = "Crabbox allocation cannot enroll while its image capture is unresolved.";
        return undefined;
      }
      if (baseCommit && allocation.baseCommit && baseCommit !== allocation.baseCommit) {
        rejection = "Crabbox provision retry changed its prepared Git commit.";
        return undefined;
      }
      if (phase === "enrolled" && record.projectKey && allocation.phase === "pending") {
        rejection = "Crabbox project allocation must be prepared before enrollment.";
        return undefined;
      }
      return {
        ...record,
        allocations: {
          ...record.allocations,
          [id]: {
            ...allocation,
            phase: allocation.phase === "enrolled" ? "enrolled" : phase,
            ...(baseCommit ? { baseCommit } : {}),
          },
        },
      };
    });
    if (rejection) {
      throw new Error(rejection);
    }
  };

  return {
    lookupLease,
    markPrepared: (id: string, baseCommit: string) => markPhase(id, "prepared", baseCommit),
    markEnrolled: (id: string) => markPhase(id, "enrolled"),

    async release(context: LeaseContext) {
      // Only confirmed stop releases this pin: enrollment success may itself be a lost response,
      // and replay still needs the original checkpoint catalog entry and native artifact.
      const owner = lookupLease(context.id);
      if (!owner) {
        return;
      }
      openStore().update(owner.key, (record) => {
        if (!record?.allocations[context.id]) {
          return undefined;
        }
        const allocations = { ...record.allocations };
        delete allocations[context.id];
        return { ...record, allocations };
      });
      const current = openStore().lookup(owner.key);
      if (current) {
        await retireImage(context, owner.key, current);
      }
      deleteEmptyProfile(owner.key);
    },

    async capture(
      context: LeaseContext & { profile: CrabboxProfile },
      prepareSource?: () => Promise<void>,
    ): Promise<boolean> {
      assertCurrent(context);
      const captureId = randomUUID();
      const owner = lookupLease(context.id);
      const key = owner?.key;
      let claimed = false;
      let creating = false;
      let preparing = false;
      let captured = false;
      const attemptCapture = async () => {
        try {
          await collectImages(context, "teardown");
          if (
            !owner ||
            !key ||
            (owner.projectKey ? owner.phase !== "prepared" : owner.phase !== "enrolled")
          ) {
            return;
          }
          if (
            key !==
            resolveCrabboxWarmImageProfileKey(
              { ...context.profile, class: owner.machineClass },
              owner.projectKey,
            )
          ) {
            throw new Error("Crabbox capture profile does not match its recorded allocation.");
          }
          let existing = openStore().lookup(key)!;
          if (existing.operation) {
            return;
          }
          if (existing.image) {
            const state = await verifyImage(context, existing.image.checkpointId);
            if (state === "missing" && !pinned(existing, existing.image.checkpointId)) {
              await deleteImage(context, key, existing);
              existing = openStore().lookup(key)!;
              if (existing.image || existing.operation) {
                return;
              }
            } else if (
              state !== "missing" &&
              Date.now() - existing.image.createdAtMs < WARM_IMAGE_REFRESH_MS &&
              (!owner.projectKey || existing.image.baseCommit === owner.baseCommit)
            ) {
              return;
            }
          }
          const now = Date.now();
          assertCurrent(context);
          claimed = openStore().update(key, (current) => {
            if (
              !current ||
              JSON.stringify(current) !== JSON.stringify(existing) ||
              current.allocations[context.id]?.phase !== owner.phase
            ) {
              return undefined;
            }
            return {
              ...current,
              operation: {
                type: "capture",
                id: captureId,
                startedAtMs: now,
                leaseId: context.id,
                provider: context.provider,
                phase: "scrubbing",
              },
            };
          });
          if (!claimed) {
            return;
          }
          // Runtime preparation belongs only to a claimed capture. Scrub its forwarded
          // credential artifacts afterward, before any native image can include them.
          assertCurrent(context);
          preparing = true;
          await prepareSource?.();
          preparing = false;
          await checkpointCommand(
            context,
            "scrub",
            dependencies.runArgs(context),
            WARM_IMAGE_CAPTURE_TIMEOUT_MS,
            SCRUB_WORKER_STATE,
          );
          // A stopped allocation or manual recovery must not start another paid operation.
          assertCurrent(context);
          creating = openStore().update(key, (current) =>
            current?.operation?.type === "capture" &&
            current.operation.id === captureId &&
            current.allocations[context.id]?.phase === owner.phase
              ? { ...current, operation: { ...current.operation, phase: "creating" } }
              : undefined,
          );
          if (!creating) {
            clearCrabboxWarmImageCapture(key, captureId);
            return;
          }
          const created = parseCreatedCheckpoint(
            await checkpointCommand(
              context,
              "create",
              [
                "checkpoint",
                "create",
                "--provider",
                context.provider,
                "--id",
                context.id,
                "--mode",
                "native",
                "--wait=false",
                "--json",
                ...(context.provider === "machine0" ? ["--strategy", "image"] : []),
              ],
              checkpointCaptureTimeoutMs(context.provider),
            ),
            context.id,
          );
          captured = true;
          const published = openStore().update(key, (current) => {
            if (current?.operation?.type !== "capture" || current.operation.id !== captureId) {
              return undefined;
            }
            const next = withoutCrabboxWarmImageOperation(current);
            return {
              ...next,
              image: {
                ...created,
                createdAtMs: now,
                lastUsedAtMs: Math.max(now, current.image?.lastUsedAtMs ?? 0),
                ...(owner.baseCommit ? { baseCommit: owner.baseCommit } : {}),
              },
              ...(current.image && current.image.checkpointId !== created.checkpointId
                ? {
                    operation: {
                      type: "retire" as const,
                      checkpointId: current.image.checkpointId,
                    },
                  }
                : {}),
            };
          });
          if (!published) {
            warnOnce(
              "capture ownership changed",
              `Checkpoint ${created.checkpointId} returned after recovery of ${captureId}; reconcile it in the Crabbox catalog before resuming captures.`,
            );
            return;
          }
          creating = false;
          claimed = false;
          const replacement = openStore().lookup(key);
          if (replacement) {
            await retireImage(context, key, replacement);
          }
        } catch (error) {
          if (claimed && key) {
            try {
              if (creating) {
                openStore().update(key, (current) =>
                  current?.operation?.type === "capture" && current.operation.id === captureId
                    ? { ...current, operation: { ...current.operation, phase: "uncertain" } }
                    : undefined,
                );
              } else {
                clearCrabboxWarmImageCapture(key, captureId);
              }
            } catch {
              // Keep persisted ownership recoverable; physical lease cleanup still belongs to stop.
            }
          }
          if (preparing) {
            throw error;
          }
          warnOnce(
            "capture",
            creating
              ? `${coerceErrorMessage(error)}. ${crabboxWarmImageRecoveryHint(captureId)}`
              : error,
          );
        }
      };
      await attemptCapture();
      const operation = key && owner?.projectKey ? openStore().lookup(key)?.operation : undefined;
      // A native create may still be running after a lost response. Enrollment must
      // never introduce node credentials into that source until capture has settled.
      if (operation?.type === "capture" && operation.leaseId === context.id) {
        throw new Error(
          `Crabbox project image capture is unresolved. ${crabboxWarmImageRecoveryHint(operation.id)}`,
        );
      }
      assertCurrent(context);
      return captured;
    },

    async allocate(context: AllocationContext): Promise<void> {
      assertCurrent(context);
      if (context.profile.warmImage) {
        assertCrabboxWarmImageMigrationReady();
        const owner = await selectAllocation(context, context.profile);
        if (owner.choice.kind === "checkpoint") {
          const checkpointId = owner.choice.checkpointId;
          const fork = parseCheckpointJson(
            await checkpointCommand(
              context,
              "fork",
              [
                "checkpoint",
                "fork",
                checkpointId,
                ...buildCrabboxAllocationArgs(context.profile, context.id, context.slug),
                "--json",
              ],
              context.timeoutMs(),
            ),
            "fork",
          );
          if (
            fork.checkpointId !== checkpointId ||
            fork.leaseId !== context.id ||
            fork.provider !== context.provider ||
            fork.slug !== context.slug ||
            !nonEmptyString(fork.workdir)
          ) {
            throw new Error("Crabbox checkpoint fork returned an invalid lease identity");
          }
          openStore().update(owner.key, (current) =>
            current?.image?.checkpointId === checkpointId
              ? {
                  ...current,
                  image: { ...current.image, state: "available", lastUsedAtMs: Date.now() },
                }
              : undefined,
          );
          return;
        }
      }
      assertCurrent(context);
      const result = await runCrabboxCommand({
        action: "warmup",
        args: ["warmup", ...buildCrabboxAllocationArgs(context.profile, context.id, context.slug)],
        binary: context.binary,
        runCommand: dependencies.runCommand,
        timeoutMs: context.timeoutMs(),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (result.termination !== "exit" || result.code !== 0) {
        throw crabboxCommandError("warmup", result);
      }
    },
  };
}
