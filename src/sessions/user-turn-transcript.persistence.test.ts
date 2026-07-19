// User turn persistence tests cover the shared transcript writer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";

describe("persistUserTurnTranscript", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetGlobalHookRunner();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

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
    const dir = createTempDir("openclaw-user-turn-append-");
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

    expect(appended?.message).toMatchObject({
      role: "user",
      content: "What is in this image?",
      MediaPath: "/tmp/image.png",
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "What is in this image?",
        MediaPath: "/tmp/image.png",
        __openclaw: { senderIsOwner: true },
        provenance,
        MediaType: "image/png",
      }),
    ]);
  });

  it("persists sender metadata as __openclaw envelope", async () => {
    const dir = createTempDir("openclaw-user-turn-append-sender-");
    const target = createSqliteTranscriptTarget({ dir });

    const appended = await persistUserTurnTranscript({
      ...target,
      input: {
        text: "hello from group",
        sender: {
          id: "8489979671",
          name: "Ram Shenoy",
          username: "ram_s",
        },
      },
      updateMode: "none",
    });

    expect(appended?.message).toMatchObject({
      role: "user",
      content: "hello from group",
      __openclaw: {
        senderId: "8489979671",
        senderName: "Ram Shenoy",
        senderUsername: "ram_s",
      },
    });
    await expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello from group",
        __openclaw: {
          senderId: "8489979671",
          senderName: "Ram Shenoy",
          senderUsername: "ram_s",
        },
      }),
    ]);
  });

  it("omits __openclaw when no sender metadata is provided", async () => {
    const dir = createTempDir("openclaw-user-turn-append-nosender-");
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
    const dir = createTempDir("openclaw-user-turn-append-inline-");
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
    const dir = createTempDir("openclaw-user-turn-append-idempotent-");
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
    const dir = createTempDir("openclaw-user-turn-redacted-idempotent-");
    const target = createSqliteTranscriptTarget({ dir });

    await persistUserTurnTranscript({
      ...target,
      input: {
        text: "secret prompt",
        idempotencyKey: "chat-run-1:user",
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
          senderIsOwner: true,
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
});
