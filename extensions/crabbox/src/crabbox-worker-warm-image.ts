import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  buildCrabboxWarmupArgs,
  nonEmptyString,
  type parseCrabboxProfile,
  type resolveCrabboxProvisionProfile,
} from "./crabbox-worker-profile.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type WarmImageRecord = {
  checkpointId: string;
  kind: string;
  state: "pending" | "available";
  createdAtMs: number;
  lastUsedAtMs: number;
};
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
// Reservation staleness must cover the slowest provider capture budget: stealing a
// live capture's reservation lets the finished capture overwrite the thief's record
// and orphan its provider checkpoint outside retention cleanup.
const WARM_IMAGE_CAPTURE_RESERVATION_TIMEOUT_MS = 2 * WARM_IMAGE_MACHINE0_CAPTURE_TIMEOUT_MS;
const WARM_IMAGE_MAX_ENTRIES = 128;
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
  let store: ReturnType<typeof createPluginStateSyncKeyedStore<WarmImageRecord>> | undefined;
  const warned = new Set<string>();
  const openStore = () =>
    (store ??= createPluginStateSyncKeyedStore<WarmImageRecord>("crabbox", {
      namespace: "warm-images",
      maxEntries: WARM_IMAGE_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
    }));

  const warnOnce = (action: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
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

  const deleteImage = async (
    context: LeaseContext,
    key: string,
    record: WarmImageRecord,
    timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
  ) => {
    if (record.checkpointId) {
      await checkpointCommand(
        context,
        "delete",
        ["checkpoint", "delete", record.checkpointId],
        timeoutMs,
      );
    }
    // Delete the provider snapshot before its index; losing the index first
    // would orphan a billed resource outside warm-image retention cleanup.
    openStore().deleteIf?.(
      key,
      (current) =>
        current.checkpointId === record.checkpointId && current.createdAtMs === record.createdAtMs,
    );
  };

  const makeRoomForCapture = async (context: LeaseContext): Promise<boolean> => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    for (let remainingEntries = WARM_IMAGE_MAX_ENTRIES; remainingEntries > 0; remainingEntries--) {
      const entries = openStore().entries();
      if (entries.length < WARM_IMAGE_MAX_ENTRIES) {
        return true;
      }
      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) {
        return false;
      }
      // Evicting a live reservation would break its capture's single-flight ownership.
      const oldest = entries
        .filter(
          ({ value }) =>
            value.checkpointId ||
            Date.now() - value.createdAtMs >= WARM_IMAGE_CAPTURE_RESERVATION_TIMEOUT_MS,
        )
        .toSorted((left, right) => left.value.lastUsedAtMs - right.value.lastUsedAtMs)[0];
      if (!oldest) {
        return false;
      }
      await deleteImage(context, oldest.key, oldest.value, remainingTime);
    }
    return openStore().entries().length < WARM_IMAGE_MAX_ENTRIES;
  };

  const collectExpiredImages = async (context: LeaseContext): Promise<void> => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    for (const { key, value } of openStore().entries()) {
      if (Date.now() - value.lastUsedAtMs < WARM_IMAGE_RETENTION_MS) {
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await deleteImage(context, key, value, remaining);
    }
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
      await collectExpiredImages(context);
      const key = crabboxWarmImageKey(profile);
      const record = openStore().lookup(key);
      if (!record?.checkpointId) {
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
      const checkpointId = record.checkpointId;
      // Refresh may have claimed or replaced this image while its fork was running.
      openStore().update?.(key, (current) =>
        current?.checkpointId === checkpointId
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
      let reservation: WarmImageRecord | undefined;
      let superseded: WarmImageRecord | undefined;
      try {
        await collectExpiredImages(context);
        const existing = openStore().lookup(key);
        if (existing) {
          if (!existing.checkpointId) {
            const staleBefore = Date.now() - WARM_IMAGE_CAPTURE_RESERVATION_TIMEOUT_MS;
            if (
              existing.createdAtMs > staleBefore ||
              !openStore().deleteIf?.(
                key,
                (current) => !current.checkpointId && current.createdAtMs <= staleBefore,
              )
            ) {
              return;
            }
          } else if ((await verifyImage(context, existing.checkpointId)) === "missing") {
            await deleteImage(context, key, existing);
          } else {
            if (!context.eligible || Date.now() - existing.createdAtMs < WARM_IMAGE_REFRESH_MS) {
              return;
            }
            if (
              !openStore().deleteIf?.(
                key,
                (current) => current.checkpointId === existing.checkpointId,
              )
            ) {
              return;
            }
            // Refresh briefly provisions cold while the replacement is captured;
            // removing the old record lets the existing reservation own single-flight.
            superseded = existing;
          }
        }
        if (!context.eligible || !(await makeRoomForCapture(context))) {
          return;
        }
        const now = Date.now();
        reservation = {
          checkpointId: "",
          kind: "",
          state: "pending",
          createdAtMs: now,
          lastUsedAtMs: now,
        };
        if (!openStore().registerIfAbsent(key, reservation)) {
          reservation = undefined;
          return;
        }
        await checkpointCommand(
          context,
          "scrub",
          dependencies.runArgs(context),
          WARM_IMAGE_CAPTURE_TIMEOUT_MS,
          SCRUB_WORKER_STATE,
        );
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
        openStore().register(key, { ...reservation, ...created });
        reservation = undefined;
        if (superseded) {
          try {
            await checkpointCommand(context, "delete", [
              "checkpoint",
              "delete",
              superseded.checkpointId,
            ]);
          } catch (error) {
            warnOnce("superseded checkpoint deletion", error);
          }
        }
      } catch (error) {
        if (reservation || superseded) {
          try {
            if (superseded) {
              openStore().register(key, superseded);
            } else if (reservation) {
              const createdAtMs = reservation.createdAtMs;
              store?.deleteIf?.(
                key,
                (current) => current.checkpointId === "" && current.createdAtMs === createdAtMs,
              );
            }
          } catch {
            // A stale reservation is GC-eligible; teardown must still stop the lease.
          }
        }
        warnOnce("capture", error);
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
