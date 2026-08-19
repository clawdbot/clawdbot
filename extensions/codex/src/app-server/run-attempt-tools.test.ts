import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";

function createAttemptParams(
  overrides: Partial<EmbeddedRunAttemptParams> = {},
): EmbeddedRunAttemptParams {
  return overrides as EmbeddedRunAttemptParams;
}

describe("resolveCodexDynamicToolDirectNames", () => {
  it("preserves ring-zero and message tools alongside progress_card", () => {
    const ringZeroParams = createAttemptParams({ toolsAllow: ["openclaw"] });
    const messageParams = createAttemptParams({ sourceReplyDeliveryMode: "message_tool_only" });

    expect(resolveCodexDynamicToolDirectNames(ringZeroParams, true)).toEqual([
      "openclaw",
      "progress_card",
    ]);
    expect(resolveCodexDynamicToolDirectNames(messageParams)).toEqual(["message", "progress_card"]);
  });
});
