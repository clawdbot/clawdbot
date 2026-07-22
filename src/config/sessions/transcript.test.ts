// Transcript tests cover session transcript persistence and formatting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { repairToolUseResultPairing } from "../../agents/session-transcript-repair.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import type { InternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import {
  loadTranscriptEvents,
  appendTranscriptEvent,
  loadSessionEntry,
  persistSessionTranscriptTurn,
  readLatestTranscriptAssistantText,
  replaceSessionEntry,
  updateSessionEntry,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import {
  appendSessionTranscriptEvent,
  appendSessionTranscriptMessage,
} from "./transcript-append.test-support.js";
import { selectSessionTranscriptLeafControlledPath } from "./transcript-tree.js";
import {
  bindOwnedSessionTranscriptWrites,
  runWithOwnedSessionTranscriptWriteLock,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
  readLatestAssistantTextFromSessionTranscript,
  readRecentUserAssistantTextForSession,
  readTailAssistantTextFromSessionTranscript,
  SessionTranscriptAgentScopeMismatchError,
} from "./transcript.js";
import type { SessionEntry } from "./types.js";

type SessionEntryFixture = Partial<SessionEntry> & { channel?: string };

describe("appendAssistantMessageToSessionTranscript", () => {
  beforeAll(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-warm-"));
    try {
      const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      await replaceSessionEntry(
        { sessionKey: "warm", storePath },
        { sessionId: "warm-session", chatType: "direct", updatedAt: 1 },
      );
      await appendAssistantMessageToSessionTranscript({
        agentId: "main",
        sessionKey: "warm",
        text: "warm",
        storePath,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const fixture = useTempSessionsFixture("transcript-test-");
  const sessionId = "test-session-id";
  const sessionKey = "agent:main:test-session";
  type ExactAssistantMessage = Parameters<
    typeof appendExactAssistantMessageToSessionTranscript
  >[0]["message"];
  type BeforeMessageWriteParams = Parameters<
    NonNullable<
      Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0]["beforeMessageWrite"]
    >
  >[0];
  type TranscriptRepairMessage = Parameters<typeof repairToolUseResultPairing>[0][number];
  type TranscriptUpdateEmitterSpy = {
    mock: {
      calls: [string | InternalSessionTranscriptUpdate][];
    };
  };

  async function writeTranscriptStore(entry: SessionEntryFixture = {}) {
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: fixture.storePath() },
      normalizeLegacySessionEntryDelivery({
        sessionId,
        chatType: "direct",
        updatedAt: 1,
        channel: "discord",
        ...entry,
      } as SessionEntry),
    );
  }

  async function writeTranscriptSessionEntry(params: {
    entry: SessionEntryFixture & Pick<SessionEntry, "sessionId">;
    sessionKey: string;
  }) {
    await replaceSessionEntry(
      { agentId: "main", sessionKey: params.sessionKey, storePath: fixture.storePath() },
      normalizeLegacySessionEntryDelivery({ updatedAt: 1, ...params.entry } as SessionEntry),
    );
  }

  function createExactAssistantMessage(params: {
    text?: string;
    content?: ExactAssistantMessage["content"];
    provider?: string;
    model?: string;
  }): ExactAssistantMessage {
    return {
      role: "assistant",
      content: params.content ?? [{ type: "text", text: params.text ?? "" }],
      api: "openai-responses",
      provider: params.provider ?? "codex",
      model: params.model ?? "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  function requireTranscriptUpdateCall(
    spy: TranscriptUpdateEmitterSpy,
  ): InternalSessionTranscriptUpdate {
    const call = spy.mock.calls[0];
    if (!call) {
      throw new Error("expected transcript update event");
    }
    const event = call[0];
    if (typeof event === "string") {
      throw new Error("expected structured transcript update event");
    }
    return event;
  }

  async function loadFixtureMessages(
    override: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
      storePath?: string;
    } = {},
  ): Promise<Array<{ message?: unknown }>> {
    return (await loadTranscriptEvents({
      agentId: override.agentId ?? "main",
      sessionId: override.sessionId ?? sessionId,
      sessionKey: override.sessionKey ?? sessionKey,
      storePath: override.storePath ?? fixture.storePath(),
    })) as Array<{ message?: unknown }>;
  }

  it("uses configured session.store when storePath is omitted", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-config-store-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempDir, "default-state"));
      const sessionsDir = path.join(tempDir, "configured", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      const configuredSessionKey = "agent:main:configured-store";
      await replaceSessionEntry(
        { agentId: "main", sessionKey: configuredSessionKey, storePath },
        {
          sessionId: "configured-session-id",
          chatType: "direct",
          updatedAt: 1,
        },
      );

      const result = await appendAssistantMessageToSessionTranscript({
        agentId: "main",
        sessionKey: configuredSessionKey,
        text: "mirrored configured store reply",
        config: { session: { store: storePath } },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(result.sessionFile).toContain("sqlite:main:configured-session-id:");
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          sessionId: "configured-session-id",
          sessionKey: configuredSessionKey,
          storePath,
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "mirrored configured store reply" }],
          }),
        }),
      );
    } finally {
      if (previousStateDir === undefined) {
        deleteTestEnvValue("OPENCLAW_STATE_DIR");
      } else {
        setTestEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the session key agent for configured session.store templates", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-agent-store-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempDir, "default-state"));
      const storeTemplate = path.join(tempDir, "agents", "{agentId}", "sessions", "sessions.json");
      const sessionsDir = path.join(tempDir, "agents", "worker", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      const configuredSessionKey = "agent:worker:configured-store";
      await replaceSessionEntry(
        { agentId: "worker", sessionKey: configuredSessionKey, storePath },
        {
          sessionId: "worker-session-id",
          chatType: "direct",
          updatedAt: 1,
        },
      );
      const beforeMessageWrite = vi.fn(({ message }: BeforeMessageWriteParams) => message);

      const result = await appendAssistantMessageToSessionTranscript({
        sessionKey: configuredSessionKey,
        text: "mirrored worker store reply",
        config: { session: { store: storeTemplate } },
        beforeMessageWrite,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(result.sessionFile).toContain("sqlite:worker:worker-session-id:");
      await expect(
        loadTranscriptEvents({
          agentId: "worker",
          sessionId: "worker-session-id",
          sessionKey: configuredSessionKey,
          storePath,
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "mirrored worker store reply" }],
          }),
        }),
      );
      expect(beforeMessageWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "worker",
          sessionKey: configuredSessionKey,
        }),
      );
      const event = requireTranscriptUpdateCall(emitSpy);
      expect(event.agentId).toBe("worker");
      expect(event.sessionKey).toBe(configuredSessionKey);
    } finally {
      emitSpy.mockRestore();
      if (previousStateDir === undefined) {
        deleteTestEnvValue("OPENCLAW_STATE_DIR");
      } else {
        setTestEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a SQLite transcript marker and appends message for valid session", async () => {
    await writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionFile).toContain("sqlite:main:test-session-id:");
      const events = await loadFixtureMessages();
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Hello from delivery mirror!" }],
          }),
        }),
      );
    }
  });

  it("advances the session registry marker after managed transcript appends", async () => {
    const updatedAt = Date.parse("2026-05-18T09:00:00.000Z");
    const appendedAt = Date.parse("2026-05-18T09:05:00.000Z");
    const sessionFile = "managed-marker.jsonl";
    await writeTranscriptStore({ sessionFile, updatedAt, status: "done" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(appendedAt);
    try {
      const result = await appendAssistantMessageToSessionTranscript({
        sessionKey,
        text: "Hello with registry marker",
        storePath: fixture.storePath(),
      });

      expect(result.ok).toBe(true);
      const saved = loadSessionEntry({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      });
      expect(saved?.updatedAt).toBe(appendedAt);
      expect(saved?.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not advance the registry marker for duplicate delivery mirror replays", async () => {
    const updatedAt = Date.parse("2026-05-18T10:00:00.000Z");
    const firstAppendAt = Date.parse("2026-05-18T10:05:00.000Z");
    const duplicateReplayAt = Date.parse("2026-05-18T10:10:00.000Z");
    const sessionFile = "duplicate-marker.jsonl";
    await writeTranscriptStore({ sessionFile, updatedAt, status: "done" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(firstAppendAt);
      const first = await appendAssistantMessageToSessionTranscript({
        sessionKey,
        text: "Replay-safe marker",
        storePath: fixture.storePath(),
      });
      expect(first.ok).toBe(true);

      vi.setSystemTime(duplicateReplayAt);
      const duplicate = await appendAssistantMessageToSessionTranscript({
        sessionKey,
        text: "Replay-safe marker",
        storePath: fixture.storePath(),
      });
      expect(duplicate.ok).toBe(true);

      const saved = loadSessionEntry({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      });
      expect(saved?.updatedAt).toBe(firstAppendAt);
      if (first.ok && duplicate.ok) {
        expect(duplicate.messageId).toBe(first.messageId);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses spawned cwd when creating a missing transcript header", async () => {
    const taskCwd = path.join(fixture.sessionsDir(), "task-repo");
    fs.mkdirSync(taskCwd, { recursive: true });
    await writeTranscriptStore({ spawnedCwd: taskCwd });

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from task cwd!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const events = await loadFixtureMessages();
      expect(events).toContainEqual(
        expect.objectContaining({
          cwd: taskCwd,
          type: "session",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Hello from task cwd!" }],
          }),
        }),
      );
    }
  });

  it("runs matching owned transcript appends through the active session write lock", async () => {
    await writeTranscriptStore();
    const sessionFile = `sqlite:main:${sessionId}:${fixture.storePath()}`;
    const events: string[] = [];

    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey,
        withSessionWriteLock: async (run) => {
          events.push("lock");
          return await run();
        },
      },
      async () =>
        await appendAssistantMessageToSessionTranscript({
          sessionKey,
          text: "Hello under lock",
          storePath: fixture.storePath(),
        }),
    );

    expect(result.ok).toBe(true);
    expect(events).toEqual(["lock"]);
  });

  it("does not reuse owned write locks for a different concrete transcript file", async () => {
    const oldSessionFile = resolveSessionTranscriptPathInDir("old-session", fixture.sessionsDir());
    const nextSessionFile = resolveSessionTranscriptPathInDir(
      "next-session",
      fixture.sessionsDir(),
    );
    const events: string[] = [];

    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionFile: oldSessionFile,
        sessionKey,
        withSessionWriteLock: async (run) => {
          events.push("lock");
          return await run();
        },
      },
      async () =>
        await runWithOwnedSessionTranscriptWriteLock(
          { sessionFile: nextSessionFile, sessionKey },
          () => {
            events.push("write");
            return "ok";
          },
        ),
    );

    expect(result).toBe("ok");
    expect(events).toEqual(["write"]);
  });

  it("keeps matching owned transcript appends locked from bound callbacks", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const events: string[] = [];
    const callback = bindOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey,
        withSessionWriteLock: async (run) => {
          events.push("lock");
          return await run();
        },
      },
      async () =>
        await runWithOwnedSessionTranscriptWriteLock({ sessionFile, sessionKey }, () => {
          events.push("write");
          return "ok";
        }),
    );

    const result = await callback();

    expect(result).toBe("ok");
    expect(events).toEqual(["lock", "write"]);
  });

  it("appends to legacy lowercase Signal group session entries", async () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const signalSessionKey = `agent:main:signal:group:${mixedGroupId}`;
    const legacySignalSessionKey = signalSessionKey.toLowerCase();
    await writeTranscriptSessionEntry({
      sessionKey: legacySignalSessionKey,
      entry: {
        sessionId,
        chatType: "group",
        channel: "signal",
      },
    });

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: signalSessionKey,
      text: "Hello Signal group",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const events = await loadFixtureMessages({
        sessionKey: legacySignalSessionKey,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "Hello Signal group" }],
          }),
        }),
      );
    }
  });

  it("uses the SQLite transcript marker for malformed persisted sessionFile metadata", async () => {
    await writeTranscriptStore({
      sessionFile: { path: "../../escaped.jsonl" } as unknown as string,
      updatedAt: Date.now(),
    });

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from a repaired metadata boundary",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionFile).toContain("sqlite:main:test-session-id:");
      await expect(loadFixtureMessages()).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "Hello from a repaired metadata boundary" }],
          }),
        }),
      );
    }
  });

  it("emits transcript update events for delivery mirrors", async () => {
    await writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    expect(emitSpy).toHaveBeenCalledTimes(1);
    const event = requireTranscriptUpdateCall(emitSpy);
    const message = event.message as
      | {
          role?: string;
          api?: string;
          provider?: string;
          model?: string;
          content?: unknown;
        }
      | undefined;
    expect(event?.sessionFile).toContain("sqlite:main:test-session-id:");
    expect(event?.sessionKey).toBe(sessionKey);
    expect(event?.messageId).toBeTypeOf("string");
    expect(message?.role).toBe("assistant");
    expect(message?.api).toBe(OPENCLAW_TRANSCRIPT_ARTIFACT_API);
    expect(message?.provider).toBe("openclaw");
    expect(message?.model).toBe("delivery-mirror");
    expect(message?.content).toEqual([{ type: "text", text: "Hello from delivery mirror!" }]);
    emitSpy.mockRestore();
  });

  it("does not append a duplicate delivery mirror for the same idempotency key", async () => {
    await writeTranscriptStore();

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    const events = await loadFixtureMessages();
    const messages = events.flatMap((entry) => (entry.message ? [entry.message] : [])) as Array<{
      idempotencyKey?: string;
      content?: Array<{ text?: string }>;
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.idempotencyKey).toBe("mirror:test-source-message");
    expect(messages[0]?.content?.[0]?.text).toBe("Hello from delivery mirror!");
  });

  it("does not append a duplicate delivery mirror when the latest assistant message already matches", async () => {
    await writeTranscriptStore();

    const exactResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Hello from Codex!" }),
    });

    expect(exactResult.ok).toBe(true);

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from Codex!",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (exactResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(exactResult.messageId);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: fixture.storePath(),
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            provider: "codex",
            model: "gpt-5.4",
            content: [expect.objectContaining({ text: "Hello from Codex!" })],
          }),
        }),
      );
    }
  });

  it("dedupes delivery mirrors against the active SQLite branch tail", async () => {
    await writeTranscriptStore();
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      {
        updateMode: "none",
        messages: [
          {
            message: createExactAssistantMessage({ text: "Active branch reply" }),
          },
          {
            message: createExactAssistantMessage({ text: "Inactive branch reply" }),
          },
        ],
      },
    );
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: fixture.storePath(),
    });
    const assistantEvents = events.filter(
      (event): event is { id: string; message: { role: string; content: unknown } } =>
        Boolean(event) &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as { message?: { role?: string } }).message?.role === "assistant" &&
        typeof (event as { id?: unknown }).id === "string",
    );
    const active = assistantEvents[0];
    const inactive = assistantEvents[1];
    if (!active || !inactive) {
      throw new Error("expected assistant events");
    }
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: inactive.id,
        targetId: active.id,
      },
    );

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Active branch reply",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(active.id);
    }
  });

  it("does not downgrade a marked SQLite session entry on normal assistant appends", async () => {
    const marker = `sqlite:main:${sessionId}:${fixture.storePath()}`;
    await writeTranscriptStore({
      sessionFile: marker,
      updatedAt: 100,
      pluginExtensions: {
        "metadata-owner": {
          preserved: true,
        },
      },
    });

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Normal SQLite reply" }),
    });

    expect(result.ok).toBe(true);
    const saved = loadSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() });
    expect(saved?.sessionFile).toBe(marker);
    expect(saved?.updatedAt).toBeGreaterThan(100);
    expect(saved?.pluginExtensions).toEqual({
      "metadata-owner": {
        preserved: true,
      },
    });
  });

  it("does not downgrade a marked SQLite session entry on duplicate delivery mirrors", async () => {
    const marker = `sqlite:main:${sessionId}:${fixture.storePath()}`;
    await writeTranscriptStore({ sessionFile: marker });

    const existingTurn = await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      {
        updateMode: "none",
        messages: [
          {
            message: createExactAssistantMessage({ text: "Existing SQLite reply" }),
          },
        ],
      },
    );
    const existingMessageId = existingTurn.messages[0]?.messageId;
    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Existing SQLite reply",
      storePath: fixture.storePath(),
    });

    expect(existingMessageId).toBeTypeOf("string");
    expect(mirrorResult.ok).toBe(true);
    if (mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(existingMessageId);
    }
    const saved = loadSessionEntry({ agentId: "main", sessionKey, storePath: fixture.storePath() });
    expect(saved?.sessionFile).toBe(marker);
  });

  it("idempotently appends identified channel finals while preserving repeated replies", async () => {
    await writeTranscriptStore();

    const first = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated command reply",
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final:message-1:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-1" },
    });
    const replay = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated command reply",
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final:message-1:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-1" },
    });
    const nextTurn = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated command reply",
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final:message-2:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-2" },
    });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(nextTurn.ok).toBe(true);
    if (first.ok && replay.ok && nextTurn.ok) {
      expect(replay.messageId).toBe(first.messageId);
      expect(nextTurn.messageId).not.toBe(first.messageId);
      const messages = (await loadFixtureMessages()).flatMap((entry) =>
        entry.message ? [entry.message] : [],
      ) as Array<{ openclawDeliveryMirror?: unknown }>;
      expect(messages).toHaveLength(2);
      expect(messages[0]?.openclawDeliveryMirror).toEqual({
        kind: "channel-final",
        sourceMessageId: "message-1",
      });
    }
  });

  it("idempotently appends identified message-tool source replies", async () => {
    await writeTranscriptStore();
    const deliveryMirror = {
      kind: "message-tool-source-reply" as const,
      final: true,
      sourceTurnId: "channel-user:v1:message-1",
    };

    const first = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Delivered once",
      storePath: fixture.storePath(),
      idempotencyKey: "message-tool:message-1",
      deliveryMirror,
    });
    const replay = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Delivered once",
      storePath: fixture.storePath(),
      idempotencyKey: "message-tool:message-1",
      deliveryMirror,
    });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (first.ok && replay.ok) {
      expect(replay.messageId).toBe(first.messageId);
    }
  });

  it("idempotently appends suppressed channel finals by key while preserving source ids", async () => {
    await writeTranscriptStore();

    const text = "Channel final suppressed before delivery: stale foreground";
    const first = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text,
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final-suppressed:message-1:0",
      deliveryMirror: {
        kind: "channel-final-suppressed",
        reason: "stale-foreground",
        sourceMessageId: "message-1",
      },
    });
    const replay = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text,
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final-suppressed:message-1:0",
      deliveryMirror: {
        kind: "channel-final-suppressed",
        reason: "stale-foreground",
        sourceMessageId: "message-1",
      },
    });
    const nextTurn = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text,
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final-suppressed:message-2:0",
      deliveryMirror: {
        kind: "channel-final-suppressed",
        reason: "stale-foreground",
        sourceMessageId: "message-2",
      },
    });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(nextTurn.ok).toBe(true);
    if (first.ok && replay.ok && nextTurn.ok) {
      expect(replay.messageId).toBe(first.messageId);
      expect(nextTurn.messageId).not.toBe(first.messageId);
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      });
      const mirrors = events
        .map((event) => (event as { message?: Record<string, unknown> }).message)
        .filter((message): message is Record<string, unknown> =>
          Boolean(message?.openclawDeliveryMirror),
        );
      expect(mirrors).toHaveLength(2);
      expect(mirrors[0]).toMatchObject({
        api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
        provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
        model: OPENCLAW_DELIVERY_MIRROR_MODEL,
        openclawDeliveryMirror: {
          kind: "channel-final-suppressed",
          reason: "stale-foreground",
          sourceMessageId: "message-1",
        },
      });
      expect(mirrors[1]?.openclawDeliveryMirror).toEqual({
        kind: "channel-final-suppressed",
        reason: "stale-foreground",
        sourceMessageId: "message-2",
      });
    }
  });

  it("does not dedupe delivery mirrors against an older assistant after a user turn", async () => {
    await writeTranscriptStore();

    const exactResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Hello before the large user entry" }),
    });

    expect(exactResult.ok).toBe(true);
    if (!exactResult.ok) {
      return;
    }

    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      {
        updateMode: "none",
        messages: [{ message: { role: "user", content: "x".repeat(128 * 1024) } }],
      },
    );

    const latestAssistantText = await readLatestAssistantTextFromSessionTranscript(
      exactResult.sessionFile,
    );
    if (!latestAssistantText) {
      throw new Error("expected latest assistant text");
    }
    expect(latestAssistantText.id).toBe(exactResult.messageId);
    expect(latestAssistantText.text).toBe("Hello before the large user entry");

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello before the large user entry",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (mirrorResult.ok) {
      expect(mirrorResult.messageId).not.toBe(exactResult.messageId);
      const records = await loadFixtureMessages();
      const messages = records.flatMap((record) =>
        record.message ? [record.message] : [],
      ) as Array<{ model?: string; content?: Array<{ text?: string }> }>;
      expect(messages).toHaveLength(3);
      expect(messages[2]?.model).toBe("delivery-mirror");
      expect(messages[2]?.content?.[0]?.text).toBe("Hello before the large user entry");
    }
  });

  it("resolves recent transcript context from session identity", async () => {
    await writeTranscriptStore();
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      {
        updateMode: "none",
        messages: [{ message: { role: "user", content: "from shared session", timestamp: 4_000 } }],
      },
    );

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "from shared session",
        timestamp: 4_000,
      },
    ]);
  });

  it("reads recent context only from the active transcript branch", async () => {
    await writeTranscriptStore();
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      {
        updateMode: "none",
        messages: [
          {
            eventId: "root-user",
            parentId: null,
            message: { role: "user", content: "keep this branch", timestamp: 1_000 },
          },
          {
            eventId: "active-reply",
            parentId: "root-user",
            message: { role: "assistant", content: "active answer", timestamp: 2_000 },
          },
          {
            eventId: "abandoned-reply",
            parentId: "root-user",
            message: { role: "assistant", content: "abandoned answer", timestamp: 3_000 },
          },
        ],
      },
    );
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      { type: "leaf", id: "active-leaf", parentId: "abandoned-reply", targetId: "active-reply" },
    );

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([]);
    const databasePath = resolveSqliteTargetFromSessionStorePath(fixture.storePath(), {
      agentId: "main",
    }).path;
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([
      { id: "root-user", role: "user", text: "keep this branch", timestamp: 1_000 },
      { id: "active-reply", role: "assistant", text: "active answer", timestamp: 2_000 },
    ]);

    const futureMessages = Array.from({ length: 260 }, (_, index) => ({
      eventId: `future-${index}`,
      parentId: index === 0 ? "active-reply" : `future-${index - 1}`,
      message: { role: "user" as const, content: `future ${index}`, timestamp: 10_000 + index },
    }));
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      { updateMode: "none", messages: futureMessages },
    );
    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 2_500,
        limit: 2,
      }),
    ).resolves.toEqual([
      { id: "root-user", role: "user", text: "keep this branch", timestamp: 1_000 },
      { id: "active-reply", role: "assistant", text: "active answer", timestamp: 2_000 },
    ]);
  });

  it("rejects a session key scoped to a different agent", async () => {
    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey: "agent:worker:main",
        storePath: fixture.storePath(),
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptAgentScopeMismatchError);
  });

  it("resolves an unscoped main alias with the configured agent owner", async () => {
    const mainSessionKey = "agent:main:main";
    await writeTranscriptSessionEntry({ entry: { sessionId }, sessionKey: mainSessionKey });
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey: mainSessionKey, storePath: fixture.storePath() },
      {
        updateMode: "none",
        messages: [{ message: { role: "user", content: "from main alias", timestamp: 4_000 } }],
      },
    );

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey: "main",
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "from main alias",
        timestamp: 4_000,
      },
    ]);
  });

  it("prefers SQLite transcript rows for recent context from session identity", async () => {
    await writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "stale jsonl context", timestamp: 1_000 },
    });
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      {
        updateMode: "none",
        messages: [
          {
            message: { role: "user", content: "sqlite identity context", timestamp: 4_000 },
          },
        ],
      },
    );

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "sqlite identity context",
        timestamp: 4_000,
      },
    ]);
  });

  it("does not fall back to stale JSONL when SQLite rows are outside the recent window", async () => {
    await writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "stale jsonl context", timestamp: 1_000 },
    });
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      {
        updateMode: "none",
        messages: [
          {
            message: { role: "user", content: "sqlite future context", timestamp: 10_000 },
          },
        ],
      },
    );

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([]);
  });

  it("does not fall back to stale JSONL when SQLite has no transcript rows", async () => {
    await writeTranscriptStore({
      sessionFile: `sqlite:main:${sessionId}:${fixture.storePath()}`,
    });
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "stale jsonl context", timestamp: 1_000 },
    });

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([]);
  });

  it("ignores stored session files outside the sessions directory for recent context", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "outside.jsonl");
      await writeTranscriptStore({ sessionFile: outsideFile });
      await appendSessionTranscriptMessage({
        transcriptPath: outsideFile,
        message: { role: "user", content: "outside text", timestamp: 1_000 },
      });
      const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
      await appendSessionTranscriptMessage({
        transcriptPath: sessionFile,
        message: { role: "user", content: "contained text", timestamp: 2_000 },
      });
      await persistSessionTranscriptTurn(
        {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: fixture.storePath(),
        },
        {
          updateMode: "none",
          messages: [{ message: { role: "user", content: "sqlite text", timestamp: 2_500 } }],
        },
      );

      await expect(
        readRecentUserAssistantTextForSession({
          agentId: "main",
          sessionKey,
          storePath: fixture.storePath(),
          beforeTimestampMs: 3_000,
        }),
      ).resolves.toEqual([
        {
          id: expect.any(String),
          role: "user",
          text: "sqlite text",
          timestamp: 2_500,
        },
      ]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("skips transcript-only OpenClaw assistant entries when reading latest assistant text", async () => {
    await writeTranscriptStore();

    const finalResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Complete final answer" }),
    });
    expect(finalResult.ok).toBe(true);
    if (!finalResult.ok) {
      return;
    }

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Earlier retained preview",
      storePath: fixture.storePath(),
    });
    await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({
        text: "Injected transcript text",
        provider: "openclaw",
        model: "gateway-injected",
      }),
    });

    const latestAssistantText = await readLatestAssistantTextFromSessionTranscript(
      finalResult.sessionFile,
    );
    expect(latestAssistantText?.id).toBe(finalResult.messageId);
    expect(latestAssistantText?.text).toBe("Complete final answer");
  });

  it("does not report transcript-only OpenClaw assistant entries as latest assistant text", async () => {
    await writeTranscriptStore();

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Only delivery mirror",
      storePath: fixture.storePath(),
    });
    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }

    const latestAssistantText = await readLatestAssistantTextFromSessionTranscript(
      mirrorResult.sessionFile,
    );
    expect(latestAssistantText).toBeUndefined();
  });

  it("keeps transcript-only OpenClaw assistant entries available to the tail reader", async () => {
    await writeTranscriptStore();

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Tail delivery mirror",
      storePath: fixture.storePath(),
    });
    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }

    const tailAssistantText = await readTailAssistantTextFromSessionTranscript(
      mirrorResult.sessionFile,
    );
    expect(tailAssistantText?.id).toBe(mirrorResult.messageId);
    expect(tailAssistantText?.text).toBe("Tail delivery mirror");
  });

  it("scans past trailing non-assistant entries (e.g. openclaw.cache-ttl) to find the latest assistant text", async () => {
    // Regression for openclaw/openclaw#83427: the cache-ttl custom entry was
    // emitted after the canonical assistant turn, and the tail reader returned
    // undefined on the first non-assistant line, so the gap-fill check in
    // persistTextTurnTranscript wrote a duplicate `api: "cli"` assistant
    // message — poisoning the model's own context with verbatim duplicates.
    await writeTranscriptStore();

    const assistantResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({
        text: "Canonical answer",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
      }),
    });
    expect(assistantResult.ok).toBe(true);
    if (!assistantResult.ok) {
      return;
    }

    const cacheTtlEntry = `${JSON.stringify({
      type: "custom",
      customType: "openclaw.cache-ttl",
      timestamp: new Date().toISOString(),
      data: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    })}\n`;
    await appendTranscriptEvent(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      JSON.parse(cacheTtlEntry),
    );

    const tailAssistantText = await readTailAssistantTextFromSessionTranscript(
      assistantResult.sessionFile,
    );
    expect(tailAssistantText?.id).toBe(assistantResult.messageId);
    expect(tailAssistantText?.text).toBe("Canonical answer");
  });

  it("scans past trailing assistant entries without visible text", async () => {
    await writeTranscriptStore();

    const assistantResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({
        text: "Visible answer before tool call",
      }),
    });
    expect(assistantResult.ok).toBe(true);
    if (!assistantResult.ok) {
      return;
    }

    const toolOnlyResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: {
        ...createExactAssistantMessage({
          content: [
            {
              type: "toolCall",
              id: "call_latest_no_visible_text",
              name: "maniple__list_workers",
              arguments: {},
            },
          ],
        }),
        stopReason: "toolUse",
      },
    });
    expect(toolOnlyResult.ok).toBe(true);
    if (!toolOnlyResult.ok) {
      return;
    }

    const latestAssistantText = readLatestTranscriptAssistantText({
      sessionId,
      sessionKey,
      storePath: fixture.storePath(),
    });
    expect(latestAssistantText?.id).toBe(assistantResult.messageId);
    expect(latestAssistantText?.text).toBe("Visible answer before tool call");
  });

  it("does not scan past a real tail assistant with no visible text for dedupe", async () => {
    await writeTranscriptStore();

    const assistantResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({
        text: "Older visible answer",
      }),
    });
    expect(assistantResult.ok).toBe(true);

    const toolOnlyResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: {
        ...createExactAssistantMessage({
          content: [
            {
              type: "toolCall",
              id: "call_tail_no_visible_text",
              name: "maniple__list_workers",
              arguments: {},
            },
          ],
        }),
        stopReason: "toolUse",
      },
    });
    expect(toolOnlyResult.ok).toBe(true);
    if (!toolOnlyResult.ok) {
      return;
    }

    await expect(
      readTailAssistantTextFromSessionTranscript(toolOnlyResult.sessionFile, {
        excludeTranscriptOnlyOpenClawAssistant: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("scans past excluded delivery mirrors in explicit file-backed tail reads", async () => {
    const transcriptPath = path.join(fixture.sessionsDir(), "file-backed-delivery-tail.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        {
          type: "message",
          id: "real-assistant",
          message: createExactAssistantMessage({ text: "File-backed canonical answer" }),
        },
        {
          type: "message",
          id: "delivery-mirror",
          message: {
            ...createExactAssistantMessage({
              provider: "openclaw",
              model: "delivery-mirror",
              text: "delivery mirror text",
            }),
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      "utf-8",
    );

    await expect(
      readTailAssistantTextFromSessionTranscript(transcriptPath, {
        excludeTranscriptOnlyOpenClawAssistant: true,
      }),
    ).resolves.toMatchObject({
      id: "real-assistant",
      text: "File-backed canonical answer",
    });
  });

  it("does not reuse an older matching assistant message across turns", async () => {
    await writeTranscriptStore();

    const olderResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Repeated answer" }),
    });

    const latestResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Different latest answer" }),
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated answer",
      storePath: fixture.storePath(),
    });

    expect(olderResult.ok).toBe(true);
    expect(latestResult.ok).toBe(true);
    expect(mirrorResult.ok).toBe(true);
    if (olderResult.ok && latestResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).not.toBe(olderResult.messageId);
      expect(mirrorResult.messageId).not.toBe(latestResult.messageId);

      const messages = (await loadFixtureMessages()).flatMap((entry) =>
        entry.message ? [entry.message] : [],
      ) as Array<{
        api?: string;
        provider?: string;
        model?: string;
        content?: Array<{ text?: string }>;
      }>;
      expect(messages).toHaveLength(3);
      expect(messages[2]?.api).toBe(OPENCLAW_TRANSCRIPT_ARTIFACT_API);
      expect(messages[2]?.provider).toBe("openclaw");
      expect(messages[2]?.model).toBe("delivery-mirror");
      expect(messages[2]?.content?.[0]?.text).toBe("Repeated answer");
    }
  });

  it("keeps delivery mirrors in transcripts while repair preserves real tool results", async () => {
    await writeTranscriptStore();
    const toolCallId = "call_maniple_list";

    const toolCallTurn = await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      {
        updateMode: "none",
        messages: [
          {
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "maniple__list_workers",
                  arguments: {},
                },
              ],
              stopReason: "toolUse",
            },
          },
        ],
      },
    );
    const toolCallResult = toolCallTurn.messages[0];
    expect(toolCallResult?.messageId).toBeTypeOf("string");

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Maniple List Workers",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }
    expect(mirrorResult.messageId).not.toBe(toolCallResult?.messageId);
    const messagesAfterMirror = (await loadFixtureMessages()).flatMap((entry) =>
      entry.message ? [entry.message] : [],
    ) as Array<{ api?: string; model?: string }>;
    expect(messagesAfterMirror).toHaveLength(2);
    expect(messagesAfterMirror[1]?.api).toBe(OPENCLAW_TRANSCRIPT_ARTIFACT_API);
    expect(messagesAfterMirror[1]?.model).toBe("delivery-mirror");

    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
      {
        updateMode: "none",
        messages: [
          {
            message: {
              role: "toolResult",
              toolCallId,
              toolName: "maniple__list_workers",
              content: [{ type: "text", text: "workers listed" }],
              isError: false,
            },
          },
        ],
      },
    );

    const messages = (await loadFixtureMessages()).flatMap((entry) =>
      entry.message ? [entry.message as TranscriptRepairMessage] : [],
    );
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
    ]);
    const repair = repairToolUseResultPairing(messages, {
      missingToolResultText: "aborted",
    });

    expect(repair.added).toHaveLength(0);
    expect(repair.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect((repair.messages[2] as { model?: string }).model).toBe("delivery-mirror");
  });

  it("finds session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:imessage:direct:+15551234567";
    await writeTranscriptSessionEntry({
      sessionKey: storeKey,
      entry: {
        sessionId: "test-session-normalized",
        chatType: "direct",
        channel: "imessage",
      },
    });

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:iMessage:direct:+15551234567",
      text: "Hello normalized!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("finds Slack session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:slack:direct:u12345abc";
    await writeTranscriptSessionEntry({
      sessionKey: storeKey,
      entry: {
        sessionId: "test-slack-session",
        chatType: "direct",
        channel: "slack",
      },
    });

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:slack:direct:U12345ABC",
      text: "Hello Slack user!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("ignores malformed transcript lines when checking mirror idempotency", async () => {
    await writeTranscriptStore();

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        "{not-json",
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            idempotencyKey: "mirror:test-source-message",
            content: [{ type: "text", text: "Hello from delivery mirror!" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });

  it("appends exact assistant transcript messages without rewriting phased content", async () => {
    await writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({
        content: [
          {
            type: "text",
            text: "internal reasoning",
            textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          },
        ],
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const messages = (await loadFixtureMessages()).flatMap((entry) =>
        entry.message ? [entry.message] : [],
      ) as Array<{ content?: unknown }>;
      expect(messages[0]?.content).toEqual([
        {
          type: "text",
          text: "internal reasoning",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ]);
    }
  });

  it("applies before_message_write after idempotency checks and preserves the key", async () => {
    await writeTranscriptStore();
    const beforeMessageWrite = vi.fn(({ message }: BeforeMessageWriteParams) => ({
      ...message,
      content: [{ type: "text" as const, text: "[redacted by hook]" }],
    }));
    const append = () =>
      appendExactAssistantMessageToSessionTranscript({
        sessionKey,
        storePath: fixture.storePath(),
        idempotencyKey: "cli-assistant:redacted",
        beforeMessageWrite,
        message: createExactAssistantMessage({ text: "secret output" }),
      });

    const first = await append();
    const replay = await append();

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(beforeMessageWrite).toHaveBeenCalledOnce();
    if (!first.ok) {
      throw new Error("expected assistant append to succeed");
    }
    const messages = (await loadFixtureMessages()).flatMap((entry) =>
      entry.message ? [entry.message as ExactAssistantMessage] : [],
    );
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "[redacted by hook]" }],
        idempotencyKey: "cli-assistant:redacted",
      }),
    ]);
  });

  it("dedupes unkeyed delivery mirrors after before_message_write rewrites", async () => {
    await writeTranscriptStore();
    const beforeMessageWrite = vi.fn(({ message }: BeforeMessageWriteParams) => ({
      ...message,
      content: [{ type: "text" as const, text: "[redacted by hook]" }],
    }));
    const append = () =>
      appendAssistantMessageToSessionTranscript({
        sessionKey,
        storePath: fixture.storePath(),
        text: "secret output",
        beforeMessageWrite,
      });

    const first = await append();
    const replay = await append();

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(beforeMessageWrite).toHaveBeenCalledTimes(2);
    if (!first.ok) {
      throw new Error("expected delivery mirror append to succeed");
    }
    const messages = (await loadFixtureMessages()).flatMap((entry) =>
      entry.message ? [entry.message as ExactAssistantMessage] : [],
    );
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "[redacted by hook]" }],
      }),
    ]);
  });

  it("reports assistant messages blocked by before_message_write", async () => {
    await writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      storePath: fixture.storePath(),
      idempotencyKey: "cli-assistant:blocked",
      beforeMessageWrite: vi.fn(() => null),
      message: createExactAssistantMessage({ text: "secret output" }),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "blocked",
    });
  });

  it("rejects assistant output after the session key is rebound", async () => {
    await writeTranscriptStore({
      sessionId: "replacement-session",
      chatType: "direct",
    });

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      expectedSessionId: sessionId,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "late output" }),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "session-rebound",
    });
    expect(
      fs.existsSync(
        resolveSessionTranscriptPathInDir("replacement-session", fixture.sessionsDir()),
      ),
    ).toBe(false);
  });

  it("rejects a concurrent session rebind before the assistant append", async () => {
    await writeTranscriptStore();
    let releaseReset = () => {};
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let markResetStarted = () => {};
    const resetStarted = new Promise<void>((resolve) => {
      markResetStarted = resolve;
    });
    const replacementSessionFile = resolveSessionTranscriptPathInDir(
      "replacement-session",
      fixture.sessionsDir(),
    );
    const reset = updateSessionEntry(
      {
        agentId: "main",
        storePath: fixture.storePath(),
        sessionKey,
      },
      async () => {
        markResetStarted();
        await resetGate;
        return {
          sessionId: "replacement-session",
          sessionFile: replacementSessionFile,
        };
      },
    );
    await resetStarted;

    const append = appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      expectedSessionId: sessionId,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "late output" }),
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseReset();

    await reset;
    const result = await append;
    expect(result).toMatchObject({
      ok: false,
      code: "session-rebound",
    });
    expect(fs.existsSync(replacementSessionFile)).toBe(false);
  });

  it("rejects a concurrent lifecycle owner change without a session id rotation", async () => {
    await writeTranscriptStore({
      lifecycleRevision: "original-revision",
    });
    let releaseOwnerChange = () => {};
    const ownerChangeGate = new Promise<void>((resolve) => {
      releaseOwnerChange = resolve;
    });
    let markOwnerChangeStarted = () => {};
    const ownerChangeStarted = new Promise<void>((resolve) => {
      markOwnerChangeStarted = resolve;
    });
    const ownerChange = updateSessionEntry(
      {
        agentId: "main",
        storePath: fixture.storePath(),
        sessionKey,
      },
      async () => {
        markOwnerChangeStarted();
        await ownerChangeGate;
        return {
          lifecycleRevision: "replacement-revision",
        };
      },
    );
    await ownerChangeStarted;

    const append = appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      expectedLifecycleRevision: "original-revision",
      expectedSessionId: sessionId,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "late output" }),
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseOwnerChange();

    await ownerChange;
    await expect(append).resolves.toMatchObject({
      ok: false,
      code: "session-rebound",
    });
  });

  it("dedupes concurrent exact assistant appends by idempotency key", async () => {
    await writeTranscriptStore();
    const idempotencyKey = "mirror:concurrent-assistant";

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        appendExactAssistantMessageToSessionTranscript({
          sessionKey,
          storePath: fixture.storePath(),
          idempotencyKey,
          updateMode: "none",
          message: createExactAssistantMessage({
            text: "Mirrored reply",
            provider: "openclaw",
            model: "delivery-mirror",
          }),
        }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const messageIds = results.map((result) => (result.ok ? result.messageId : ""));
    expect(new Set(messageIds).size).toBe(1);

    const firstOk = results.find((result) => result.ok);
    if (!firstOk?.ok) {
      throw new Error("expected exact assistant append to succeed");
    }
    const records = (await loadFixtureMessages()).filter((record) => {
      const message = record.message as { role?: string; idempotencyKey?: string } | undefined;
      return message?.role === "assistant" && message.idempotencyKey === idempotencyKey;
    });
    expect(records).toHaveLength(1);
  });

  it("can emit file-only transcript refresh events for exact assistant appends", async () => {
    await writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      updateMode: "file-only",
      message: createExactAssistantMessage({
        text: "Done.",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(emitSpy).toHaveBeenCalledWith({
        agentId: "main",
        sessionFile: result.sessionFile,
        sessionKey,
        target: {
          agentId: "main",
          sessionId,
          sessionKey,
        },
      });
    }
    emitSpy.mockRestore();
  });

  it("serializes concurrent parent-linked transcript appends", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "concurrent-tree-session",
      fixture.sessionsDir(),
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "concurrent-tree-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "root-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "root" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendSessionTranscriptMessage({
          transcriptPath: sessionFile,
          message: { role: "assistant", content: `reply ${index}` },
        }),
      ),
    );

    const records = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            message?: { content?: string };
          },
      )
      .filter((record) => record.type === "message");

    expect(records).toHaveLength(9);
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]?.parentId).toBe(records[index - 1]?.id);
    }
  });

  it("uses a reverse tail scan for modern parent-linked appends", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "tail-scan-session",
      fixture.sessionsDir(),
    );
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "root" },
    });

    const createReadStreamSpy = vi.spyOn(fs, "createReadStream");
    try {
      await appendSessionTranscriptMessage({
        transcriptPath: sessionFile,
        message: { role: "assistant", content: "reply" },
      });
      expect(createReadStreamSpy).not.toHaveBeenCalled();
    } finally {
      createReadStreamSpy.mockRestore();
    }
  });

  it("separates message and event appends from an unterminated transcript entry", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: fixture.sessionsDir(),
        }),
        JSON.stringify({
          type: "message",
          id: "existing",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "existing" },
        }),
      ].join("\n"),
      "utf8",
    );

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "appended message" },
    });
    fs.writeFileSync(sessionFile, fs.readFileSync(sessionFile, "utf8").trimEnd(), "utf8");
    await appendSessionTranscriptEvent({
      transcriptPath: sessionFile,
      event: { type: "custom", id: "event", parentId: null },
    });

    const entries = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message", "custom"]);
  });

  it("serializes transcript events before inspecting the append separator", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const replacementHeader = JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-06-15T00:00:00.000Z",
      cwd: fixture.sessionsDir(),
    });
    fs.writeFileSync(sessionFile, `${replacementHeader}\n`, "utf8");

    await appendSessionTranscriptEvent({
      transcriptPath: sessionFile,
      event: {
        type: "custom",
        toJSON() {
          fs.writeFileSync(sessionFile, replacementHeader, "utf8");
          return { type: "custom", id: "serialized-first", parentId: null };
        },
      },
    });

    const entries = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; id?: string });
    expect(entries).toEqual([
      expect.objectContaining({ type: "session", id: sessionId }),
      { type: "custom", id: "serialized-first", parentId: null },
    ]);
  });

  it("requires explicit idempotency scanning for direct transcript appends", async () => {
    const uncheckedSessionFile = resolveSessionTranscriptPathInDir(
      "unchecked-idempotency-session",
      fixture.sessionsDir(),
    );
    const checkedSessionFile = resolveSessionTranscriptPathInDir(
      "checked-idempotency-session",
      fixture.sessionsDir(),
    );
    const message = {
      role: "assistant",
      content: "fresh keyed append",
      idempotencyKey: "fresh-key",
    };

    await appendSessionTranscriptMessage({
      transcriptPath: uncheckedSessionFile,
      message,
    });
    const uncheckedSecondAppend = await appendSessionTranscriptMessage({
      transcriptPath: uncheckedSessionFile,
      message,
    });

    const checkedFirstAppend = await appendSessionTranscriptMessage({
      transcriptPath: checkedSessionFile,
      message,
      idempotencyLookup: "scan",
    });
    const checkedSecondAppend = await appendSessionTranscriptMessage({
      transcriptPath: checkedSessionFile,
      message,
      idempotencyLookup: "scan",
    });

    const countMessages = (sessionFile: string) =>
      fs
        .readFileSync(sessionFile, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string })
        .filter((record) => record.type === "message").length;

    expect(uncheckedSecondAppend.appended).toBe(true);
    expect(countMessages(uncheckedSessionFile)).toBe(2);
    expect(checkedSecondAppend.appended).toBe(false);
    expect(checkedSecondAppend.messageId).toBe(checkedFirstAppend.messageId);
    expect(countMessages(checkedSessionFile)).toBe(1);
  });

  it("falls back instead of throwing for out-of-range append timestamps", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "invalid-now-transcript-session",
      fixture.sessionsDir(),
    );
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00Z"));

    try {
      await appendSessionTranscriptMessage({
        transcriptPath: sessionFile,
        message: { role: "user", content: "bad clock append" },
        now: 8_640_000_000_000_001,
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    const message = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            timestamp?: string;
          },
      )
      .find((record) => record.type === "message");

    expect(message?.timestamp).toBe("2026-05-30T12:00:00.000Z");
  });

  it("appends after the target selected by a leaf control record", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "leaf-target-transcript-session",
      fixture.sessionsDir(),
    );
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "root question" },
    };
    const abandonedEntry = {
      type: "message",
      id: "abandoned-assistant",
      parentId: rootEntry.id,
      timestamp: "2026-05-30T12:00:01.000Z",
      message: { role: "assistant", content: "abandoned answer" },
    };
    const leafEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: abandonedEntry.id,
      timestamp: "2026-05-30T12:00:02.000Z",
      targetId: rootEntry.id,
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "leaf-target-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        rootEntry,
        abandonedEntry,
        leafEntry,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "replacement answer" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(rootEntry.id);
  });

  it("appends after an explicit opaque append parent on a leaf control", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "leaf-append-parent-transcript-session",
      fixture.sessionsDir(),
    );
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "root question" },
    };
    const metadata = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: rootEntry.id,
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "leaf-append-parent-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        rootEntry,
        metadata,
        {
          type: "leaf",
          id: "leaf-1",
          parentId: metadata.id,
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: rootEntry.id,
          appendParentId: metadata.id,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "replacement answer" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(metadata.id);
  });

  it("marks transcript-only messages that consume a side append cursor", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "side-append-mode-transcript-session",
      fixture.sessionsDir(),
    );
    const activeEntry = {
      type: "message",
      id: "active-entry",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "active question" },
    };
    const sideEntry = {
      type: "message",
      id: "side-entry",
      parentId: activeEntry.id,
      timestamp: "2026-05-30T12:00:01.000Z",
      message: { role: "assistant", content: "first side delivery" },
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "side-append-mode-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        activeEntry,
        sideEntry,
        {
          type: "leaf",
          id: "side-leaf",
          parentId: sideEntry.id,
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: activeEntry.id,
          appendParentId: sideEntry.id,
          appendMode: "side",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: "second side delivery",
      },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            id?: string;
            parentId?: string | null;
            appendMode?: string;
          },
      )
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry).toMatchObject({
      parentId: sideEntry.id,
      appendMode: "side",
    });

    const nextUser = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "next question" },
    });
    const finalRecords = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(finalRecords.find((entry) => entry.id === nextUser.messageId)).toMatchObject({
      parentId: appended.messageId,
    });
    expect(finalRecords.find((entry) => entry.id === nextUser.messageId)).not.toHaveProperty(
      "appendMode",
    );
    expect(
      selectSessionTranscriptLeafControlledPath(finalRecords)?.map((entry) => entry.id),
    ).toEqual([activeEntry.id, nextUser.messageId]);
  });

  it("preserves a side append cursor when metadata follows its leaf control", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "side-append-mode-with-trailing-metadata-transcript-session",
      fixture.sessionsDir(),
    );
    const activeEntry = {
      type: "message",
      id: "active-entry",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "active question" },
    };
    const sideEntry = {
      type: "message",
      id: "side-entry",
      parentId: activeEntry.id,
      timestamp: "2026-05-30T12:00:01.000Z",
      message: { role: "assistant", content: "first side delivery" },
    };
    const sideLeaf = {
      type: "leaf",
      id: "side-leaf",
      parentId: sideEntry.id,
      timestamp: "2026-05-30T12:00:02.000Z",
      targetId: activeEntry.id,
      appendParentId: sideEntry.id,
      appendMode: "side",
    };
    const metadata = {
      type: "metadata",
      id: "post-leaf-metadata",
      parentId: sideLeaf.id,
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "side-append-mode-with-trailing-metadata-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        activeEntry,
        sideEntry,
        sideLeaf,
        metadata,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: "second side delivery",
      },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            id?: string;
            parentId?: string | null;
            appendMode?: string;
          },
      )
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry).toMatchObject({
      parentId: metadata.id,
      appendMode: "side",
    });
  });

  it("ignores dangling leaf references when choosing the direct append parent", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "invalid-leaf-append-parent-transcript-session",
      fixture.sessionsDir(),
    );
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "root question" },
    };
    const metadata = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: rootEntry.id,
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "invalid-leaf-append-parent-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        rootEntry,
        metadata,
        {
          type: "leaf",
          id: "missing-target",
          parentId: metadata.id,
          timestamp: "2026-05-30T12:00:01.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "missing-append",
          parentId: "missing-target",
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: rootEntry.id,
          appendParentId: "missing",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "replacement answer" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(metadata.id);
  });

  it("rejects append targets that reference an earlier invalid leaf control", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "nested-invalid-leaf-append-parent-transcript-session",
      fixture.sessionsDir(),
    );
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "root question" },
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "nested-invalid-leaf-append-parent-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        rootEntry,
        {
          type: "leaf",
          id: "invalid-leaf",
          parentId: rootEntry.id,
          timestamp: "2026-05-30T12:00:01.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "nested-invalid-leaf",
          parentId: "invalid-leaf",
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: "invalid-leaf",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "replacement answer" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(rootEntry.id);
  });

  it("recognizes parentless canonical rows selected by a later leaf control", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "parentless-leaf-target-transcript-session",
      fixture.sessionsDir(),
    );
    const activeEntry = {
      type: "message",
      id: "active-entry",
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "active question" },
    };
    const sideEntry = {
      type: "message",
      id: "side-entry",
      parentId: activeEntry.id,
      timestamp: "2026-05-30T12:00:01.000Z",
      message: { role: "assistant", content: "side delivery" },
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "parentless-leaf-target-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        activeEntry,
        sideEntry,
        {
          type: "leaf",
          id: "active-leaf",
          parentId: sideEntry.id,
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: activeEntry.id,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "active replacement" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(activeEntry.id);
  });

  it("redacts structured message content before transcript persistence", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redacted-transcript-session",
      fixture.sessionsDir(),
    );

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "standalone app password abcd-efgh-ijkl-mnop",
          },
          {
            type: "text",
            text: "tokens ya29.fake-access-token-with-enough-length",
          },
        ],
        toolInput: {
          apiKey: "AIzaSyD-very-real-looking-google-api-key-123",
          refresh: "1//0fake-refresh-token-with-enough-length",
        },
      },
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("ya29.fake-access-token");
    expect(raw).not.toContain("abcd-efgh-ijkl-mnop");
    expect(raw).not.toContain("AIzaSyD-very-real-looking");
    expect(raw).not.toContain("1//0fake-refresh-token");
  });

  it("migrates small linear transcripts before appending", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "small-linear-session",
      fixture.sessionsDir(),
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "small-linear-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-first",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "legacy first" },
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-second",
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: "legacy second" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "new reply" },
    });

    const records = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            message?: { content?: string };
          },
      );
    const messages = records.filter((record) => record.type === "message");

    expect(messages.map((record) => record.message?.content)).toEqual([
      "legacy first",
      "legacy second",
      "new reply",
    ]);
    expect(messages[0]?.id).toBe("legacy-first");
    expect(messages[0]?.parentId).toBeNull();
    expect(messages[1]?.id).toBe("legacy-second");
    expect(messages[1]?.parentId).toBe("legacy-first");
    expect(messages[2]?.id).toBe(appended.messageId);
    expect(messages[2]?.parentId).toBe("legacy-second");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
