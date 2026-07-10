import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ReadinessCondition } from "./conditions.js";

export type WorkspaceReadinessEvidence = {
  writable: boolean | null;
  reason: string;
  message: string;
};

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const PROBE_CONTENT = "openclaw workspace readiness\n";

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export function workspaceProbeFailure(error: unknown): WorkspaceReadinessEvidence {
  const code = errorCode(error);
  if (code === "ENOSPC" || code === "EDQUOT") {
    return {
      writable: false,
      reason: "WorkspaceStorageFull",
      message: `Workspace write probe failed because storage is full (${code}).`,
    };
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return {
      writable: false,
      reason: "WorkspaceNotWritable",
      message: `Workspace write probe was denied (${code}).`,
    };
  }
  if (code === "ENOENT") {
    return {
      writable: false,
      reason: "WorkspaceMissing",
      message: "Workspace write probe failed because the workspace directory does not exist.",
    };
  }
  return {
    writable: false,
    reason: "WorkspaceProbeFailed",
    message: `Workspace write probe failed${code ? ` (${code})` : ""}.`,
  };
}

export function buildWorkspaceReadinessCondition(
  evidence?: WorkspaceReadinessEvidence,
): ReadinessCondition {
  if (!evidence) {
    return {
      type: "WorkspaceWritable",
      status: "Unknown",
      requirement: "advisory",
      reason: "WorkspaceNotChecked",
      message: "Workspace write evidence is not available.",
    };
  }
  return {
    type: "WorkspaceWritable",
    status: evidence.writable === null ? "Unknown" : evidence.writable ? "True" : "False",
    requirement: "advisory",
    reason: evidence.reason,
    message: evidence.message,
  };
}

export async function probeWorkspaceWritable(
  workspaceDir: string,
): Promise<WorkspaceReadinessEvidence> {
  const probePath = path.join(
    workspaceDir,
    `.openclaw-readiness-${process.pid}-${randomUUID()}.tmp`,
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
    ? workspaceProbeFailure(failure)
    : {
        writable: true,
        reason: "WorkspaceWritable",
        message: "Workspace accepted a write, flush, and cleanup probe.",
      };
}

export function createWorkspaceReadinessEvidenceResolver(options?: {
  cacheTtlMs?: number;
  probeTimeoutMs?: number;
  probe?: (workspaceDir: string) => Promise<WorkspaceReadinessEvidence>;
  now?: () => number;
}) {
  const cacheTtlMs = Math.max(0, options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const probeTimeoutMs = Math.max(1, options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const probe = options?.probe ?? probeWorkspaceWritable;
  const now = options?.now ?? Date.now;
  let cached:
    | { workspaceDir: string; expiresAt: number; evidence: WorkspaceReadinessEvidence }
    | undefined;
  let pending: { workspaceDir: string; promise: Promise<WorkspaceReadinessEvidence> } | undefined;

  return async (params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }): Promise<WorkspaceReadinessEvidence> => {
    const workspaceDir = resolveAgentWorkspaceDir(
      params.config,
      resolveDefaultAgentId(params.config),
      params.env,
    );
    const checkedAt = now();
    if (cached?.workspaceDir === workspaceDir && checkedAt < cached.expiresAt) {
      return cached.evidence;
    }

    if (!pending || pending.workspaceDir !== workspaceDir) {
      const entry = {
        workspaceDir,
        promise: Promise.resolve()
          .then(() => probe(workspaceDir))
          .catch(workspaceProbeFailure),
      };
      pending = entry;
      void entry.promise.then((evidence) => {
        if (pending === entry) {
          pending = undefined;
          cached = { workspaceDir, expiresAt: now() + cacheTtlMs, evidence };
        }
      });
    }

    const activeProbe = pending.promise;
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<WorkspaceReadinessEvidence>((resolve) => {
      timeout = setTimeout(
        () =>
          resolve({
            writable: null,
            reason: "WorkspaceProbeTimedOut",
            message: `Workspace write probe did not finish within ${probeTimeoutMs}ms.`,
          }),
        probeTimeoutMs,
      );
    });
    const evidence = await Promise.race([activeProbe, timedOut]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (evidence.writable === null) {
      cached = { workspaceDir, expiresAt: now() + cacheTtlMs, evidence };
    }
    return evidence;
  };
}
