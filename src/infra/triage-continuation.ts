import { spawn } from "node:child_process";
// Private live continuations across the installed CLI, never serialized execution authority.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { z } from "zod";
import { resolveNodeRunner } from "../cli/update-cli/shared.js";
import {
  resolveUpdatedInstallCommandEnv,
  stripGatewayServiceMarkerEnv,
} from "../cli/update-cli/update-command-service-env.js";
import type { TriageFailureContext } from "../commands/triage-prompt.js";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { buildCliRespawnPlan } from "../entry.respawn.js";
import {
  forceKillChildProcessTree,
  shouldDetachChildForProcessTree,
} from "../process/child-process-tree.js";
import { createDeferredCore } from "../shared/deferred.js";
import { installationTargetEnv, resolveInstallationTarget } from "./installation-target-context.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  readControlPlaneUpdateSentinelMeta,
  UPDATE_RUN_ID_ENV,
} from "./update-control-plane-sentinel.js";
import {
  createManagedHandoffLeaseStore,
  triageFailureSchema as failureSchema,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import {
  createManagedUpdateRequesterAuthority,
  UpdateRequesterRevokedError,
  type UpdateRequesterAuthority,
} from "./update-requester-authority.js";

// Reuse the handoff admission/shutdown budget; cleanup loss must return to the caller.
const TRIAGE_HANDOFF_GRACE_MS = 30_000;

const readySchema = z.strictObject({ type: z.literal("triage-ready"), version: z.literal(2) });
const continuationSchema = z.strictObject({
  type: z.literal("triage"),
  version: z.literal(2),
  failure: failureSchema,
  installRoot: z.string().min(1).max(4096),
  owner: z.string().min(1).max(4096),
  requester: z
    .strictObject({
      channel: z.string().max(4096).optional(),
      accountId: z.string().max(4096).optional(),
      senderId: z.string().max(4096).optional(),
    })
    .optional(),
});

function ownsChildLease(root: string, action: "update" | "triage"): ManagedHandoffLease | null {
  const store = createManagedHandoffLeaseStore();
  const result = store.read(root);
  return result.kind === "current" &&
    result.lease.action.kind === action &&
    result.lease.helper.pid === process.ppid &&
    process.connected &&
    store.owns(result.lease, "executor")
    ? result.lease
    : null;
}

async function exchangeWithParent(message: object, signal?: AbortSignal): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.removeListener("message", received);
      process.removeListener("disconnect", disconnected);
      signal?.removeEventListener("abort", aborted);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const received = (value: unknown) => finish(null, value);
    const disconnected = () => finish(new Error("automatic triage owner disconnected"));
    const aborted = () => finish(new Error("automatic triage admission cancelled"));
    const timer = setTimeout(
      () => finish(new Error("automatic triage admission timed out")),
      TRIAGE_HANDOFF_GRACE_MS,
    );
    process.once("message", received).once("disconnect", disconnected);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    if (!process.connected || !process.send) {
      disconnected();
      return;
    }
    process.send(message, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}

export async function resolveTriageEntrypoint(root: string): Promise<[string, string, "triage"]> {
  const entry = await resolveGatewayInstallEntrypoint(root);
  if (!entry) {
    throw new Error(
      "installed CLI entry is unavailable; repair the installation and run openclaw triage manually",
    );
  }
  return [resolveNodeRunner(), entry, "triage"];
}

export async function queueManagedUpdateTriage(
  failure: TriageFailureContext,
  commandArgv: string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (process.env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1") {
    return false;
  }
  const root = (await readControlPlaneUpdateSentinelMeta())?.root;
  signal?.throwIfAborted();
  const claim = root ? ownsChildLease(root, "update") : null;
  if (!root || !claim || !process.connected) {
    throw new Error("managed update triage lost its live owner; run openclaw triage manually");
  }
  const request = {
    type: "triage-request",
    version: 2,
    failure: failureSchema.parse(failure),
    commandArgv,
  };
  try {
    const response = await exchangeWithParent(request, signal);
    const current = ownsChildLease(root, "update");
    if (
      !z
        .strictObject({ type: z.literal("triage-queued"), version: z.literal(2) })
        .safeParse(response).success ||
      !process.connected ||
      JSON.stringify(current) !== JSON.stringify(claim)
    ) {
      throw new Error("managed update triage continuation was refused or revoked");
    }
    signal?.throwIfAborted();
  } catch (error) {
    // The helper cannot execute a staged request, even if this cancellation
    // cannot cross a disconnected IPC channel.
    try {
      process.send?.({ type: "triage-request-cancel", version: 2 }, () => {});
    } catch {}
    throw error;
  }
  // This dispatch transfers ownership. Cancellation after it belongs to the
  // helper; an uncertain send must never cause another automatic attempt.
  try {
    // A send callback confirms bytes written, not a live helper's acceptance.
    z.strictObject({ type: z.literal("triage-committed"), version: z.literal(2) }).parse(
      await exchangeWithParent({ type: "triage-commit", version: 2 }),
    );
  } catch (error) {
    throw new Error("automatic triage handoff confirmation lost; inspect the handoff log", {
      cause: error,
    });
  }
  return true;
}

export async function continueTriageInFreshProcess(params: {
  root: string;
  commandArgv: string[];
  failure: TriageFailureContext;
  signal: AbortSignal;
  output: (text: string) => void;
}): Promise<void> {
  params.signal.throwIfAborted();
  const root = realpathSync(params.root);
  const failure = failureSchema.parse(params.failure);
  if (failure.installationRoot !== root) {
    throw new Error("automatic triage installation root mismatch");
  }
  const store = createManagedHandoffLeaseStore();
  const acquired = store.acquire(root, randomUUID(), {
    kind: "triage",
    phase: "reserved",
    lifetime: { kind: "foreground", boot: store.bootIdentity() },
  });
  if (acquired.kind === "busy") {
    params.output(
      "Automatic triage already owned for this installation; wait for its cleanup or inspect the saved diagnostics and run openclaw triage manually.\n",
    );
    return;
  }
  let lease = acquired.lease;
  let child: ReturnType<typeof spawn> | undefined;
  let admitted = false;
  let cancelled = false;
  let closed = false;
  let exited = false;
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let shutdown: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  const completion = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
  const armShutdown = () => {
    shutdown ??= setTimeout(() => {
      if (closed || !child) {
        return;
      }
      forced = true;
      try {
        lease = store.settle(lease, "uncertain") ?? lease;
      } catch {
        // A failed write retains the existing generation; it cannot authorize release.
      }
      try {
        // PID reuse or an unavailable identity never authorizes a group kill.
        if (
          !exited &&
          JSON.stringify(store.processIdentity(child.pid)) === JSON.stringify(lease.executor)
        ) {
          forceKillChildProcessTree(child);
        }
      } catch {
        /* Unknown process identity cannot authorize signalling. */
      }
      child.unref();
      completion.resolve({ code: null, signal: "SIGKILL" });
    }, TRIAGE_HANDOFF_GRACE_MS);
  };
  const cancel = () => {
    cancelled = true;
    if (closed || !child) {
      return;
    }
    armShutdown();
    if (exited) {
      return;
    }
    if (admitted) {
      try {
        lease = store.settle(lease, "closing") ?? lease;
      } catch {
        params.output(
          "Automatic triage revocation could not be recorded; retain the claim and inspect saved diagnostics.\n",
        );
      }
      try {
        if (child.connected) {
          child.send({ type: "triage-cancel", version: 2 }, () => {});
        }
      } catch {
        // A lost IPC channel also cancels the executor; do not kill its cleanup owner.
      }
    } else {
      // No grant has crossed IPC. This child cannot own fixing work yet.
      forceKillChildProcessTree(child);
    }
  };
  params.signal.addEventListener("abort", cancel, { once: true });
  try {
    params.output("Automatic triage is preparing the installed CLI; diagnostics will follow.\n");
    const env = {
      ...stripGatewayServiceMarkerEnv(resolveUpdatedInstallCommandEnv()),
      ...installationTargetEnv(resolveInstallationTarget()),
      OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    };
    const startup = buildCliRespawnPlan({
      argv: params.commandArgv,
      env,
      execArgv: [],
      execPath: params.commandArgv[0],
    });
    params.signal.throwIfAborted();
    child = spawn(
      startup?.command ?? params.commandArgv[0]!,
      startup?.argv ?? params.commandArgv.slice(1),
      {
        env: startup?.env ?? env,
        detached: shouldDetachChildForProcessTree(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.once("error", () => {
      if (child?.pid) {
        cancel();
        return;
      }
      closed = true;
      completion.resolve({ code: 1, signal: null });
    });
    child.once("exit", () => {
      exited = true;
      // Root exit leaves pipe readers alive; bound their drain without signalling a dead PID.
      armShutdown();
    });
    child.once("close", (code, signal) => {
      closed = true;
      completion.resolve({ code, signal });
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-32 * 1024);
      });
    }
    // A failed spawn has no signalable process until Node closes its native handle.
    await once(child, "spawn");
    try {
      const bound = child.pid ? store.bind(lease, child.pid) : null;
      if (!bound) {
        throw new Error("automatic triage child identity could not be bound");
      }
      lease = bound;
    } catch (error) {
      cancel();
      await completion.promise;
      throw error;
    }
    child.on("message", (message: unknown) => {
      if (
        closed ||
        exited ||
        cancelled ||
        admitted ||
        params.signal.aborted ||
        !child?.connected ||
        !readySchema.safeParse(message).success ||
        !store.owns(lease)
      ) {
        cancel();
        return;
      }
      try {
        const running = store.activate(lease);
        if (!running) {
          cancel();
          return;
        }
        lease = running;
        admitted = true;
        clearTimeout(timeout);
        child.send(
          { type: "triage", version: 2, installRoot: root, owner: lease.owner, failure },
          (error) => {
            if (error) {
              cancel();
            }
          },
        );
      } catch {
        cancel();
      }
    });
    child.once("disconnect", () => {
      if (!closed) {
        cancel();
      }
    });
    timeout = setTimeout(cancel, TRIAGE_HANDOFF_GRACE_MS);
    if (params.signal.aborted) {
      cancel();
    }
    const exit = await completion.promise;
    if (output) {
      params.output(output);
    }
    const completed = store.readGeneration(lease);
    if (admitted && completed?.action.phase === "closed") {
      lease = completed;
    }
    if (forced || (!store.release(lease) && admitted)) {
      store.settle(lease, "uncertain");
      throw new Error(
        "automatic triage cleanup is uncertain; automatic admission remains blocked for this OS boot. Inspect saved diagnostics and run openclaw triage manually; do not delete the claim while work may remain. A verified different OS boot allows a fresh automatic attempt",
      );
    }
    params.signal.throwIfAborted();
    if (!admitted || exit.code !== 0 || exit.signal) {
      throw new Error(
        `automatic triage candidate ${admitted ? `failed (exit ${exit.code ?? "signal"})` : "is incompatible"}; run openclaw triage manually`,
      );
    }
  } finally {
    clearTimeout(timeout);
    clearTimeout(shutdown);
    params.signal.removeEventListener("abort", cancel);
    // Reserved work never received a grant; running work needs the child's own
    // cleanup receipt. A direct PID exit cannot close an admitted generation.
    if (!admitted) {
      store.release(lease);
    }
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    if (child?.connected) {
      child.disconnect();
    }
  }
}

export async function acceptTriageContinuation(): Promise<
  | {
      failure: TriageFailureContext;
      signal: AbortSignal;
      assertCurrent: () => void;
      finish: (cleanup: "closed" | "uncertain") => Promise<void>;
    }
  | undefined
> {
  if (process.env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1") {
    return undefined;
  }
  if (!process.send || !process.connected) {
    throw new Error(
      "automatic triage requires its original connected owner; run openclaw triage manually",
    );
  }
  const store = createManagedHandoffLeaseStore();
  const controller = new AbortController();
  const parent = store.processIdentity(process.ppid);
  let lease: ManagedHandoffLease | undefined;
  let requesterAuthority: UpdateRequesterAuthority | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let shutdown: ReturnType<typeof setTimeout> | undefined;
  const armShutdown = () => {
    if (!lease || shutdown) {
      return;
    }
    shutdown = setTimeout(() => {
      try {
        store.settle(lease!, "uncertain");
      } finally {
        process.kill(process.pid, "SIGKILL");
      }
    }, TRIAGE_HANDOFF_GRACE_MS);
    shutdown.unref();
  };
  const cancel = (reason?: unknown) => {
    if (disposed || controller.signal.aborted) {
      return;
    }
    armShutdown();
    try {
      if (lease) {
        store.settle(lease, "closing");
      }
    } catch {
      // Revocation failure retains the claim; local cancellation must still drain resources.
    }
    controller.abort(
      reason instanceof Error
        ? reason
        : new Error("automatic triage cancelled: live owner or claim lost"),
    );
    if (lease?.action.kind === "triage" && lease.action.lifetime.kind === "native") {
      try {
        store.stopNative(lease, true);
      } catch {
        /* Native helper also owns scope closure. */
      }
    }
  };
  const onMessage = (message: unknown) => {
    if (
      z.strictObject({ type: z.literal("triage-cancel"), version: z.literal(2) }).safeParse(message)
        .success
    ) {
      cancel();
    }
  };
  const checkCurrent = () => {
    try {
      if (requesterAuthority && !requesterAuthority.isCurrent()) {
        throw new UpdateRequesterRevokedError();
      }
      if (
        disposed ||
        !lease ||
        !process.connected ||
        process.ppid !== parent.pid ||
        !store.owns(lease, "executor")
      ) {
        cancel();
      }
    } catch (error) {
      cancel(error);
    }
  };
  const assertCurrent = () => {
    checkCurrent();
    if (disposed) {
      throw new Error("automatic triage continuation is closed");
    }
    controller.signal.throwIfAborted();
  };
  const finish = async (cleanup: "closed" | "uncertain") => {
    if (disposed) {
      return;
    }
    armShutdown();
    try {
      if (lease) {
        if (cleanup === "closed") {
          store.settle(lease, "closed");
        } else {
          store.settle(lease, "uncertain");
        }
      }
    } finally {
      disposed = true;
      clearInterval(watch);
      process.removeListener("disconnect", cancel).removeListener("message", onMessage);
      controller.abort(new Error("automatic triage continuation closed"));
      if (process.connected) {
        process.disconnect?.();
      }
    }
  };
  process.once("disconnect", cancel);
  try {
    const { failure, installRoot, owner, requester } = continuationSchema.parse(
      await exchangeWithParent({ type: "triage-ready", version: 2 }),
    );
    const admitted = ownsChildLease(installRoot, "triage");
    if (
      !admitted ||
      admitted.owner !== owner ||
      admitted.action.kind !== "triage" ||
      admitted.action.phase !== "running" ||
      realpathSync(installRoot) !== installRoot ||
      failure.installationRoot !== installRoot ||
      JSON.stringify(admitted.helper) !== JSON.stringify(parent)
    ) {
      throw new Error("automatic triage lost its live root/generation claim");
    }
    lease = admitted;
    if (admitted.action.lifetime.kind === "native") {
      const life = admitted.action.lifetime;
      if (
        life.placement.kind !== "attached" ||
        !readFileSync("/proc/self/cgroup", "utf8")
          .trim()
          .endsWith("/" + life.scope)
      ) {
        throw new Error("automatic triage executor is outside its native scope");
      }
    }
    requesterAuthority = requester
      ? await createManagedUpdateRequesterAuthority(requester)
      : undefined;
    process.on("message", onMessage);
    watch = setInterval(checkCurrent, 250);
    assertCurrent();
    delete process.env.OPENCLAW_UPDATE_RUN_HANDOFF;
    delete process.env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV];
    delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    delete process.env[UPDATE_RUN_ID_ENV];
    return { failure, signal: controller.signal, assertCurrent, finish };
  } catch (error) {
    cancel();
    await finish("uncertain");
    throw error;
  }
}
