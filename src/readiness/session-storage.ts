import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { listAgentIds } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ReadinessCondition } from "./conditions.js";

export const SESSION_STORAGE_READY_CRITERION_ID = "openclaw.session-storage-ready";

export type SessionStorageReadinessEvidence = {
  writable: boolean | null;
  reason: string;
  message: string;
};

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const MAX_STORAGE_PATHS = 64;
const MAX_CONCURRENT_STORAGE_PROBES_PER_GROUP = 2;
const MAX_ACTIVE_STORAGE_PROBE_GROUPS = 2;
const PROBE_CONTENT = "openclaw session storage readiness\n";

type SessionStorageTarget = {
  directory: string;
  allowProvisioningFromAncestor: boolean;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function storageProbeFailure(error: unknown): SessionStorageReadinessEvidence {
  const code = errorCode(error);
  if (code === "ENOSPC" || code === "EDQUOT") {
    return {
      writable: false,
      reason: "SessionStorageFull",
      message: `Session storage write probe failed because storage is full (${code}).`,
    };
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return {
      writable: false,
      reason: "SessionStorageNotWritable",
      message: `Session storage write probe was denied (${code}).`,
    };
  }
  if (code === "ENOENT") {
    return {
      writable: false,
      reason: "SessionStorageMissing",
      message: "A required session storage directory does not exist.",
    };
  }
  return {
    writable: false,
    reason: "SessionStorageProbeFailed",
    message: `Session storage write probe failed${code ? ` (${code})` : ""}.`,
  };
}

async function probeStorageDirectory(directory: string): Promise<SessionStorageReadinessEvidence> {
  const probePath = path.join(
    directory,
    `.openclaw-session-readiness-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let failure: unknown;
  try {
    handle = await open(probePath, "wx", 0o600);
    await handle.writeFile(PROBE_CONTENT, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await unlink(probePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        failure ??= error;
      }
    }
  }
  return failure
    ? storageProbeFailure(failure)
    : {
        writable: true,
        reason: "SessionStorageReady",
        message: "Session storage accepted write, flush, and cleanup probes.",
      };
}

async function probeStorageDirectories(
  targets: readonly SessionStorageTarget[],
  probe: (directory: string) => Promise<SessionStorageReadinessEvidence>,
): Promise<SessionStorageReadinessEvidence> {
  const probeTarget = async (target: SessionStorageTarget) => {
    let directory = target.directory;
    while (true) {
      const evidence = await probe(directory);
      if (evidence.reason !== "SessionStorageMissing" || !target.allowProvisioningFromAncestor) {
        return evidence;
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        return evidence;
      }
      directory = parent;
    }
  };

  for (let offset = 0; offset < targets.length; offset += MAX_CONCURRENT_STORAGE_PROBES_PER_GROUP) {
    const batch = targets.slice(offset, offset + MAX_CONCURRENT_STORAGE_PROBES_PER_GROUP);
    const results = await Promise.all(batch.map((target) => probeTarget(target)));
    const failure = results.find((result) => result.writable !== true);
    if (failure) {
      return failure;
    }
  }
  return {
    writable: true,
    reason: "SessionStorageReady",
    message: "Session storage accepted write, flush, and cleanup probes.",
  };
}

function resolveSessionStorageTargets(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): SessionStorageTarget[] {
  const targets = new Map<string, SessionStorageTarget>();
  const addTarget = (directory: string, allowProvisioningFromAncestor: boolean) => {
    const resolved = path.resolve(directory);
    const existing = targets.get(resolved);
    targets.set(resolved, {
      directory: resolved,
      allowProvisioningFromAncestor:
        (existing?.allowProvisioningFromAncestor ?? true) && allowProvisioningFromAncestor,
    });
  };

  addTarget(resolveStateDir(env), false);
  for (const agentId of listAgentIds(config)) {
    addTarget(
      path.dirname(resolveStorePath(config.session?.store, { agentId, env })),
      !config.session?.store,
    );
  }
  return [...targets.values()].toSorted((a, b) => a.directory.localeCompare(b.directory, "en"));
}

export function resolveSessionStorageDirectories(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return resolveSessionStorageTargets(config, env).map((target) => target.directory);
}

export function buildSessionStorageReadinessCondition(
  evidence?: SessionStorageReadinessEvidence,
): ReadinessCondition {
  if (!evidence) {
    return {
      type: "SessionStorageReady",
      status: "Unknown",
      requirement: "advisory",
      reason: "SessionStorageNotChecked",
      message: "Session storage write evidence is not available.",
    };
  }
  return {
    type: "SessionStorageReady",
    status: evidence.writable === null ? "Unknown" : evidence.writable ? "True" : "False",
    requirement: "advisory",
    reason: evidence.reason,
    message: evidence.message,
  };
}

export function createSessionStorageReadinessEvidenceResolver(options?: {
  cacheTtlMs?: number;
  probeTimeoutMs?: number;
  probe?: (directory: string) => Promise<SessionStorageReadinessEvidence>;
  now?: () => number;
}) {
  const cacheTtlMs = Math.max(0, options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const probeTimeoutMs = Math.max(1, options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const probe = options?.probe ?? probeStorageDirectory;
  const now = options?.now ?? Date.now;
  let activeConfig: OpenClawConfig | undefined;
  let generation = 0;
  let cached:
    | {
        config: OpenClawConfig;
        key: string;
        expiresAt: number;
        evidence: SessionStorageReadinessEvidence;
      }
    | undefined;
  let pending:
    | {
        config: OpenClawConfig;
        generation: number;
        key: string;
        promise: Promise<SessionStorageReadinessEvidence>;
      }
    | undefined;
  const activeProbeGroups = new Set<Promise<SessionStorageReadinessEvidence>>();

  return async (params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }): Promise<SessionStorageReadinessEvidence> => {
    if (params.config !== activeConfig) {
      activeConfig = params.config;
      generation += 1;
      cached = undefined;
    }
    const requestedGeneration = generation;
    const targets = resolveSessionStorageTargets(params.config, params.env ?? process.env);
    if (targets.length > MAX_STORAGE_PATHS) {
      return {
        writable: null,
        reason: "SessionStoragePathLimitExceeded",
        message: `Session storage resolves more than ${MAX_STORAGE_PATHS} unique paths.`,
      };
    }
    const key = targets
      .map(
        (target) =>
          `${target.allowProvisioningFromAncestor ? "provisionable" : "required"}:${target.directory}`,
      )
      .join("\0");
    const checkedAt = now();
    if (cached?.config === params.config && cached.key === key && checkedAt < cached.expiresAt) {
      return cached.evidence;
    }

    if (
      pending &&
      (pending.config !== params.config ||
        pending.generation !== requestedGeneration ||
        pending.key !== key)
    ) {
      // Retired filesystem work may be uncancellable. Detach it while retaining
      // a process-wide cap so repeated config generations cannot accumulate I/O.
      pending = undefined;
    }

    if (!pending && activeProbeGroups.size < MAX_ACTIVE_STORAGE_PROBE_GROUPS) {
      const entry = {
        config: params.config,
        generation: requestedGeneration,
        key,
        promise: probeStorageDirectories(targets, probe).catch(storageProbeFailure),
      };
      pending = entry;
      activeProbeGroups.add(entry.promise);
      void entry.promise.then((evidence) => {
        activeProbeGroups.delete(entry.promise);
        if (pending === entry) {
          pending = undefined;
          if (entry.config === activeConfig && entry.generation === generation) {
            cached = {
              config: entry.config,
              key,
              expiresAt: now() + cacheTtlMs,
              evidence,
            };
          }
        }
      });
    }

    if (!pending) {
      return {
        writable: null,
        reason: "SessionStorageProbeTimedOut",
        message: "Prior session storage probes still occupy the bounded probe capacity.",
      };
    }

    const activeProbeEntry = pending;
    const activeProbe = activeProbeEntry.promise.then((evidence) =>
      activeProbeEntry.config === params.config &&
      activeProbeEntry.generation === requestedGeneration &&
      activeProbeEntry.key === key &&
      params.config === activeConfig &&
      requestedGeneration === generation
        ? evidence
        : ({
            writable: null,
            reason: "SessionStorageNotChecked",
            message: "Session storage configuration changed while its probe was running.",
          } satisfies SessionStorageReadinessEvidence),
    );
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<SessionStorageReadinessEvidence>((resolve) => {
      timeout = setTimeout(
        () =>
          resolve({
            writable: null,
            reason: "SessionStorageProbeTimedOut",
            message: `Session storage write probes did not finish within ${probeTimeoutMs}ms.`,
          }),
        probeTimeoutMs,
      );
      timeout.unref?.();
    });
    const evidence = await Promise.race([activeProbe, timedOut]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (
      evidence.writable === null &&
      params.config === activeConfig &&
      requestedGeneration === generation
    ) {
      cached = {
        config: params.config,
        key,
        expiresAt: now() + cacheTtlMs,
        evidence,
      };
    }
    return evidence;
  };
}
