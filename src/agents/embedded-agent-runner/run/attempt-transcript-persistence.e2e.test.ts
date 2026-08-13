import fs from "node:fs/promises";
import path from "node:path";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { createOpenClawAgentHarness } from "../../harness/builtin-openclaw.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { convertToLlm } from "../../sessions/messages.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { flushSessionManagerTranscript } from "./attempt-transcript-helpers.js";
import { materializeProviderContext } from "./images.js";

const runEmbeddedAttempt = vi.hoisted(() => vi.fn());

vi.mock("./attempt.js", () => ({ runEmbeddedAttempt }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MP4 = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("embedded attempt transcript persistence", () => {
  it("omits the host-private settled-turn recovery prompt from the raw transcript", async () => {
    const dir = tempDirs.make("openclaw-settled-turn-finalization-");
    const target = {
      agentId: "main",
      sessionId: "settled-turn-finalization",
      sessionKey: "agent:main:settled-turn-finalization",
      storePath: path.join(dir, "sessions.json"),
    };
    const recoveryPrompt =
      "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";
    const finalAssistant = buildAssistantMessage("Recovered final answer.");
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(target, {
      cwd: dir,
      eventId: "original-user",
      message: { role: "user", content: "Original operator request." },
      now: 1,
    });

    runEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      const finalization = attempt as {
        prompt: string;
        suppressNextUserMessagePersistence?: boolean;
      };
      const sessionManager = guardSessionManager(SessionManager.open(target, dir), {
        skipBeforeMessageWriteHooks: true,
        suppressNextUserMessagePersistence: finalization.suppressNextUserMessagePersistence,
      });
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: finalization.prompt }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage(finalAssistant);
      flushSessionManagerTranscript(sessionManager);
      return {
        terminal: { kind: "ok" },
        sessionIdUsed: target.sessionId,
        messagesSnapshot: [finalAssistant],
        assistantTexts: ["Recovered final answer."],
        toolMetas: [],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
        didSendViaMessagingTool: false,
        didDeliverSourceReplyViaMessageTool: false,
        didSendDeterministicApprovalPrompt: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSourceReplyPayloads: [],
        hasToolMediaBlockReply: false,
        cloudCodeAssistFormatError: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      } as never;
    });

    await createOpenClawAgentHarness().finalizeSettledTurn?.({
      attempt: { prompt: recoveryPrompt } as never,
      settledAttempt: {} as never,
    });

    const raw = await readSessionTranscriptRawDelta({
      ...target,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    const serialized = JSON.stringify(raw);
    expect(serialized).toContain("Original operator request.");
    expect(serialized).toContain("Recovered final answer.");
    expect(serialized).not.toContain(recoveryPrompt);
  });

  it("replays native video after reopening the canonical transcript", async () => {
    const stateDir = tempDirs.make("openclaw-video-transcript-replay-");
    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, "history.mp4"), MP4);
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const target = {
      agentId: "main",
      sessionId: "video-replay",
      sessionKey: "agent:main:video-replay",
      storePath: path.join(stateDir, "sessions.json"),
    };
    const persisted = buildPersistedUserTurnMessage({
      text: "inspect historical video",
      media: [
        {
          kind: "video",
          contentType: "video/mp4",
          sizeBytes: MP4.length,
          url: "media://inbound/history.mp4",
          hydrationSuppressed: true,
        },
      ],
    });
    const serialized = JSON.stringify(persisted);
    expect(serialized).toContain("media://inbound/history.mp4");
    expect(serialized).not.toContain(MP4.toString("base64"));
    expect(serialized).not.toContain(stateDir);

    try {
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
      });
      await appendTranscriptMessage(target, {
        cwd: stateDir,
        eventId: "historical-user",
        message: persisted,
        now: 1,
      });

      const reopened = SessionManager.open(target, stateDir).buildSessionContext();
      const provider = await materializeProviderContext({
        context: { systemPrompt: "system", messages: convertToLlm(reopened.messages), tools: [] },
        workspaceDir: stateDir,
      });
      expect(provider.messages[0]?.content).toEqual([
        { type: "text", text: "inspect historical video" },
        { type: "video", data: MP4.toString("base64"), mimeType: "video/mp4" },
      ]);

      const raw = await readSessionTranscriptRawDelta({
        ...target,
        maxBytes: 100_000,
        maxEvents: 100,
      });
      expect(JSON.stringify(raw)).toContain("media://inbound/history.mp4");
      expect(JSON.stringify(raw)).not.toContain(MP4.toString("base64"));
    } finally {
      env.restore();
    }
  });

  it("resumes a raw cursor after append-only attempt settlement", async () => {
    const dir = tempDirs.make("openclaw-attempt-transcript-");
    const storePath = path.join(dir, "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "embedded-generation",
      sessionKey: "agent:main:embedded-generation",
      storePath,
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(target, {
      cwd: dir,
      eventId: "first-user",
      message: { role: "user", content: "first turn" },
      now: 1,
    });

    const bootstrap = await readSessionTranscriptRawDelta({
      ...target,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    expect(bootstrap.kind).toBe("page");
    if (bootstrap.kind !== "page") {
      throw new Error(`expected bootstrap page, got ${bootstrap.kind}`);
    }

    const sessionManager = SessionManager.open(target, dir);
    sessionManager.appendMessage({
      role: "user",
      content: "second turn",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage(buildAssistantMessage("second answer"));

    // Production settlement invokes this barrier immediately before afterTurn.
    flushSessionManagerTranscript(sessionManager);

    const resumed = await readSessionTranscriptRawDelta({
      ...target,
      cursor: bootstrap.cursor,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    expect(resumed.kind).toBe("page");
    if (resumed.kind !== "page") {
      throw new Error(`expected append page, got ${resumed.kind}`);
    }
    expect(
      resumed.events
        .map((row) => row.event)
        .filter((event): event is { message: { content: unknown }; type: "message" } =>
          Boolean(
            event && typeof event === "object" && "type" in event && event.type === "message",
          ),
        )
        .map((event) => event.message.content),
    ).toEqual(["second turn", [{ type: "text", text: "second answer" }]]);
  });
});
