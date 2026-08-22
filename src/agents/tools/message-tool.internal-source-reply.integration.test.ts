// Integration coverage for targetless WebChat tool sends through the internal
// source-reply sink and embedded-run payload projection.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { createMessageTool } from "./message-tool-execution.js";

function createCurrentSourceMessageTool(params: { workspaceDir?: string } = {}) {
  return createMessageTool({
    config: { agents: { entries: { main: { default: true } } } },
    currentChannelProvider: "webchat",
    sourceReplyDeliveryMode: "automatic",
    agentSessionKey: "agent:main:webchat:dm:dashboard",
    runId: "webchat-run",
    workspaceDir: params.workspaceDir,
    getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
    resolveCommandSecretRefsViaGateway: async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
  });
}

describe("WebChat message tool internal source reply", () => {
  it("projects a real targetless send and preserves the automatic final reply", async () => {
    const tool = createCurrentSourceMessageTool();

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
      lastAssistant: undefined,
      currentAssistant: undefined,
      sessionKey: "agent:main:webchat:dm:dashboard",
      sourceReplyDeliveryMode: "automatic",
      messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
      runId: "webchat-run",
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

  it("stages buffer media before acknowledging the current-source send", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-source-buffer-" },
      async (state) => {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const tool = createCurrentSourceMessageTool({ workspaceDir: state.workspaceDir });
        const attachment = Buffer.from("current-source attachment");

        const toolResult = await tool.execute("message-buffer-call", {
          action: "send",
          message: "Attached proof.",
          buffer: attachment.toString("base64"),
          filename: "proof.txt",
          contentType: "text/plain",
        });

        const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
        expect(sourceReply).toMatchObject({ text: "Attached proof." });
        expect(sourceReply?.mediaUrls).toHaveLength(1);
        const mediaPath = sourceReply?.mediaUrls?.[0];
        expect(mediaPath).toBeTruthy();
        await expect(fs.readFile(mediaPath as string)).resolves.toEqual(attachment);
      },
    );
  });

  it("rejects disallowed local media before acknowledging the current-source send", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-source-path-" },
      async (state) => {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const outsidePath = state.path("outside", "blocked.png");
        await fs.mkdir(path.dirname(outsidePath), { recursive: true });
        await fs.writeFile(outsidePath, "blocked");
        const tool = createCurrentSourceMessageTool({ workspaceDir: state.workspaceDir });

        await expect(
          tool.execute("message-path-call", {
            action: "send",
            message: "Attached proof.",
            media: outsidePath,
          }),
        ).rejects.toThrow(/could not be staged|allowed directory/i);
      },
    );
  });
});
