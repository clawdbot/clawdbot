import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { createClaudeDynamicToolBridge } from "./dynamic-tools.js";

/**
 * Regression pin for the delivery-accounting blind spot: the bridge collected
 * `didSendViaMessagingTool` and the `messagingToolSent*` fields but never
 * `didDeliverSourceReplyViaMessageTool` or the per-send `sourceReplyFinal`
 * markers. `hasCompletedSourceReplyDeliveryEvidence` reads exactly those two,
 * so it was false for every claude-bridge turn — `message_tool_only` runs
 * recorded `mute` 6397 times out of 6397 across five agents over seven days,
 * even for turns that visibly answered in the source channel.
 */

/** A settled delivery fact, the shape `readEmbeddedMessageDeliveryFact` accepts. */
const SETTLED = {
  details: {
    messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
  },
};

function messageTool(result: unknown = SETTLED): AnyAgentTool {
  return {
    name: "message",
    description: "test message tool",
    parameters: { type: "object", additionalProperties: true },
    execute: async () => result,
  } as unknown as AnyAgentTool;
}

async function callMessageTool(params: {
  args: Record<string, unknown>;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  result?: unknown;
}) {
  const bridge = createClaudeDynamicToolBridge({
    tools: [messageTool(params.result ?? SETTLED)],
    hookContext: params.sourceReplyDeliveryMode
      ? { sourceReplyDeliveryMode: params.sourceReplyDeliveryMode }
      : {},
  });
  await bridge.handleToolCall({
    tool: "message",
    callId: "call-1",
    threadId: "thr",
    turnId: "turn",
    arguments: params.args,
  });
  return bridge.telemetry;
}

describe("claude dynamic-tool source-reply attribution", () => {
  it("credits a bare message(action=send) in message_tool_only as a final source reply", async () => {
    const telemetry = await callMessageTool({
      sourceReplyDeliveryMode: "message_tool_only",
      args: { action: "send", message: "⚡ answering in-channel" },
    });
    expect(telemetry.didSendViaMessagingTool).toBe(true);
    expect(telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(telemetry.messagingToolSentTargets).toHaveLength(1);
    expect(telemetry.messagingToolSentTargets[0]?.sourceReplyFinal).toBe(true);
  });

  it("marks final:false progress sends as non-final while still crediting delivery", async () => {
    const telemetry = await callMessageTool({
      sourceReplyDeliveryMode: "message_tool_only",
      args: { action: "send", message: "💬 still working", final: false },
    });
    expect(telemetry.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(telemetry.messagingToolSentTargets[0]?.sourceReplyFinal).toBe(false);
  });

  it("does not credit a send that carries an explicit non-source route", async () => {
    const telemetry = await callMessageTool({
      sourceReplyDeliveryMode: "message_tool_only",
      args: { action: "send", message: "elsewhere", to: "C0OTHER", channel: "slack" },
    });
    expect(telemetry.didSendViaMessagingTool).toBe(true);
    expect(telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
    expect(telemetry.messagingToolSentTargets[0]?.sourceReplyFinal).toBeUndefined();
  });

  it("does not credit a source reply outside message_tool_only mode", async () => {
    const telemetry = await callMessageTool({
      sourceReplyDeliveryMode: "automatic",
      args: { action: "send", message: "automatic mode reply" },
    });
    expect(telemetry.didSendViaMessagingTool).toBe(true);
    expect(telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });

  it("does not credit a send whose delivery never settled", async () => {
    const telemetry = await callMessageTool({
      sourceReplyDeliveryMode: "message_tool_only",
      args: { action: "send", message: "never landed" },
      result: {
        details: {
          messageDelivery: { status: "suppressed", partialDelivery: false, createdThreadIds: [] },
        },
      },
    });
    expect(telemetry.didDeliverSourceReplyViaMessageTool).toBe(false);
  });
});
