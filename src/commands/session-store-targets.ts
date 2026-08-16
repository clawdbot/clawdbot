/**
 * Session store target resolution wrapper for CLI commands.
 *
 * The config helper throws on invalid agent/store combinations; this module
 * converts those errors into command output and exit codes.
 */
import fs from "node:fs";
import path from "node:path";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import {
  resolveSessionStoreTargets,
  type SessionStoreSelectionOptions,
  type SessionStoreTarget,
} from "../config/sessions.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

const SESSION_STORE_SELECTION_CONTEXT = {
  surface: "session-store selection",
  hint: "Pass --agent <id> to select one agent, or --all-agents to include every configured agent.",
};

function formatResolvedStoreTarget(params: {
  inputStorePath: string;
  resolvedPath: string;
  storePath: string;
}): string {
  return path.resolve(params.storePath) === params.resolvedPath
    ? params.resolvedPath
    : `${params.resolvedPath} (resolved from --store ${JSON.stringify(params.inputStorePath)})`;
}

function validateExplicitSessionStorePath(params: {
  agentId: string;
  inputStorePath: string;
  storePath: string;
}): string {
  const storePath = path.resolve(params.storePath);
  const resolvedPath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: params.agentId,
  }).path;
  const displayTarget = formatResolvedStoreTarget({
    inputStorePath: params.inputStorePath,
    resolvedPath,
    storePath,
  });
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Session store target does not exist: ${displayTarget}. Pass a selector whose resolved SQLite target exists.`,
        { cause: error },
      );
    }
    throw new Error(
      `Could not inspect session store target ${displayTarget}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Session store target is not a regular file: ${displayTarget}. Pass a selector whose resolved SQLite target is a regular file.`,
    );
  }

  let database;
  try {
    database = openNodeSqliteDatabase(resolvedPath, { readOnly: true });
    const applicationTables = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name?: unknown }>;
    if (
      applicationTables.length > 0 &&
      !applicationTables.some((row) => row.name === "schema_meta")
    ) {
      throw new Error("the SQLite file has application tables but no OpenClaw schema metadata");
    }
  } catch (error) {
    throw new Error(
      `Session store target is not a session store: ${displayTarget}. ${formatErrorMessage(error)}. Pass a legacy store selector or SQLite target reported by openclaw sessions or openclaw status.`,
      { cause: error },
    );
  } finally {
    database?.close();
  }
  return storePath;
}

/** Resolves and validates an operator-supplied legacy selector without changing its semantics. */
export function resolveExplicitSessionStorePathOrExit(params: {
  storePath: string;
  inputStorePath?: string;
  agentId: string;
  runtime: RuntimeEnv;
  json?: boolean;
}): string | null {
  try {
    return validateExplicitSessionStorePath({
      agentId: params.agentId,
      inputStorePath: params.inputStorePath ?? params.storePath,
      storePath: params.storePath,
    });
  } catch (error) {
    return exitSessionStoreError(params, error);
  }
}

function exitSessionStoreError(
  params: { runtime: RuntimeEnv; json?: boolean },
  error: unknown,
): null {
  const message = formatErrorMessage(error);
  if (params.json) {
    writeRuntimeJson(params.runtime, { error: message });
  } else {
    params.runtime.error(message);
  }
  params.runtime.exit(1);
  return null;
}

/** Resolves session store targets or exits the current command on validation errors. */
export function resolveSessionStoreTargetsOrExit(params: {
  cfg: OpenClawConfig;
  opts: SessionStoreSelectionOptions;
  runtime: RuntimeEnv;
  json?: boolean;
}): SessionStoreTarget[] | null {
  let targets: SessionStoreTarget[];
  try {
    targets = resolveSessionStoreTargets(params.cfg, params.opts);
  } catch (error) {
    const displayError =
      error instanceof AgentSelectionRequiredError
        ? new AgentSelectionRequiredError(error.agentIds, SESSION_STORE_SELECTION_CONTEXT)
        : error;
    return exitSessionStoreError(params, displayError);
  }
  if (!params.opts.store) {
    return targets;
  }
  const target = targets[0];
  if (!target) {
    return exitSessionStoreError(
      params,
      new Error("Explicit session store selection did not resolve a target."),
    );
  }
  const storePath = resolveExplicitSessionStorePathOrExit({
    storePath: target.storePath,
    inputStorePath: params.opts.store,
    agentId: target.agentId,
    runtime: params.runtime,
    json: params.json,
  });
  return storePath ? [{ ...target, storePath }] : null;
}
