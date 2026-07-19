import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  listOpenClawRegisteredAgentDatabases,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db.js";
import type {
  OpenClawDatabaseVerifyResult,
  OpenClawDatabaseVerifyTarget,
} from "./openclaw-database-verify.worker.js";
import { recordOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import { recordOpenClawStateDatabaseOpenFailure } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

export const OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS = 5 * 60_000;
export const OPENCLAW_DATABASE_VERIFY_INTERVAL_MS = 24 * 60 * 60_000;

const log = createSubsystemLogger("state/database-verify");

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveDatabaseVerifyWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(path.join(distRoot, "state", "openclaw-database-verify.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./openclaw-database-verify.worker${extension}`, currentModuleUrl);
}

function isVerifyResult(value: unknown): value is OpenClawDatabaseVerifyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    typeof result.path === "string" &&
    typeof result.ok === "boolean" &&
    (result.error === undefined || typeof result.error === "string") &&
    (result.terminal === undefined || typeof result.terminal === "boolean")
  );
}

export function runDatabaseVerifyWorker(
  targets: readonly OpenClawDatabaseVerifyTarget[],
  options: { onWorker?: (worker: Worker | undefined) => void; workerUrl?: URL } = {},
): Promise<OpenClawDatabaseVerifyResult[]> {
  const workerUrl = options.workerUrl ?? resolveDatabaseVerifyWorkerUrl();
  const execArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, { workerData: targets, execArgv });
  } catch (error) {
    return Promise.reject(toError(error));
  }
  options.onWorker?.(worker);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      worker.removeAllListeners();
      options.onWorker?.(undefined);
      finish();
    };
    worker.once("message", (message: unknown) => {
      settle(() => {
        if (!Array.isArray(message) || !message.every(isVerifyResult)) {
          reject(new Error("database verification worker returned invalid results"));
          return;
        }
        resolve(message);
      });
    });
    worker.once("error", (error) => settle(() => reject(toError(error))));
    worker.once("exit", (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`database verification worker exited with code ${code}`)));
      } else {
        settle(() => reject(new Error("database verification worker exited without results")));
      }
    });
  });
}

/** Resolve the state database and current registered agent database paths. */
export function collectOpenClawDatabaseVerifyTargets(options: {
  env: NodeJS.ProcessEnv;
}): OpenClawDatabaseVerifyTarget[] {
  const targets = new Map<string, OpenClawDatabaseVerifyTarget>();
  const statePath = path.resolve(resolveOpenClawStateSqlitePath(options.env));
  if (existsSync(statePath)) {
    targets.set(statePath, { kind: "state", label: "OpenClaw state database", path: statePath });
  }
  let registeredDatabases: ReturnType<typeof listOpenClawRegisteredAgentDatabases> = [];
  try {
    registeredDatabases = listOpenClawRegisteredAgentDatabases({ env: options.env });
  } catch (error) {
    log.warn("failed to collect registered agent databases for integrity verification", {
      error: String(error),
    });
  }
  for (const registered of registeredDatabases) {
    const agentPath = path.resolve(registered.path);
    if (!existsSync(agentPath) || targets.has(agentPath)) {
      continue;
    }
    targets.set(agentPath, {
      kind: "agent",
      label: `OpenClaw agent database ${registered.agentId}`,
      path: agentPath,
    });
  }
  return [...targets.values()];
}

function createVerificationFailure(result: OpenClawDatabaseVerifyResult): Error {
  const error = new Error(
    result.error ?? `SQLite integrity verification failed for ${result.path}`,
  );
  error.name = "SqliteIntegrityError";
  return error;
}

/** Quarantine terminal failures and log the worker batch. */
export function applyOpenClawDatabaseVerificationResults(options: {
  env: NodeJS.ProcessEnv;
  results: readonly OpenClawDatabaseVerifyResult[];
  targets: readonly OpenClawDatabaseVerifyTarget[];
}): void {
  const targetByPath = new Map(options.targets.map((target) => [target.path, target]));

  for (const result of options.results) {
    const target = targetByPath.get(result.path);
    if (!target) {
      continue;
    }
    if (result.ok) {
      log.info("database integrity verification passed", {
        kind: target.kind,
        label: target.label,
        path: result.path,
      });
      continue;
    }
    if (!result.terminal) {
      log.warn("database integrity verification was inconclusive", {
        kind: target.kind,
        label: target.label,
        path: result.path,
        error: result.error,
      });
      continue;
    }
    const recorded = recordOpenClawDatabaseQuarantine({
      env: options.env,
      kind: target.kind,
      path: result.path,
      reason: result.error ?? `SQLite integrity verification failed for ${result.path}`,
    });
    if (!recorded) {
      // Store unavailable. Daily verification retries persistence.
      log.error("failed to persist database quarantine; quarantine is process-local", {
        kind: target.kind,
        path: result.path,
      });
    }
    const error = createVerificationFailure(result);
    if (target.kind === "state") {
      recordOpenClawStateDatabaseOpenFailure(result.path, error);
    } else {
      recordOpenClawAgentDatabaseOpenFailure(result.path, error);
    }
    log.error("database integrity verification failed", {
      kind: target.kind,
      label: target.label,
      path: result.path,
      error: error.message,
    });
  }
}
