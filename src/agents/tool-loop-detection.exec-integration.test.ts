import { describe, expect, it } from "vitest";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

const CRITICAL_THRESHOLD = 20;

describe("exec loop detection integration", () => {
  it.runIf(process.platform !== "win32")(
    "blocks repeated real shell failures despite changing diagnostics",
    async () => {
      const state: SessionState = {
        lastActivity: Date.now(),
        state: "processing",
        queueDepth: 0,
      };
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: false,
      });
      const params = {
        command: `printf 'failed-pid=%s\n' "$$" >&2; command openclaw_command_that_does_not_exist`,
      };
      const outputs = new Set<string>();

      for (let index = 0; index < CRITICAL_THRESHOLD; index += 1) {
        const toolCallId = `exec-${index}`;
        recordToolCall(state, "exec", params, toolCallId);
        const result = await tool.execute(toolCallId, params);
        expect(result.details).toMatchObject({
          status: "failed",
          exitCode: 127,
          failureKind: "shell-command-not-found",
        });
        if (result.details.status === "failed") {
          outputs.add(result.details.aggregated);
        }
        recordToolCallOutcome(state, {
          toolName: "exec",
          toolParams: params,
          toolCallId,
          result,
        });
      }

      expect(outputs.size).toBeGreaterThan(1);
      expect(detectToolCallLoop(state, "exec", params, { enabled: true })).toMatchObject({
        stuck: true,
        level: "critical",
        detector: "generic_repeat",
        count: CRITICAL_THRESHOLD,
      });
    },
  );
});
