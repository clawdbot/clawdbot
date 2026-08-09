import { hasAgentRosterProperty } from "../agents/agent-scope-config.js";
import type { ConfigValidationIssue } from "./types.openclaw.js";

/** Persisted configs must name their roster; only a missing config file gets a fresh roster. */
export function collectMissingPersistedAgentRosterIssue(raw: unknown): ConfigValidationIssue[] {
  return hasAgentRosterProperty(raw)
    ? []
    : [
        {
          path: "agents.entries",
          message:
            'persisted config must define an explicit agent roster; run "openclaw doctor --fix"',
        },
      ];
}
