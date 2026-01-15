import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ReportBackToolSchema = Type.Object({
  message: Type.String({ description: "The results/findings to report back to the main session" }),
});

/**
 * Creates a report_back tool for subagents to report results to the main session.
 *
 * When called:
 * 1. Injects the message into the main session transcript (so main agent sees it)
 * 2. Broadcasts to webchat UI (shows in gateway dashboard)
 *
 * The main agent then summarizes/responds in its own voice.
 */
export function createReportBackTool(opts?: {
  /** The subagent's session key */
  agentSessionKey?: string;
  /** Optional label for the subagent (e.g., task description) */
  label?: string;
}): AnyAgentTool {
  return {
    label: "Report Back",
    name: "report_back",
    description:
      "Report results back to the main session. Use this when your task is complete to share findings with the main agent. The main agent will summarize your report in their own voice.",
    parameters: ReportBackToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message", { required: true });

      // Only subagents can use report_back
      if (!opts?.agentSessionKey || !isSubagentSessionKey(opts.agentSessionKey)) {
        return jsonResult({
          status: "forbidden",
          error: "report_back is only available to subagents",
        });
      }

      const cfg = loadConfig();
      const mainSessionKey = resolveMainSessionKey(cfg);
      const label = opts?.label ? `Subagent "${opts.label}"` : "Subagent";

      try {
        // 1. Inject into main session transcript via chat.inject (shows in webchat)
        await callGateway({
          method: "chat.inject",
          params: {
            sessionKey: mainSessionKey,
            message,
            label: `${label} reported`,
          },
          timeoutMs: 10_000,
        });

        // 2. Trigger main agent to respond (it will see the report in transcript)
        await callGateway({
          method: "agent",
          params: {
            sessionKey: mainSessionKey,
            message: `[Subagent completed${opts?.label ? `: ${opts.label}` : ""}]`,
            deliver: true,
          },
          timeoutMs: 60_000,
        });

        return jsonResult({
          status: "ok",
          message: "Report sent and main agent notified",
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          error: errorMessage,
        });
      }
    },
  };
}
