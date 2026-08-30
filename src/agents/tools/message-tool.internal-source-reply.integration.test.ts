// Integration coverage for targetless WebChat tool sends through the internal
// source-reply sink and embedded-run payload projection.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
import { mirrorDeliveredReplyToTranscript } from "../../auto-reply/reply/dispatch-from-config.transcript.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import * as sessionTranscript from "../../config/sessions/transcript.js";
import { persistInternalSourceReply } from "../../gateway/internal-source-reply-persistence.js";
import {
  cleanupManagedOutgoingMediaRecords,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "../../gateway/managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.types.js";
import { createRemoteShellSandboxFsBridge } from "../sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createMessageTool } from "./message-tool-execution.js";

function createCurrentSourceMessageTool(
  params: {
    workspaceDir?: string;
    sandboxFsBridge?: SandboxFsBridge;
    sandboxContainerWorkdir?: string;
    sandboxWorkspaceMediaReadAllowed?: boolean;
  } = {},
) {
  return createMessageTool({
    config: { agents: { entries: { main: { default: true } } } },
    currentChannelProvider: "webchat",
    sourceReplyDeliveryMode: "automatic",
    agentSessionKey: "agent:main:webchat:dm:dashboard",
    runId: "webchat-run",
    workspaceDir: params.workspaceDir,
    sandboxRoot: params.sandboxFsBridge ? params.workspaceDir : undefined,
    sandboxContainerWorkdir: params.sandboxContainerWorkdir,
    sandboxFsBridge: params.sandboxFsBridge,
    sandboxWorkspaceMediaReadAllowed: params.sandboxWorkspaceMediaReadAllowed,
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
        expect(sourceReply?.attachments).toEqual([
          expect.objectContaining({
            name: "proof.txt",
            mimeType: "text/plain",
            trustedLocalMedia: true,
          }),
        ]);
        const mediaPath = sourceReply?.mediaUrls?.[0];
        expect(mediaPath).toBeTruthy();
        await expect(fs.readFile(mediaPath as string)).resolves.toEqual(attachment);
      },
    );
  });

  it("uses policy-scoped bridge access for remote-only current-source media", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-tool-source-remote-media-" },
      async (state) => {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const remoteWorkspaceDir = state.path("remote-workspace");
        await fs.mkdir(remoteWorkspaceDir, { recursive: true });
        await fs.writeFile(path.join(remoteWorkspaceDir, "proof.txt"), "remote proof");
        const sandbox = createSandboxTestContext({
          overrides: {
            backendId: "test",
            workspaceDir: state.workspaceDir,
            agentWorkspaceDir: state.workspaceDir,
            containerWorkdir: "/sandbox",
          },
        });
        const sandboxFsBridge = createRemoteShellSandboxFsBridge({
          sandbox,
          runtime: {
            remoteWorkspaceDir,
            remoteAgentWorkspaceDir: remoteWorkspaceDir,
            runRemoteShellScript: createLocalRemoteShellScriptRunner(),
          },
        });
        const bridgeReadFile = vi.spyOn(sandboxFsBridge, "readFile");
        const tool = createCurrentSourceMessageTool({
          workspaceDir: state.workspaceDir,
          sandboxContainerWorkdir: "/sandbox",
          sandboxFsBridge,
          sandboxWorkspaceMediaReadAllowed: true,
        });

        const toolResult = await tool.execute("message-remote-media-call", {
          action: "send",
          message: "Attached proof.",
          media: "/sandbox/proof.txt",
        });

        const sourceReply = extractMessagingToolSourceReplyPayload(toolResult);
        expect(sourceReply?.mediaUrls).toHaveLength(1);
        await expect(fs.readFile(sourceReply?.mediaUrls?.[0] as string, "utf8")).resolves.toBe(
          "remote proof",
        );

        bridgeReadFile.mockClear();
        const deniedTool = createCurrentSourceMessageTool({
          workspaceDir: state.workspaceDir,
          sandboxContainerWorkdir: "/sandbox",
          sandboxFsBridge,
          sandboxWorkspaceMediaReadAllowed: false,
        });
        await expect(
          deniedTool.execute("message-remote-media-denied", {
            action: "send",
            message: "Attached proof.",
            media: "/sandbox/proof.txt",
          }),
        ).rejects.toThrow(/could not be staged|outside workspace root/i);
        expect(bridgeReadFile).not.toHaveBeenCalled();
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

  it("publishes managed media with aligned metadata and the current run owner", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-internal-source-reply-" },
      async (state) => {
        const stateDir = state.stateDir;
        const workspaceDir = state.workspaceDir;
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const sessionKey = "agent:main:webchat:dm:restart-proof";
        const sessionId = "restart-proof-session";
        const imagePaths = ["first.png", "second.png"].map((name) => path.join(workspaceDir, name));
        const documentPath = path.join(workspaceDir, "report.json");
        await fs.mkdir(workspaceDir, { recursive: true });
        await Promise.all(
          imagePaths.map((imagePath) =>
            fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64")),
          ),
        );
        await fs.writeFile(documentPath, '{"status":"ready"}\n');

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
          mediaUrls: [...imagePaths, documentPath],
        };
        const updates: SessionTranscriptUpdate[] = [];
        const publishedDownloads: Array<Promise<unknown>> = [];
        const unsubscribe = onSessionTranscriptUpdate((update) => {
          updates.push(update);
          const content =
            update.message && typeof update.message === "object"
              ? (update.message as { content?: Array<Record<string, unknown>> }).content
              : undefined;
          for (const block of content?.filter((entry) => entry.type === "image") ?? []) {
            publishedDownloads.push(
              resolveManagedOutgoingMediaArtifactDownload({
                sessionKey,
                agentId: "main",
                artifactId: String(block.artifactId),
                stateDir,
              }),
            );
          }
        });
        const append = sessionTranscript.appendAssistantMessageToSessionTranscript;
        let preCommitCleanup:
          | Awaited<ReturnType<typeof cleanupManagedOutgoingMediaRecords>>
          | undefined;
        const appendSpy = vi
          .spyOn(sessionTranscript, "appendAssistantMessageToSessionTranscript")
          .mockImplementationOnce(async (params) => {
            preCommitCleanup = await cleanupManagedOutgoingMediaRecords({ stateDir });
            return append(params);
          });
        const [toolResult, overlappingResult] = await Promise.all([
          tool.execute("restart-proof-call", sendParams),
          tool.execute("restart-proof-call", sendParams),
        ]).finally(() => {
          unsubscribe();
          appendSpy.mockRestore();
        });
        expect(preCommitCleanup).toEqual({
          deletedRecordCount: 0,
          deletedFileCount: 0,
          retainedCount: 3,
        });
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
        expect(sourcePayloads[0]).toMatchObject({
          attachments: [
            expect.objectContaining({ name: "first.png", trustedLocalMedia: true }),
            expect.objectContaining({ name: "second.png", trustedLocalMedia: true }),
            expect.objectContaining({
              name: "report.json",
              mimeType: "application/json",
              trustedLocalMedia: true,
            }),
          ],
          trustedLocalMedia: true,
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
        const document = content.find((block) => block.type === "attachment");
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
        expect(document).toMatchObject({
          type: "attachment",
          attachment: {
            artifactId: expect.stringMatching(/^artifact_managed_media_/u),
            kind: "document",
            label: "report.json",
            mimeType: "application/json",
          },
        });
        expect(JSON.stringify(assistant)).not.toContain(workspaceDir);
        expect(listManagedImageRecordEntries({ stateDir, sessionKey })).toHaveLength(3);
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
        await expect(Promise.all(publishedDownloads)).resolves.toEqual([
          expect.objectContaining({ type: "image" }),
          expect.objectContaining({ type: "image" }),
        ]);
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
        const documentAttachment = document?.attachment as { artifactId?: unknown } | undefined;
        await expect(
          resolveManagedOutgoingMediaArtifactDownload({
            sessionKey,
            agentId: "main",
            artifactId: String(documentAttachment?.artifactId),
            stateDir,
          }),
        ).resolves.toMatchObject({ type: "file", title: "report.json" });
      },
    );
  });

  it.each([
    "rejected",
    "throws-before-commit",
    "conflicting-writer",
    "lifecycle-drain-failure",
  ] as const)("cleans only uncommitted source-reply originals when append %s", async (outcome) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "source-reply-append-outcome-" },
      async (state) => {
        const sessionKey = "agent:main:webchat:dm:append-outcome";
        const sessionId = "append-outcome-session";
        const storePath = path.join(state.stateDir, "agents", "main", "sessions", "sessions.json");
        const scope = { agentId: "main", sessionKey, sessionId, storePath };
        const imagePath = path.join(state.workspaceDir, "proof.png");
        await fs.mkdir(state.workspaceDir, { recursive: true });
        await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
        await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
        const append = sessionTranscript.appendAssistantMessageToSessionTranscript;
        const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ sessionId });
        const preparedOriginals: string[] = [];
        const appendSpy = vi
          .spyOn(sessionTranscript, "appendAssistantMessageToSessionTranscript")
          .mockImplementationOnce(async (params) => {
            for (const { record } of listManagedImageRecordEntries({
              stateDir: state.stateDir,
              sessionKey,
            })) {
              preparedOriginals.push(
                path.join(
                  record.original.mediaRoot,
                  record.original.mediaSubdir,
                  record.original.mediaId,
                ),
              );
            }
            if (outcome === "rejected") {
              return { ok: false, code: "session-rebound", reason: "session rebound" };
            }
            if (outcome === "throws-before-commit") {
              throw new Error("append failed before commit");
            }
            if (outcome === "conflicting-writer") {
              // Another writer wins after the source-reply owner's initial lookup.
              await append({
                ...params,
                eventId: "winning-message",
                content: [{ type: "text", text: "Already delivered" }],
                onMessageCommitted: undefined,
              });
              return append(params);
            }
            return append(params);
          });
        try {
          const persist = () =>
            persistInternalSourceReply({
              cfg: {
                agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
              },
              sessionKey,
              expectedSessionId: sessionId,
              agentId: "main",
              idempotencyKey: "append-outcome-reply",
              sourceReplyFinal: true,
              payload: { text: "Attached proof", mediaUrls: [imagePath], trustedLocalMedia: true },
            });
          const persistence =
            outcome === "lifecycle-drain-failure"
              ? withOwnedSessionTranscriptWrites(
                  {
                    sessionKey,
                    sessionTarget: scope,
                    withTranscriptWrite: (run) =>
                      lifecycle.withTranscriptWrite(async () => {
                        const result = await run();
                        // This is an actual nested lifecycle failure after the transcript commits.
                        void lifecycle
                          .withTranscriptWrite(() => {
                            throw new Error("nested drain failed");
                          })
                          .catch(() => {});
                        return result;
                      }),
                  },
                  persist,
                )
              : persist();
          await expect(persistence).rejects.toThrow(
            outcome === "rejected"
              ? "session rebound"
              : outcome === "conflicting-writer"
                ? "conflicts with the admitted message"
                : outcome === "lifecycle-drain-failure"
                  ? "nested drain failed"
                  : "append failed before commit",
          );
        } finally {
          appendSpy.mockRestore();
          await lifecycle.dispose();
        }
        expect(preparedOriginals).toHaveLength(1);
        const committed = outcome === "lifecycle-drain-failure";
        const records = listManagedImageRecordEntries({ stateDir: state.stateDir, sessionKey });
        expect(records).toHaveLength(committed ? 1 : 0);
        for (const original of preparedOriginals) {
          if (committed) {
            await expect(fs.readFile(original)).resolves.toEqual(
              Buffer.from(TINY_PNG_BASE64, "base64"),
            );
          } else {
            await expect(fs.stat(original)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
        const assistants = (await loadTranscriptEvents(scope)).filter(
          (event) => readTranscriptEventMessage(event)?.role === "assistant",
        );
        expect(assistants).toHaveLength(committed || outcome === "conflicting-writer" ? 1 : 0);
        if (committed) {
          expect(records[0]?.record).toMatchObject({
            messageId: readTranscriptEventId(assistants[0]),
            retentionClass: "history",
          });
          await expect(
            resolveManagedOutgoingMediaArtifactDownload({
              sessionKey,
              agentId: "main",
              stateDir: state.stateDir,
              artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${records[0]?.record.attachmentId}`,
            }),
          ).resolves.toMatchObject({ type: "image" });
        }
        if (outcome === "conflicting-writer") {
          expect(assistants[0]).toMatchObject({
            id: "winning-message",
            message: { content: [{ type: "text", text: "Already delivered" }] },
          });
        }
      },
    );
  });
});
