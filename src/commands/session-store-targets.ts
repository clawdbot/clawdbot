import fs from "node:fs";
import path from "node:path";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import {
  resolveSessionStoreTargets,
  type SessionStoreSelectionOptions,
  type SessionStoreTarget,
} from "../config/sessions.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";

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

export function resolveExplicitSessionStorePath(params: {
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
  let stat: fs.Stats | undefined;
  let statFailure: { error: unknown } | undefined;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (error) {
    statFailure = { error };
  }
  if (statFailure) {
    const error = statFailure.error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `Session store target does not exist: ${displayTarget}. Pass a selector whose resolved SQLite target exists.`,
      );
    }
    throw new Error(
      `Could not inspect session store target ${displayTarget}: ${formatErrorMessage(error)}`,
    );
  }
  if (!stat?.isFile()) {
    throw new Error(
      `Session store target is not a regular file: ${displayTarget}. Pass a selector whose resolved SQLite target is a regular file.`,
    );
  }

  let database;
  let databaseFailure: { error: unknown } | undefined;
  try {
    database = openNodeSqliteDatabase(resolvedPath, { readOnly: true });
    const applicationTables =
      // sqlite-allow-raw -- Schema introspection distinguishes empty repair targets from foreign DBs.
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all();
    if (
      applicationTables.length > 0 &&
      !applicationTables.some((row) => row.name === "schema_meta")
    ) {
      throw new Error("the SQLite file has application tables but no OpenClaw schema metadata");
    }
  } catch (error) {
    databaseFailure = { error };
  } finally {
    database?.close();
  }
  if (databaseFailure) {
    throw new Error(
      `Session store target is not a session store: ${displayTarget}. ${formatErrorMessage(databaseFailure.error)}. Pass a legacy store selector or SQLite target reported by openclaw sessions or openclaw status.`,
    );
  }
  return storePath;
}

/** Selection failures reach the root CLI handler for shared JSON output and cleanup. */
export function resolveCommandSessionStoreTargets(params: {
  cfg: OpenClawConfig;
  opts: SessionStoreSelectionOptions;
}): SessionStoreTarget[] {
  try {
    const targets = resolveSessionStoreTargets(params.cfg, params.opts);
    if (!params.opts.store) {
      return targets;
    }
    const target = targets[0];
    if (!target) {
      throw new Error("Explicit session store selection did not resolve a target.");
    }
    return [
      {
        ...target,
        storePath: resolveExplicitSessionStorePath({
          ...target,
          inputStorePath: params.opts.store,
        }),
      },
    ];
  } catch (error) {
    const message = formatErrorMessage(
      error instanceof AgentSelectionRequiredError
        ? new AgentSelectionRequiredError(error.agentIds, SESSION_STORE_SELECTION_CONTEXT)
        : error,
    );
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }
}
