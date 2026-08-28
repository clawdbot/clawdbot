// User turn persistence tests cover the shared transcript writer.
import fs from "node:fs";
import path from "node:path";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";

describe("persistUserTurnTranscript", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    resetGlobalHookRunner();
  });

  function createSqliteTranscriptTarget(params: {
    dir: string;
    sessionId?: string;
    sessionKey?: string;
  }) {
    const sessionId = params.sessionId ?? "session-1";
    const sessionKey = params.sessionKey ?? "agent:main:main";
    const storePath = path.join(params.dir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const sqliteMarker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    return {
      agentId: "main",
      cwd: params.dir,
      sessionEntry: undefined,
      sessionId,
      sessionKey,
      storePath,
      sqliteMarker,
    };
  }

  async function readTranscriptMessages(params: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): Promise<Array<Record<string, unknown>>> {
    return (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      })
    )
      .map((entry) => (entry as { message?: unknown }).message)
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null,
      );
  }

  it("appends a structured user turn through the shared transcript writer", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-");
    const target = createSqliteTranscriptTarget({ dir });
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "What is in this image?",
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
        timestamp: 123,
        senderIsOwner: true,
        provenance,
      },
      updateMode: "none",
    });

    const expected = {
      role: "user",
      content: "What is in this image?",
      timestamp: 123,
      __openclaw: {
        senderIsOwner: false,
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
      },
      provenance,
    };
    expect(appended?.message).toEqual(expected);
    expect(JSON.stringify(appended?.message)).toBe(JSON.stringify(expected));
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([expected]);
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(expected));
  });

  it("round-trips a multi-attachment SQLite row byte-identically", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-media-");
    const target = createSqliteTranscriptTarget({ dir });
    const expected = {
      role: "user",
      content: "Inspect both",
      timestamp: 456,
      __openclaw: {
        media: [
          { path: "/tmp/image.png", contentType: "image/png" },
          { url: "https://example.test/report.pdf", contentType: "application/pdf" },
        ],
      },
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "Inspect both",
        timestamp: 456,
        media: [
          { path: "/tmp/image.png", contentType: "image/png" },
          { url: "https://example.test/report.pdf", contentType: "application/pdf" },
        ],
      },
      updateMode: "none",
    });

    expect(appended?.message).toEqual(expected);
    expect(JSON.stringify(appended?.message)).toBe(JSON.stringify(expected));
    const messages = await readTranscriptMessages(target);
    expect(messages).toEqual([expected]);
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(expected));
  });

  it("persists sender metadata as __openclaw envelope", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-sender-");
    const target = createSqliteTranscriptTarget({ dir });
    // Deliberately attach runtime-only profile fields to prove durable sender
    // attribution is a whitelist, not a copy of the inbound sender object.
    const runtimeOnlySenderFields = {
      senderProfileAvatarUrl: "/api/users/8489979671/avatar?v=1989876543210",
      profileRevision: 1_989_876_543_210,
      avatarBytes: "volatile-avatar-bytes",
      avatarHash: "volatile-avatar-hash",
    };
    const sender = {
      id: "8489979671",
      name: "Ram Shenoy",
      username: "ram_s",
      ...runtimeOnlySenderFields,
    };
    const expected = {
      role: "user",
      content: "hello from group",
      timestamp: 1_700_000_000_000,
      __openclaw: {
        senderId: "8489979671",
        senderName: "Ram Shenoy",
        senderUsername: "ram_s",
      },
    };

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from group",
        timestamp: expected.timestamp,
        sender,
      },
      updateMode: "none",
    });

    const reloaded = await readTranscriptMessages(target);
    const durableMessages = [appended?.message, reloaded[0]];
    expect(durableMessages).toEqual([expected, expected]);
    for (const durableMessage of durableMessages) {
      const serialized = JSON.stringify(durableMessage);
      for (const [key, value] of Object.entries(runtimeOnlySenderFields)) {
        expect(serialized).not.toContain(key);
        expect(serialized).not.toContain(String(value));
      }
    }
  });

  it("omits __openclaw when no sender metadata is provided", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-nosender-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello without sender",
        sender: { id: "", name: null },
      },
      updateMode: "none",
    });

    expect(appended?.message).not.toHaveProperty("__openclaw");
  });

  it("uses inline update mode by default", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-inline-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from runtime",
      },
    });

    expect(appended?.message).toMatchObject({
      role: "user",
      content: "hello from runtime",
      timestamp: expect.any(Number),
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello from runtime",
        timestamp: expect.any(Number),
      }),
    ]);
  });

  it("returns the existing user turn when the idempotency key was already persisted", async () => {
    const dir = tempDirs.make("openclaw-user-turn-append-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    const first = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      },
      updateMode: "none",
    });
    const second = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello once replayed",
        timestamp: 456,
        idempotencyKey: "chat-run-1:user",
      },
      updateMode: "none",
    });

    expect(second?.messageId).toBe(first?.messageId);
    expect(second?.message).toMatchObject({
      role: "user",
      content: "hello once",
      timestamp: 123,
      idempotencyKey: "chat-run-1:user",
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      }),
    ]);
  });

  it("preserves transcript metadata when before_message_write replaces a user turn", async () => {
    let hookCalls = 0;
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: "source-main",
      sourceTool: "sessions_send",
    };
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            hookCalls += 1;
            const message = (event as { message: Record<string, unknown> }).message;
            const meta = message["__openclaw"] as {
              transport?: { conversationRef?: string; messageId?: string };
            };
            if (meta.transport) {
              meta.transport.conversationRef = "conv_tampered";
              meta.transport.messageId = "tampered-message";
            }
            return {
              message: castAgentMessage({
                role: "user",
                content: "[redacted by hook]",
                __openclaw: { hookOwned: true },
              }),
            };
          },
        },
      ]),
    );
    const dir = tempDirs.make("openclaw-user-turn-redacted-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
        replyToId: "transcript-reply-1",
        replyToPreview: { text: "Original reply", senderLabel: "Molty" },
        senderIsOwner: true,
        provenance,
        sender: { id: "user-42", name: "Ada" },
        transport: {
          channel: "reef",
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "inbound-1",
          replyToId: "outbound-1",
        },
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
        replyToId: "transcript-reply-1",
        replyToPreview: { text: "Original reply", senderLabel: "Molty" },
        senderIsOwner: true,
        provenance,
        sender: { id: "user-42", name: "Ada" },
        transport: {
          channel: "reef",
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "inbound-1",
          replyToId: "outbound-1",
        },
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });

    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "[redacted by hook]",
        idempotencyKey: "chat-run-1:user",
        provenance,
        __openclaw: {
          hookOwned: true,
          replyToId: "transcript-reply-1",
          replyToPreview: { text: "Original reply", senderLabel: "Molty" },
          senderIsOwner: false,
          transport: {
            channel: "reef",
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            messageId: "inbound-1",
            replyToId: "outbound-1",
          },
        },
      }),
    ]);
    expect(hookCalls).toBe(1);
  });

  it.each([true, false])(
    "protects internal Goal metadata across write hooks (Goal: %s)",
    async (isGoal) => {
      const target = createSqliteTranscriptTarget({ dir: tempDirs.make("openclaw-goal-hook-") });
      const intent = {
        kind: "session-goal-resume",
        version: 1,
        goalId: "goal-1",
        operationId: "resume-1",
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "Continue pursuing the current goal.",
          timestamp: 123,
          ...(isGoal
            ? {
                display: false as const,
                provenance: { kind: "internal_system" as const },
                __openclaw: { intent },
              }
            : {}),
        },
        target,
        beforeMessageWrite: () =>
          castAgentMessage({
            role: "user",
            content: "redacted",
            timestamp: 123,
            display: true,
            provenance: { kind: "external_user" },
            __openclaw: { intent: { kind: "forged" } },
          }),
      });
      await recorder.persistApproved();
      const [message] = await readTranscriptMessages(target);
      expect((message?.["__openclaw"] as Record<string, unknown> | undefined)?.intent).toEqual(
        isGoal ? intent : undefined,
      );
      if (isGoal) {
        expect(message).toMatchObject({ display: false, provenance: { kind: "internal_system" } });
      }
    },
  );

  it.each([
    {
      name: "restores an erased producer target",
      producerTarget: "active-run",
      hookTarget: undefined,
      expectedTarget: "active-run",
    },
    {
      name: "rejects a replacement target",
      producerTarget: "active-run",
      hookTarget: "forged-run",
      expectedTarget: "active-run",
    },
    {
      name: "rejects a target forged without producer provenance",
      producerTarget: undefined,
      hookTarget: "forged-run",
      expectedTarget: undefined,
    },
  ])(
    "$name across before_message_write",
    async ({ producerTarget, hookTarget, expectedTarget }) => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (event) => {
              const message = (event as { message: Record<string, unknown> }).message;
              const metadata = {
                ...(message["__openclaw"] as Record<string, unknown> | undefined),
              };
              delete metadata.steerTargetRunId;
              return {
                message: castAgentMessage({
                  ...message,
                  __openclaw: {
                    ...metadata,
                    ...(hookTarget ? { steerTargetRunId: hookTarget } : {}),
                  },
                }),
              };
            },
          },
        ]),
      );
      const dir = tempDirs.make("openclaw-user-turn-steer-target-hook-");
      const target = createSqliteTranscriptTarget({ dir });

      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "steer or queue",
          idempotencyKey: "chat-run-steer-target:user",
        },
        target,
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });
      if (producerTarget) {
        await recorder.confirmSteerTargetRunIdForPersistence?.(producerTarget);
      }
      await recorder.persistApproved();

      const [message] = await readTranscriptMessages(target);
      const metadata = message?.["__openclaw"] as Record<string, unknown> | undefined;
      expect(metadata?.steerTargetRunId).toBe(expectedTarget);
    },
  );
});
