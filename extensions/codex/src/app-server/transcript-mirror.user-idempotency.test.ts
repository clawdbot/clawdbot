import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexSessionTranscriptMirrorWriteLockContext } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  readSessionTranscriptEvents,
  type TranscriptEntryAnchor,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
} from "./transcript-mirror-attestation.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const transcriptRace = vi.hoisted(() => ({
  competingMessage: undefined as unknown,
  lookups: [] as Array<string | undefined>,
  publish: vi.fn(),
  userAnchor: undefined as TranscriptEntryAnchor | undefined,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: transcriptRace.publish,
  };
});

vi.mock("openclaw/plugin-sdk/codex-session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/codex-session-transcript-runtime")>();
  return {
    ...actual,
    withCodexSessionTranscriptMirrorWriteLock: async (
      params: Parameters<typeof actual.withCodexSessionTranscriptMirrorWriteLock>[0],
      run: Parameters<typeof actual.withCodexSessionTranscriptMirrorWriteLock>[1],
    ) =>
      await actual.withCodexSessionTranscriptMirrorWriteLock(params, async (locked) => {
        const competingMessage = transcriptRace.competingMessage;
        if (!competingMessage) {
          return await run(locked);
        }
        transcriptRace.competingMessage = undefined;
        const intercepted: CodexSessionTranscriptMirrorWriteLockContext = {
          ...locked,
          readMessageFacts: async (factParams) => {
            const staleFacts = await locked.readMessageFacts(factParams);
            await locked.appendMessage({
              message: competingMessage as AgentMessage,
              idempotencyLookup: "scan",
            });
            return staleFacts;
          },
          appendMessageWithMessageSequence: async (options) => {
            transcriptRace.lookups.push(options.idempotencyLookup);
            const result = await locked.appendMessageWithMessageSequence(options);
            const appended = result.result;
            const message = appended?.message as AgentMessage | undefined;
            if (appended && message?.role === "user") {
              transcriptRace.userAnchor = appended.anchor;
            }
            return result;
          },
        };
        return await run(intercepted);
      }),
  };
});

afterEach(() => {
  resetGlobalHookRunner();
  transcriptRace.competingMessage = undefined;
  transcriptRace.lookups.length = 0;
  transcriptRace.publish.mockReset();
  transcriptRace.userAnchor = undefined;
});

it("adopts a competing indexed user without duplicating writes or slowing assistant mirrors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-mirror-user-race-"));
  try {
    const target = {
      agentId: "main",
      sessionId: "user-race",
      sessionKey: "agent:main:user-race",
      storePath: path.join(root, "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      entry: {
        sessionFile: `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`,
        sessionId: target.sessionId,
        updatedAt: 1,
      },
    });

    const beforeMessageWrite = vi.fn((...args: unknown[]) => {
      const event = args[0] as { message: AgentMessage };
      return {
        message:
          event.message.role === "user"
            ? castAgentMessage({
                ...event.message,
                content: [{ type: "text", text: "[redacted by hook]" }],
              })
            : event.message,
      };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_message_write", handler: beforeMessageWrite }]),
    );

    const sourceUser = attachCodexMirrorIdentity(
      castAgentMessage({
        ...makeAgentUserMessage({
          content: [{ type: "text", text: "private user prompt" }],
          timestamp: 1,
        }),
        idempotencyKey: "codex-user-race:prompt",
      }),
      "turn-1:prompt",
    );
    const userFingerprint = fingerprintCodexMirrorSourceMessage(
      sourceUser as Extract<AgentMessage, { role: "user" }>,
    );
    transcriptRace.competingMessage = attachCodexMirrorAttestation(
      castAgentMessage({
        ...sourceUser,
        content: [{ type: "text", text: "[redacted by hook]" }],
      }),
      userFingerprint,
    );
    const sourceAssistant = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "answer" }],
        timestamp: 2,
      }),
      "turn-1:assistant",
    );

    const result = await codexTranscriptMirrorRuntime.mirror({
      ...target,
      messages: [sourceUser, sourceAssistant],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const messageEvents = (await readSessionTranscriptEvents(target)).filter(
      (event): event is { id: string; type: "message"; message: AgentMessage } => {
        return Boolean(
          event &&
          typeof event === "object" &&
          "id" in event &&
          typeof event.id === "string" &&
          "type" in event &&
          event.type === "message",
        );
      },
    );
    const messages = messageEvents.map((event) => event.message);

    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(result.userMessageReceipts.map((receipt) => receipt.message)).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "[redacted by hook]" }],
        idempotencyKey: "codex-user-race:prompt",
        __openclaw: expect.objectContaining({
          mirrorOrigin: "codex-app-server",
          mirrorSourceFingerprint: userFingerprint,
        }),
      }),
    ]);
    expect(result.userMessageReceipts).toHaveLength(1);
    expect(result.userMessageReceipts[0]?.appended).toBe(false);
    expect(result.userMessageReceipts[0]?.message).toBe(result.messagesPresent[0]);
    expect(result.userMessageReceipts[0]?.anchor).toBe(transcriptRace.userAnchor);
    expect(result.userMessageReceipts[0]?.anchor.entryId).toBe(
      messageEvents.find((event) => event.message.role === "user")?.id,
    );
    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(transcriptRace.lookups).toEqual(["scan", "scan"]);
    expect(transcriptRace.publish).toHaveBeenCalledTimes(1);
    expect(transcriptRace.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          message: expect.objectContaining({ role: "assistant" }),
          messageSeq: 2,
        }),
      }),
    );
    expect(beforeMessageWrite).toHaveBeenCalledTimes(2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
