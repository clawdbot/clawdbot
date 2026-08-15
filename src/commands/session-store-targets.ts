import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
/**
 * Session store target resolution wrapper for CLI commands.
 *
 * The config helper throws on invalid agent/store combinations; this module
 * converts those errors into command output and exit codes.
 */
import {
  resolveSessionStoreTargets,
  type SessionStoreSelectionOptions,
  type SessionStoreTarget,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";

const SESSION_STORE_SELECTION_CONTEXT = {
  surface: "session-store selection",
  hint: "Pass --agent <id> to select one agent, or --all-agents to include every configured agent.",
};

/** Resolves session store targets or exits the current command on validation errors. */
export function resolveSessionStoreTargetsOrExit(params: {
  cfg: OpenClawConfig;
  opts: SessionStoreSelectionOptions;
  runtime: RuntimeEnv;
}): SessionStoreTarget[] | null {
  try {
    return resolveSessionStoreTargets(params.cfg, params.opts);
  } catch (error) {
    const displayError =
      error instanceof AgentSelectionRequiredError
        ? new AgentSelectionRequiredError(error.agentIds, SESSION_STORE_SELECTION_CONTEXT)
        : error;
    params.runtime.error(formatErrorMessage(displayError));
    params.runtime.exit(1);
    return null;
  }
}
