import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  readSessionTranscriptEvents,
  type SessionTranscriptWriteLockContext,
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
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: transcriptRace.publish,
    withSessionTranscriptWriteLock: async (
      params: Parameters<typeof actual.withSessionTranscriptWriteLock>[0],
      run: Parameters<typeof actual.withSessionTranscriptWriteLock>[1],
    ) =>
      await actual.withSessionTranscriptWriteLock(params, async (locked) => {
        const competingMessage = transcriptRace.competingMessage;
        if (!competingMessage) {
          return await run(locked);
        }
        transcriptRace.competingMessage = undefined;
        const staleEvents = await locked.readEvents();
        await locked.appendMessage({
          message: competingMessage as AgentMessage,
          idempotencyLookup: "scan",
        });
        const intercepted: SessionTranscriptWriteLockContext = {
          ...locked,
          readEvents: async () => staleEvents,
          appendMessage: async (options) => {
            transcriptRace.lookups.push(options.idempotencyLookup);
            return await locked.appendMessage(options);
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

    const messages = (await readSessionTranscriptEvents(target))
      .filter((event): event is { type: "message"; message: AgentMessage } => {
        return Boolean(
          event && typeof event === "object" && "type" in event && event.type === "message",
        );
      })
      .map((event) => event.message);

    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(result.userMessagesPresent).toEqual([
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
    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(transcriptRace.lookups).toEqual(["scan", "caller-checked"]);
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
