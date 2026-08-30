import { createHash, randomUUID } from "node:crypto";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  buildCrabboxWarmupArgs,
  nonEmptyString,
  type parseCrabboxProfile,
  type resolveCrabboxProvisionProfile,
} from "./crabbox-worker-profile.js";
import {
  crabboxWarmImageCaptureStatus,
  crabboxWarmImageRecoveryHint,
  clearCrabboxWarmImageCapture,
  isCrabboxWarmImageCapturePaused,
  openCrabboxWarmImageStore,
  WARM_IMAGE_MAX_ENTRIES,
  withoutCrabboxWarmImageOperation,
  type WarmImageRecord,
} from "./crabbox-worker-warm-image-store.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type LeaseContext = { binary: string; id: string; provider: string };
type AllocationContext = LeaseContext & {
  profile: ReturnType<typeof resolveCrabboxProvisionProfile>["profile"];
  slug: string;
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
const CHECKPOINT_ID_PATTERN = /^chk_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

// Enrollment roots its identity, device token, bundles, and node-host workspaces
// under OPENCLAW_STATE_DIR here; deleting it is the cross-session data boundary.
// Crabbox's separate checkpoint workdir never receives session files (--no-sync).
// SSH session workspaces must also be scrubbed; sibling bundle installs and git-seeds
// in .openclaw-worker are machine-level caches and intentionally survive.
const SCRUB_WORKER_STATE = `set -eu
worker_root="$HOME/.openclaw/cloud-workers"
worker_processes=$(ps -eo pid=,args=)
worker_pids=$(printf '%s\\n' "$worker_processes" | awk -v root="$worker_root" -v self="$$" '$1 != self && index($0, root) { print $1 }')
if [ -n "$worker_pids" ]; then
  kill -TERM $worker_pids 2>/dev/null || true
  sleep 1
  kill -KILL $worker_pids 2>/dev/null || true
fi
rm -rf "$worker_root"
rm -rf "$HOME/.openclaw-worker/workspaces"
`;

function crabboxWarmImageKey(profile: CrabboxProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        backendProvider: profile.provider,
        setup: profile.setup ?? "",
        setupEnvKeys: [...(profile.setupEnv ?? [])].toSorted(),
        desktop: profile.desktop ?? false,
        // Exact class is intentionally conservative; cross-class reuse comes later.
        machineClass: profile.class,
      }),
    )
    .digest("hex");
}

function parseCheckpointJson(stdout: string, action: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Crabbox checkpoint ${action} returned invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Crabbox checkpoint ${action} returned an invalid record`);
  }
  return parsed;
}

function parseCreatedCheckpoint(
  stdout: string,
  leaseId: string,
): Pick<WarmImageRecord, "checkpointId" | "kind" | "state"> {
  const record = parseCheckpointJson(stdout, "create");
  const checkpointId = nonEmptyString(record.id);
  const kind = nonEmptyString(record.kind);
  const nativeState = isRecord(record.native) ? nonEmptyString(record.native.state) : undefined;
  if (
    !checkpointId ||
    !CHECKPOINT_ID_PATTERN.test(checkpointId) ||
    !kind ||
    record.leaseId !== leaseId ||
    !nativeState
  ) {
    throw new Error("Crabbox checkpoint create returned an invalid native checkpoint");
  }
  return { checkpointId, kind, state: nativeState === "available" ? "available" : "pending" };
}

function parseCheckpointAvailability(stdout: string): "available" | "pending" | "missing" {
  const record = parseCheckpointJson(stdout, "inspect");
  if (!nonEmptyString(record.localState) || !nonEmptyString(record.nextAction)) {
    throw new Error("Crabbox checkpoint inspect returned an invalid verification record");
  }
  if (record.providerState === undefined || record.providerState === "missing") {
    return "missing";
  }
  if (typeof record.providerState !== "string") {
    throw new Error("Crabbox checkpoint inspect returned an invalid provider state");
  }
  return record.providerState === "available" ? "available" : "pending";
}

export function createCrabboxWarmImageManager(dependencies: {
  runCommand: CrabboxCommandRunner;
  runArgs: (context: LeaseContext) => string[];
  warn: (message: string) => void;
}) {
  let store: ReturnType<typeof openCrabboxWarmImageStore> | undefined;
  const warned = new Set<string>();
  const openStore = () => (store ??= openCrabboxWarmImageStore());

  const warnOnce = (action: string, error: unknown) => {
    const detail = coerceErrorMessage(error);
    const message = `Crabbox warm image ${action} failed: ${detail}`;
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
    const result = await runCrabboxCommand({
      action: action === "scrub" ? action : `checkpoint ${action}`,
      args,
      binary: context.binary,
      runCommand: dependencies.runCommand,
      timeoutMs,
      ...(input === undefined ? {} : { input }),
    });
    if (result.termination !== "exit" || result.code !== 0) {
      throw crabboxCommandError(action === "scrub" ? action : `checkpoint ${action}`, result);
    }
    return result.stdout;
  };

  const sameImage = (current: WarmImageRecord | undefined, observed: WarmImageRecord) =>
    current?.checkpointId === observed.checkpointId && current.createdAtMs === observed.createdAtMs;

  const isRetiringCurrentImage = (record: WarmImageRecord | undefined) =>
    record?.operation?.type === "retire" && record.operation.checkpointId === record.checkpointId;

  const retireImage = async (
    context: LeaseContext,
    key: string,
    record: WarmImageRecord,
    timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
  ): Promise<void> => {
    const operation = record.operation;
    if (operation?.type !== "retire") {
      return;
    }
    const matches = (current: WarmImageRecord | undefined) =>
      sameImage(current, record) &&
      current?.operation?.type === "retire" &&
      current.operation.checkpointId === operation.checkpointId;
    try {
      await checkpointCommand(
        context,
        "delete",
        ["checkpoint", "delete", operation.checkpointId],
        timeoutMs,
      );
    } catch (error) {
      // A concurrent retry can resolve this obligation before a late failure.
      // Only provider failures are absorbed; SQLite failures must remain visible.
      if (matches(openStore().lookup(key))) {
        warnOnce(
          `checkpoint retirement (${operation.checkpointId} deletion obligation retained; retry on next warm-image-enabled worker teardown; inspect with openclaw crabbox warm-images)`,
          error,
        );
      }
      return;
    }
    // The obligation survives provider failure and concurrent forks updating usage.
    // A current-image retirement owns the whole slot until provider deletion succeeds.
    if (record.checkpointId === operation.checkpointId) {
      openStore().deleteIf?.(key, matches);
    } else {
      openStore().update?.(key, (current) =>
        current && matches(current) ? withoutCrabboxWarmImageOperation(current) : undefined,
      );
    }
  };

  const deleteImage = async (
    context: LeaseContext,
    key: string,
    record: WarmImageRecord,
    timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
  ) => {
    if (!record.checkpointId || record.operation) {
      return;
    }
    const retiring: WarmImageRecord = {
      ...record,
      operation: { type: "retire", checkpointId: record.checkpointId },
    };
    // Claim before awaiting deletion; an inspection/GC result must not retire a
    // refreshed, newly used, or capture-owned image from an older observation.
    if (
      openStore().update?.(key, (current) =>
        JSON.stringify(current) === JSON.stringify(record) ? retiring : undefined,
      )
    ) {
      await retireImage(context, key, retiring, timeoutMs);
    }
  };

  const collectImages = async (
    context: LeaseContext,
    phase: "allocation" | "teardown",
  ): Promise<void> => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    for (const { key, value } of openStore().entries()) {
      const capture = crabboxWarmImageCaptureStatus(key, value);
      if (capture) {
        if (isCrabboxWarmImageCapturePaused(capture)) {
          warnOnce("capture paused", crabboxWarmImageRecoveryHint(capture.selector));
        }
        continue;
      }
      // Retained deletions belong to teardown; they must not delay warm or cold allocation.
      if (
        value.operation
          ? phase === "allocation"
          : Date.now() - value.lastUsedAtMs < WARM_IMAGE_RETENTION_MS
      ) {
        continue;
      }
      const remaining = () => deadline - Date.now();
      if (remaining() <= 0) {
        break;
      }
      // Retirements retry even when the replacement is young or recently used.
      await retireImage(context, key, value, remaining());
      const current = openStore().lookup(key);
      if (
        current &&
        sameImage(current, value) &&
        !current.operation &&
        Date.now() - current.lastUsedAtMs >= WARM_IMAGE_RETENTION_MS &&
        remaining() > 0
      ) {
        await deleteImage(context, key, current, remaining());
      }
    }
  };

  const makeRoomForCapture = async (context: LeaseContext): Promise<boolean> => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    const entries = openStore().entries();
    if (entries.length < WARM_IMAGE_MAX_ENTRIES) {
      return true;
    }
    const candidates = entries
      .filter(({ value }) => value.checkpointId && !value.operation)
      .toSorted((left, right) => left.value.lastUsedAtMs - right.value.lastUsedAtMs);
    for (const { key, value } of candidates) {
      if (openStore().entries().length < WARM_IMAGE_MAX_ENTRIES) {
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await deleteImage(context, key, value, remaining);
    }
    const available = openStore().entries().length < WARM_IMAGE_MAX_ENTRIES;
    if (!available) {
      warnOnce(
        "capture admission",
        "All warm-image slots are retained; capture deferred. Inspect openclaw crabbox warm-images for pending captures or provider cleanup.",
      );
    }
    return available;
  };

  const verifyImage = async (context: LeaseContext, checkpointId: string) =>
    parseCheckpointAvailability(
      await checkpointCommand(context, "inspect", [
        "checkpoint",
        "inspect",
        checkpointId,
        "--verify",
        "--json",
      ]),
    );

  const forkImage = async (
    context: AllocationContext,
    profile: CrabboxProfile & { class: string },
  ): Promise<boolean> => {
    try {
      await collectImages(context, "allocation");
      const key = crabboxWarmImageKey(profile);
      const record = openStore().lookup(key);
      if (!record?.checkpointId || isRetiringCurrentImage(record)) {
        return false;
      }
      if (record.state === "pending") {
        const state = await verifyImage(context, record.checkpointId);
        if (state === "missing") {
          await deleteImage(context, key, record);
          return false;
        }
        if (state !== "available") {
          return false;
        }
      }
      const latest = openStore().lookup(key);
      if (!sameImage(latest, record) || isRetiringCurrentImage(latest)) {
        return false;
      }
      const fork = parseCheckpointJson(
        await checkpointCommand(
          context,
          "fork",
          [
            "checkpoint",
            "fork",
            record.checkpointId,
            "--provider",
            context.provider,
            "--lease-id",
            context.id,
            "--class",
            profile.class,
            "--slug",
            context.slug,
            "--json",
          ],
          context.timeoutMs(),
        ),
        "fork",
      );
      if (
        fork.checkpointId !== record.checkpointId ||
        fork.leaseId !== context.id ||
        fork.provider !== context.provider ||
        fork.slug !== context.slug ||
        !nonEmptyString(fork.workdir)
      ) {
        throw new Error("Crabbox checkpoint fork returned an invalid lease identity");
      }
      // Refresh may have claimed or replaced this image while its fork was running.
      openStore().update?.(key, (current) =>
        sameImage(current, record) && current && !isRetiringCurrentImage(current)
          ? { ...current, state: "available", lastUsedAtMs: Date.now() }
          : undefined,
      );
      return true;
    } catch (error) {
      warnOnce("fork", error);
      return false;
    }
  };

  return {
    async capture(context: LeaseContext & { profile: CrabboxProfile; eligible: boolean }) {
      const key = crabboxWarmImageKey(context.profile);
      const captureId = randomUUID();
      let claimed = false;
      let creating = false;
      try {
        await collectImages(context, "teardown");
        let existing = openStore().lookup(key);
        if (existing) {
          if (existing.operation || !existing.checkpointId) {
            return;
          }
          if ((await verifyImage(context, existing.checkpointId)) === "missing") {
            await deleteImage(context, key, existing);
            existing = openStore().lookup(key);
            if (existing) {
              return;
            }
          } else if (
            !context.eligible ||
            Date.now() - existing.createdAtMs < WARM_IMAGE_REFRESH_MS
          ) {
            return;
          }
        }
        if (!context.eligible || (!existing && !(await makeRoomForCapture(context)))) {
          return;
        }
        const now = Date.now();
        const reservation: WarmImageRecord = {
          ...(existing ?? {
            checkpointId: "",
            kind: "",
            state: "pending",
            createdAtMs: now,
            lastUsedAtMs: now,
          }),
          operation: {
            type: "capture",
            id: captureId,
            startedAtMs: now,
            leaseId: context.id,
            provider: context.provider,
            phase: "scrubbing",
          },
        };
        claimed = existing
          ? Boolean(
              openStore().update?.(key, (current) =>
                JSON.stringify(current) === JSON.stringify(existing) ? reservation : undefined,
              ),
            )
          : openStore().registerIfAbsent(key, reservation);
        if (!claimed) {
          return;
        }
        await checkpointCommand(
          context,
          "scrub",
          dependencies.runArgs(context),
          WARM_IMAGE_CAPTURE_TIMEOUT_MS,
          SCRUB_WORKER_STATE,
        );
        // Manual recovery closes the generation. Recheck after scrub immediately
        // before create so a closed scrub cannot start a new paid operation.
        creating = Boolean(
          openStore().update?.(key, (current) =>
            current?.operation?.type === "capture" && current.operation.id === captureId
              ? { ...current, operation: { ...current.operation, phase: "creating" } }
              : undefined,
          ),
        );
        if (!creating) {
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
            context.provider === "machine0"
              ? WARM_IMAGE_MACHINE0_CAPTURE_TIMEOUT_MS
              : WARM_IMAGE_CAPTURE_TIMEOUT_MS,
          ),
          context.id,
        );
        const published = openStore().update?.(key, (current) => {
          if (current?.operation?.type !== "capture" || current.operation.id !== captureId) {
            return undefined;
          }
          return {
            ...created,
            createdAtMs: now,
            lastUsedAtMs: Math.max(now, current.lastUsedAtMs),
            ...(current.checkpointId && current.checkpointId !== created.checkpointId
              ? { operation: { type: "retire" as const, checkpointId: current.checkpointId } }
              : {}),
          };
        });
        if (!published) {
          // Only explicit recovery can close a creating claim. Its operator owns
          // untracked artifacts; do not overwrite a newer generation or lose this ID.
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
        if (claimed) {
          try {
            if (creating) {
              openStore().update?.(key, (current) =>
                current?.operation?.type === "capture" && current.operation.id === captureId
                  ? { ...current, operation: { ...current.operation, phase: "uncertain" } }
                  : undefined,
              );
            } else {
              clearCrabboxWarmImageCapture(key, captureId);
            }
          } catch {
            // Persisted ownership remains recoverable; teardown must still stop the lease.
          }
        }
        // Once create was invoked, failure/output loss cannot prove no paid artifact
        // exists. Keep its claim for explicit recovery, including across restart.
        const detail = coerceErrorMessage(error);
        warnOnce(
          "capture",
          creating ? `${detail}. ${crabboxWarmImageRecoveryHint(captureId)}` : error,
        );
      }
    },

    async allocate(context: AllocationContext): Promise<void> {
      if (context.profile.warmImage && (await forkImage(context, context.profile))) {
        return;
      }
      // Fork failure before create-intent permits cold warmup on the same fixed lease.
      // After a fork creates its checkpoint-bound intent, warmup fails closed;
      // provisioning surfaces the conflict and provider cleanup stops the partial lease.
      const result = await runCrabboxCommand({
        action: "warmup",
        args: buildCrabboxWarmupArgs(context.profile, context.id, context.slug),
        binary: context.binary,
        runCommand: dependencies.runCommand,
        timeoutMs: context.timeoutMs(),
      });
      if (result.termination === "exit" && result.code === 0) {
        return;
      }
      // Current CLI/backend refusals cannot rule out allocation by an earlier fixed-ID attempt.
      throw crabboxCommandError("warmup", result);
    },
  };
}
