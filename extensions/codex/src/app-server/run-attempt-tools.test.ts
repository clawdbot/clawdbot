import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolSpecs, projectCodexDynamicTools } from "./dynamic-tool-catalog.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";

function createAttemptParams(
  overrides: Partial<EmbeddedRunAttemptParams> = {},
): EmbeddedRunAttemptParams {
  return overrides as EmbeddedRunAttemptParams;
}

describe("Codex direct tool loading", () => {
  const projectTool = (name: string) =>
    projectCodexDynamicTools([
      { name, description: `Use ${name}`, parameters: { type: "object", properties: {} } },
    ]).tools;

  it("keeps the available ring-zero tool directly callable", () => {
    const params = createAttemptParams({ toolsAllow: ["openclaw"] });
    expect(
      createCodexDynamicToolSpecs({
        entries: projectTool("openclaw"),
        loading: "searchable",
        directToolNames: resolveCodexDynamicToolDirectNames(params, projectTool("openclaw"), true),
      }),
    ).toEqual([expect.objectContaining({ type: "function", name: "openclaw" })]);
  });

  it.each([false, true])(
    "keeps registered catalog bytes stable and enforces message availability when disabled=%s",
    async (disableMessageTool) => {
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "sent" }],
        details: {},
      }));
      const tool: AnyAgentTool = {
        name: "message",
        label: "Message",
        description: "Send messages",
        parameters: Type.Object({}),
        execute,
      };
      const bridges = (["automatic", "message_tool_only", "automatic"] as const).map(
        (sourceReplyDeliveryMode) =>
          createCodexDynamicToolBridge({
            tools: disableMessageTool ? [] : [tool],
            registeredTools: [tool],
            signal: new AbortController().signal,
            loading: "searchable",
            directToolNames: resolveCodexDynamicToolDirectNames(
              createAttemptParams({ sourceReplyDeliveryMode, disableMessageTool }),
              [tool],
            ),
          }),
      );

      expect(JSON.stringify(bridges[1]?.specs)).toBe(JSON.stringify(bridges[0]?.specs));
      expect(JSON.stringify(bridges[2]?.specs)).toBe(JSON.stringify(bridges[0]?.specs));
      expect(
        bridges[0]?.specs.some((spec) => spec.type === "function" && spec.name === "message"),
      ).toBe(true);
      if (disableMessageTool) {
        for (const bridge of bridges) {
          expect(bridge.availableSpecs).toEqual([]);
          const result = await bridge.handleToolCall({
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "disabled-message",
            namespace: "openclaw",
            tool: "message",
            arguments: {},
          });
          expect(result.success).toBe(false);
        }
        expect(execute).not.toHaveBeenCalled();
      }
    },
  );
});
