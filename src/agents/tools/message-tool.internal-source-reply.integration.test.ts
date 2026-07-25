// Integration coverage for targetless WebChat tool sends through the internal
// source-reply sink and embedded-run payload projection.
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-subscribe.tools.js";
import { createMessageTool } from "./message-tool.js";

describe("WebChat message tool internal source reply", () => {
  it("projects a real targetless send and preserves the automatic final reply", async () => {
    const tool = createMessageTool({
      config: {},
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "automatic",
      agentSessionKey: "agent:main:webchat:dm:dashboard",
      runId: "webchat-run",
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });

    const toolResult = await tool.execute("message-call", {
      action: "send",
      message: "Visible progress from the message tool.",
    });
    expect(toolResult.details).toMatchObject({
      channel: "webchat",
      target: "current-run",
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplySink: "internal-ui",
      sourceReply: { text: "Visible progress from the message tool." },
    });

    const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
    expect(sourceReply).toMatchObject({ text: "Visible progress from the message tool." });

    const embeddedPayloads = buildEmbeddedRunPayloads({
      assistantTexts: ["Visible automatic final reply."],
      toolMetas: [],
      lastAssistant: undefined,
      currentAssistant: undefined,
      sessionKey: "agent:main:webchat:dm:dashboard",
      sourceReplyDeliveryMode: "automatic",
      messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
      runId: "webchat-run",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
    });
    const { replyPayloads: payloads } = await buildReplyPayloads({
      payloads: embeddedPayloads,
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
      messagingToolSentTexts: ["Visible progress from the message tool."],
    });

    expect(payloads.map((payload) => payload.text)).toEqual([
      "Visible progress from the message tool.",
      "Visible automatic final reply.",
    ]);
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:webchat:dm:dashboard",
        text: "Visible progress from the message tool.",
        idempotencyKey: "webchat-run:internal-source-reply:0",
      },
    });
    expect(getReplyPayloadMetadata(payloads[1] as object)?.sourceReplyTranscriptMirror).toBe(
      undefined,
    );
  });
});
