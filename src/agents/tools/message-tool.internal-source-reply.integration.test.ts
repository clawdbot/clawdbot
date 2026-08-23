// Integration coverage for targetless WebChat tool sends through the internal
// source-reply sink and embedded-run payload projection.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { mirrorDeliveredReplyToTranscript } from "../../auto-reply/reply/dispatch-from-config.transcript.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveManagedOutgoingMediaArtifactDownload } from "../../gateway/managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
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

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

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

  it("publishes managed images with the current run owner", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-internal-source-reply-" },
      async (state) => {
        const stateDir = state.stateDir;
        const workspaceDir = state.workspaceDir;
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const sessionKey = "agent:main:webchat:dm:restart-proof";
        const sessionId = "restart-proof-session";
        const imagePaths = ["first.png", "second.png"].map((name) => path.join(workspaceDir, name));
        await fs.mkdir(workspaceDir, { recursive: true });
        await Promise.all(
          imagePaths.map((imagePath) =>
            fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64")),
          ),
        );

        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath },
          { sessionId, chatType: "direct", updatedAt: 1 },
        );
        const config = {
          agents: {
            entries: {
              main: { default: true, workspace: workspaceDir },
            },
          },
        };
        const tool = createMessageTool({
          config,
          currentChannelProvider: "webchat",
          agentSessionKey: sessionKey,
          runSessionKey: sessionKey,
          sessionId,
          agentId: "main",
          runId: "restart-proof-run",
          getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
          resolveCommandSecretRefsViaGateway: async () => ({
            resolvedConfig: config,
            diagnostics: [],
            targetStatesByPath: {},
            hadUnresolvedTargets: false,
          }),
        });

        const sendParams = {
          action: "send" as const,
          message: "Durable image reply",
          mediaUrls: imagePaths,
        };
        const updates: SessionTranscriptUpdate[] = [];
        const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
        const [toolResult, overlappingResult] = await Promise.all([
          tool.execute("restart-proof-call", sendParams),
          tool.execute("restart-proof-call", sendParams),
        ]).finally(unsubscribe);
        const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
        expect(sourceReply).toMatchObject({ transcriptOwner: true });
        expect(overlappingResult.details).toMatchObject({
          idempotencyKey: sourceReply?.idempotencyKey,
          sourceReplyTranscriptOwner: true,
        });
        const sourcePayloads = buildEmbeddedRunPayloads({
          assistantTexts: [],
          lastAssistant: undefined,
          currentAssistant: undefined,
          sessionKey,
          agentId: "main",
          sourceReplyDeliveryMode: "message_tool_only",
          messagingToolSourceReplyPayloads: sourceReply ? [sourceReply] : [],
          runId: "restart-proof-run",
          verboseLevel: "off",
          reasoningLevel: "off",
          toolResultFormat: "plain",
        });
        const mirror = getReplyPayloadMetadata(
          sourcePayloads[0] as object,
        )?.sourceReplyTranscriptMirror;
        expect(mirror).toMatchObject({ transcriptOwner: true });
        await mirrorDeliveredReplyToTranscript({
          metadata: mirror ? { ...mirror, expectedSessionId: sessionId, storePath } : undefined,
          cfg: config,
        });
        const events = await loadTranscriptEvents({
          agentId: "main",
          sessionId,
          sessionKey,
          storePath,
        });
        const assistants = events
          .map((event) => (event as { message?: Record<string, unknown> }).message)
          .filter((message) => message?.role === "assistant");
        expect(assistants).toHaveLength(1);
        const assistant = assistants[0];
        const content = Array.isArray(assistant?.content)
          ? (assistant.content as Array<Record<string, unknown>>)
          : [];
        const image = content.find((block) => block.type === "image");
        expect(toolResult.details).toMatchObject({
          sourceReplySink: "internal-ui",
          idempotencyKey: expect.any(String),
        });
        expect(content[0]).toEqual({ type: "text", text: "Durable image reply" });
        expect(image).toMatchObject({
          type: "image",
          artifactId: expect.stringMatching(/^artifact_managed_image_/u),
        });
        expect(content.filter((block) => block.type === "image")).toHaveLength(2);
        expect(JSON.stringify(assistant)).not.toContain(workspaceDir);
        expect(listManagedImageRecordEntries({ stateDir, sessionKey })).toHaveLength(2);
        const published = updates.find(
          (update) =>
            update.runId === "restart-proof-run" &&
            update.message &&
            typeof update.message === "object" &&
            (update.message as { role?: unknown }).role === "assistant",
        );
        expect(published).toMatchObject({
          runId: "restart-proof-run",
          target: { agentId: "main", sessionId, sessionKey },
        });
        const publishedContent = (
          published?.message as { content?: Array<Record<string, unknown>> }
        )?.content;
        expect(publishedContent?.filter((block) => block.type === "image")).toHaveLength(2);
        for (const block of content.filter((entry) => entry.type === "image")) {
          await expect(
            resolveManagedOutgoingMediaArtifactDownload({
              sessionKey,
              agentId: "main",
              artifactId: String(block.artifactId),
              stateDir,
            }),
          ).resolves.toMatchObject({ type: "image" });
        }
      },
    );
  });
});
