import { randomUUID } from "node:crypto";
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
  resolveCrabboxCheckpointCaptureTimeoutMs,
  WARM_IMAGE_COMMAND_TIMEOUT_MS,
  WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
  WARM_IMAGE_NATIVE_WAIT_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";
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
  resolveCrabboxWarmImageProfileKey,
  sameCrabboxWarmImageGeneration,
  WARM_IMAGE_MAX_ENTRIES,
  WARM_IMAGE_MAX_ALLOCATIONS,
  withoutCrabboxWarmImageOperation,
  type WarmImageRecord,
  type WarmProfileRecord,
  type WarmAllocationRecord,
} from "./crabbox-worker-warm-image-store.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type CheckpointContext = {
  binary: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
type LeaseContext = CheckpointContext & {
  id: string;
  provider: string;
};
type AllocationContext = LeaseContext & {
  profile: ReturnType<typeof resolveCrabboxProvisionProfile>["profile"];
  slug: string;
  projectKey?: string;
  preparation?: {
    key: string;
    cacheKey: string;
    purpose: "session" | "reserve";
    demandAtMs: number;
  };
  timeoutMs: () => number;
};

function allocationArgs(context: AllocationContext): string[] {
  const args = buildCrabboxAllocationArgs(context.profile, context.id, context.slug);
  // Prepared fingerprints bind this target; mutable CLI defaults cannot change it.
  if (context.preparation) {
    args.push("--target", "linux", "--arch", "amd64");
  }
  return args;
}

// Match the existing paired-device dormancy ceiling before reclaiming idle images.
const WARM_IMAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const WARM_IMAGE_REFRESH_MS = 24 * 60 * 60 * 1_000;

export function createCrabboxWarmImageManager(dependencies: {
  runCommand: CrabboxCommandRunner;
  runArgs: (context: LeaseContext) => string[];
  warn: (message: string) => void;
}) {
  let store: ReturnType<typeof openCrabboxWarmImageStore> | undefined;
  const warned = new Set<string>();
  const openStore = () => (store ??= openCrabboxWarmImageStore());
  const assertCurrent = (context: CheckpointContext) => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
  };
  const warnOnce = (action: string, error: unknown) => {
    const message = `Crabbox warm image ${action} failed: ${coerceErrorMessage(error)}`;
    if (!warned.has(message)) {
      // Periodic failures can carry changing request IDs; never retain an unbounded log cache.
      if (warned.size >= WARM_IMAGE_MAX_ENTRIES) {
        warned.clear();
      }
      warned.add(message);
      dependencies.warn(message);
    }
  };
  const checkpointCommand = async (
    context: CheckpointContext,
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

  const imageExpired = (image: WarmImageRecord) =>
    image.lastDemandAtMs === null || Date.now() - image.lastDemandAtMs >= WARM_IMAGE_RETENTION_MS;
  const pinned = (record: WarmProfileRecord, checkpointId: string) =>
    Object.values(record.allocations).some(
      ({ choice }) => choice.kind === "checkpoint" && choice.checkpointId === checkpointId,
    );
  const retiringCurrent = (record: WarmProfileRecord) =>
    record.operation?.type === "retire" &&
    record.operation.checkpointId === record.image?.checkpointId;
  const deleteEmptyProfile = (key: string) =>
    openStore().deleteIf(
      key,
      (record) =>
        !record.image && !record.operation && Object.keys(record.allocations).length === 0,
    );

  const lookupLease = (id: string) => openStore().lookupLease(id);

  const retireImage = async (
    context: CheckpointContext,
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
      sameCrabboxWarmImageGeneration(current.image, record.image) &&
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
      assertCurrent(context);
      if (matches(openStore().lookup(key))) {
        warnOnce(
          `checkpoint retirement (${operation.checkpointId} deletion obligation retained; retry during periodic maintenance or next warm-image-enabled worker teardown; inspect with openclaw crabbox warm-images)`,
          error,
        );
      }
      return;
    }
    openStore().update(key, (current) => {
      assertCurrent(context);
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
    context: CheckpointContext,
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

  const collectImages = async (context: CheckpointContext, phase: "allocation" | "teardown") => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    for (const { key, value } of openStore().entries()) {
      assertCurrent(context);
      const capture = crabboxWarmImageCaptureStatus(key, value);
      if (capture) {
        if (isCrabboxWarmImageCapturePaused(capture)) {
          warnOnce("capture paused", crabboxWarmImageRecoveryHint(capture.selector));
        }
        continue;
      }
      if (value.operation ? phase === "allocation" : !value.image || !imageExpired(value.image)) {
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
        sameCrabboxWarmImageGeneration(current.image, value.image) &&
        !current.operation &&
        imageExpired(current.image) &&
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
      .toSorted(
        (a, b) => (a.value.image?.lastDemandAtMs ?? 0) - (b.value.image?.lastDemandAtMs ?? 0),
      );
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
    const preparationKey = context.preparation?.key ?? null;
    const cacheKey = context.preparation?.cacheKey ?? null;
    const purpose = context.preparation?.purpose ?? null;
    if (
      context.preparation &&
      (!context.projectKey ||
        !/^[a-f0-9]{64}$/u.test(context.preparation.key) ||
        !/^[a-f0-9]{64}$/u.test(context.preparation.cacheKey) ||
        (purpose !== "session" && purpose !== "reserve") ||
        !Number.isSafeInteger(context.preparation.demandAtMs) ||
        context.preparation.demandAtMs < 0)
    ) {
      throw new Error("Crabbox project preparation identity is invalid.");
    }
    const key = resolveCrabboxWarmImageProfileKey(profile, context.projectKey);
    const replay = lookupLease(context.id);
    if (replay) {
      if (
        replay.key !== key ||
        replay.machineClass !== profile.class ||
        replay.preparationKey !== preparationKey ||
        replay.cacheKey !== cacheKey ||
        replay.purpose !== purpose ||
        (context.preparation && replay.demandAtMs !== context.preparation.demandAtMs)
      ) {
        throw new Error(
          "Crabbox provision retry changed its recorded profile or project identity.",
        );
      }
      return replay;
    }
    await collectImages(context, "allocation");
    const observed = openStore().lookup(key);
    let available = Boolean(
      observed?.image &&
      observed.image.lastDemandAtMs !== null &&
      (cacheKey !== null
        ? observed.image.cacheKey === cacheKey
        : observed.image.preparationKey === null && observed.image.cacheKey === null) &&
      !retiringCurrent(observed),
    );
    if (available && observed?.image?.state === "pending") {
      try {
        const state = await verifyImage(context, observed.image.checkpointId);
        available = state === "available";
        if (state === "missing") {
          await deleteImage(context, key, observed);
        }
      } catch (error) {
        assertCurrent(context);
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
        version: 3,
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
        sameCrabboxWarmImageGeneration(record.image, observed?.image) &&
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
            preparationKey,
            cacheKey,
            purpose,
            demandAtMs: context.preparation?.demandAtMs ?? Date.now(),
            imageGeneration:
              choice.kind === "checkpoint"
                ? { checkpointId: choice.checkpointId, createdAtMs: record.image!.createdAtMs }
                : null,
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

  return {
    maintain: async (context: CheckpointContext) => {
      assertCurrent(context);
      assertCrabboxWarmImageMigrationReady();
      await collectImages(context, "teardown");
    },
    lookupLease,
    markPrepared: (id: string, baseCommit: string) => openStore().markPrepared(id, baseCommit),
    markEnrolled: (id: string) => openStore().markEnrolled(id),

    notePreparedDemand: (id: string, preparation: { preparationKey: string; demandAtMs: number }) =>
      openStore().notePreparedDemand(id, preparation),

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
      context: LeaseContext & { profile: CrabboxProfile; forkedCheckpointId?: string },
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
          // A compatible foreground restore must never turn into a builder, even
          // on failed enrollment or teardown replay. The durable choice owns this policy.
          if (
            owner &&
            owner.preparationKey !== null &&
            (owner.cacheKey === null ||
              owner.purpose === null ||
              (owner.purpose === "session" && owner.choice.kind === "checkpoint"))
          ) {
            return;
          }
          await collectImages(context, "teardown");
          if (
            !owner ||
            !key ||
            owner.demandAtMs === null ||
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
            // The successful fork already attested this image. A concurrently replaced
            // image still needs its own verification before capture or retirement.
            const state =
              context.forkedCheckpointId === existing.image.checkpointId
                ? "available"
                : await verifyImage(context, existing.image.checkpointId);
            if (state === "missing" && !pinned(existing, existing.image.checkpointId)) {
              await deleteImage(context, key, existing);
              existing = openStore().lookup(key)!;
              if (existing.image || existing.operation) {
                return;
              }
            } else if (
              state !== "missing" &&
              Date.now() - existing.image.createdAtMs < WARM_IMAGE_REFRESH_MS &&
              existing.image.preparationKey === owner.preparationKey &&
              existing.image.cacheKey === owner.cacheKey &&
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
            WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
            SCRUB_WORKER_STATE,
          );
          // A stopped allocation or manual recovery must not start another paid operation.
          assertCurrent(context);
          creating = openStore().update(key, (current) =>
            current?.operation?.type === "capture" &&
            current.operation.id === captureId &&
            current.allocations[context.id]?.phase === owner.phase &&
            current.allocations[context.id]?.preparationKey === owner.preparationKey &&
            current.allocations[context.id]?.cacheKey === owner.cacheKey &&
            current.allocations[context.id]?.purpose === owner.purpose
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
                // Crabbox owns pending capture recovery; wait for the exact checkpoint
                // before enrollment. The command deadline still bounds the whole operation.
                "--wait",
                "--wait-timeout",
                `${WARM_IMAGE_NATIVE_WAIT_TIMEOUT_MS / 60_000}m`,
                "--json",
                // Daytona requires explicit permission to stop the scrubbed source for capture.
                ...(context.provider === "daytona" ? ["--no-reboot=false"] : []),
                ...(context.provider === "machine0" ? ["--strategy", "image"] : []),
              ],
              resolveCrabboxCheckpointCaptureTimeoutMs(context.provider),
            ),
            context.id,
          );
          captured = true;
          const published = openStore().update(key, (current) => {
            if (current?.operation?.type !== "capture" || current.operation.id !== captureId) {
              return undefined;
            }
            const next = withoutCrabboxWarmImageOperation(current);
            const allocation = current.allocations[context.id];
            // Capture may settle after source cleanup. Keep the image obligation,
            // but never recreate a removed allocation or attach it to another owner.
            if (
              allocation &&
              allocation.phase === owner.phase &&
              allocation.preparationKey === owner.preparationKey &&
              allocation.cacheKey === owner.cacheKey &&
              allocation.purpose === owner.purpose &&
              allocation.demandAtMs === owner.demandAtMs
            ) {
              next.allocations = {
                ...next.allocations,
                [context.id]: {
                  ...allocation,
                  imageGeneration: { checkpointId: created.checkpointId, createdAtMs: now },
                },
              };
            }
            return {
              ...next,
              image: {
                ...created,
                createdAtMs: now,
                preparationKey: owner.preparationKey,
                cacheKey: owner.cacheKey,
                purpose: owner.purpose,
                lastDemandAtMs: owner.demandAtMs,
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

    async allocate(context: AllocationContext): Promise<WarmAllocationRecord["choice"]> {
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
              ["checkpoint", "fork", checkpointId, ...allocationArgs(context), "--json"],
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
            current?.image && sameCrabboxWarmImageGeneration(current.image, owner.imageGeneration)
              ? {
                  ...current,
                  image: {
                    ...current.image,
                    state: "available",
                    lastDemandAtMs:
                      owner.demandAtMs === null
                        ? current.image.lastDemandAtMs
                        : Math.max(current.image.lastDemandAtMs ?? 0, owner.demandAtMs),
                  },
                }
              : undefined,
          );
          return owner.choice;
        }
      }
      assertCurrent(context);
      const result = await runCrabboxCommand({
        action: "warmup",
        args: ["warmup", ...allocationArgs(context)],
        binary: context.binary,
        runCommand: dependencies.runCommand,
        timeoutMs: context.timeoutMs(),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (result.termination !== "exit" || result.code !== 0) {
        throw crabboxCommandError("warmup", result);
      }
      return { kind: "cold" };
    },
  };
}
