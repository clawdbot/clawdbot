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
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";

const SESSION_STORE_SELECTION_CONTEXT = {
  surface: "session-store selection",
  hint: "Pass --agent <id> to select one agent, or --all-agents to include every configured agent.",
};

function validateExplicitSessionStorePath(storePath: string, agentId: string): string {
  const pathname = path.resolve(storePath);
  if (!fs.existsSync(pathname)) {
    throw new Error(
      `Session store does not exist: ${pathname}. Pass an existing physical .sqlite session store file.`,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(pathname);
  } catch (error) {
    throw new Error(`Could not inspect session store ${pathname}: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!stat.isFile()) {
    throw new Error(
      `Session store is not a regular file: ${pathname}. Pass an existing physical .sqlite session store file.`,
    );
  }
  if (!pathname.endsWith(".sqlite")) {
    throw new Error(
      `Session store must be a physical .sqlite file: ${pathname}. Configured legacy locators are normalized only when --store is omitted.`,
    );
  }

  const target = resolveSqliteTargetFromSessionStorePath(pathname, {
    agentId,
    registeredDatabases: [],
  });
  try {
    const opened = withOpenClawAgentDatabaseReadOnly(() => undefined, {
      agentId: target.agentId ?? agentId,
      path: pathname,
    });
    if (!opened.found) {
      throw new Error(
        opened.reason === "database-missing"
          ? "the file disappeared while it was being opened"
          : `the OpenClaw agent schema is unavailable (${opened.reason})`,
      );
    }
  } catch (error) {
    throw new Error(
      `Session store is not a readable OpenClaw SQLite database: ${pathname}. ${formatErrorMessage(error)}. Pass a database path reported by openclaw sessions or openclaw status.`,
      { cause: error },
    );
  }
  return pathname;
}

/** Validates an operator-supplied physical store path without legacy locator normalization. */
export function resolveExplicitSessionStorePathOrExit(params: {
  storePath: string;
  agentId: string;
  runtime: RuntimeEnv;
  json?: boolean;
}): string | null {
  try {
    return validateExplicitSessionStorePath(params.storePath, params.agentId);
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
    agentId: target.agentId,
    runtime: params.runtime,
    json: params.json,
  });
  return storePath ? [{ ...target, storePath }] : null;
}
