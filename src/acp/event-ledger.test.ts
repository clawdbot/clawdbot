import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createFileAcpEventLedger, createInMemoryAcpEventLedger } from "./event-ledger.js";

describe("ACP event ledger", () => {
  it("records complete in-memory session updates in sequence", async () => {
    const ledger = createInMemoryAcpEventLedger({ now: () => 123 });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUserPrompt({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      runId: "run-1",
      prompt: [{ type: "text", text: "Question" }],
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      runId: "run-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });

    const replay = await ledger.readReplay({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
    });

    expect(replay.complete).toBe(true);
    expect(replay.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(replay.events.map((event) => event.runId)).toEqual(["run-1", "run-1"]);
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
  });

  it("marks a session incomplete when event retention truncates history", async () => {
    const ledger = createInMemoryAcpEventLedger({ maxEventsPerSession: 1 });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First" },
      },
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second" },
      },
    });

    await expect(
      ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
    ).resolves.toEqual({ complete: false, events: [] });
  });

  it("persists file-backed replay state across ledger instances", async () => {
    await withTempDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
      const filePath = path.join(dir, "acp", "event-ledger.json");
      const first = createFileAcpEventLedger({ filePath, now: () => 1000 });
      await first.startSession({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        cwd: "/work",
        complete: true,
      });
      await first.recordUpdate({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        runId: "run-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking" },
        },
      });

      const second = createFileAcpEventLedger({ filePath });
      const replay = await second.readReplay({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
      });

      expect(replay.complete).toBe(true);
      expect(replay.events).toHaveLength(1);
      expect(replay.events[0]?.update).toEqual({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      });
      await expect(fs.readFile(filePath, "utf8")).resolves.toContain('"version":1');
    });
  });

  it("can replay a complete session by Gateway session key", async () => {
    const ledger = createInMemoryAcpEventLedger({ now: () => 1000 });
    await ledger.startSession({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });

    const replay = await ledger.readReplayBySessionKey({
      sessionKey: "acp:gateway-session-1",
    });

    expect(replay.complete).toBe(true);
    expect(replay.sessionId).toBe("acp-session-1");
    expect(replay.sessionKey).toBe("acp:gateway-session-1");
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "agent_message_chunk",
    ]);
  });

  it("preserves prompt history when a provisional ACP key becomes a canonical Gateway key", async () => {
    const ledger = createInMemoryAcpEventLedger({ now: () => 1000 });
    await ledger.startSession({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUserPrompt({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      runId: "run-1",
      prompt: [{ type: "text", text: "Question" }],
    });
    await ledger.recordUpdate({
      sessionId: "acp-session-1",
      sessionKey: "agent:main:acp:gateway-session-1",
      runId: "run-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });

    const replay = await ledger.readReplayBySessionKey({
      sessionKey: "agent:main:acp:gateway-session-1",
    });

    expect(replay.complete).toBe(true);
    expect(replay.sessionId).toBe("acp-session-1");
    expect(replay.sessionKey).toBe("agent:main:acp:gateway-session-1");
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
  });

  it("can replay multi-block prompt history by ACP session id", async () => {
    const ledger = createInMemoryAcpEventLedger({ now: () => 1000 });
    await ledger.startSession({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUserPrompt({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      runId: "run-1",
      prompt: [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
    });

    const replay = await ledger.readReplayBySessionId({ sessionId: "acp-session-1" });

    expect(replay.complete).toBe(true);
    expect(replay.sessionKey).toBe("acp:gateway-session-1");
    expect(
      replay.events.map((event) =>
        event.update.sessionUpdate === "user_message_chunk" ? event.update.content : undefined,
      ),
    ).toEqual([
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ]);
  });

  it("evicts the oldest complete session when session retention is exceeded", async () => {
    let now = 1000;
    const ledger = createInMemoryAcpEventLedger({ maxSessions: 1, now: () => now++ });
    await ledger.startSession({
      sessionId: "old-session",
      sessionKey: "acp:old-gateway-session",
      cwd: "/work",
      complete: true,
    });
    await ledger.startSession({
      sessionId: "new-session",
      sessionKey: "acp:new-gateway-session",
      cwd: "/work",
      complete: true,
    });

    await expect(
      ledger.readReplay({ sessionId: "old-session", sessionKey: "acp:old-gateway-session" }),
    ).resolves.toEqual({ complete: false, events: [] });
    const replay = await ledger.readReplayBySessionId({ sessionId: "new-session" });
    expect(replay.complete).toBe(true);
    expect(replay.sessionKey).toBe("acp:new-gateway-session");
  });

  it("resets stale events when a session is restarted with reset", async () => {
    const ledger = createInMemoryAcpEventLedger();
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "acp:old-session",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "acp:old-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Old answer" },
      },
    });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "acp:new-session",
      cwd: "/work",
      complete: true,
      reset: true,
    });

    await expect(
      ledger.readReplay({ sessionId: "session-1", sessionKey: "acp:old-session" }),
    ).resolves.toEqual({ complete: false, events: [] });
    const replay = await ledger.readReplayBySessionId({ sessionId: "session-1" });
    expect(replay.complete).toBe(true);
    expect(replay.sessionKey).toBe("acp:new-session");
    expect(replay.events).toEqual([]);
  });

  it("marks replay incomplete when serialized byte retention trims payloads", async () => {
    const ledger = createInMemoryAcpEventLedger({ maxSerializedBytes: 900 });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { content: "x".repeat(5_000) },
      },
    });

    await expect(
      ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
    ).resolves.toEqual({ complete: false, events: [] });
  });

  it("keeps the persisted ledger file under the serialized byte budget", async () => {
    await withTempDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
      const filePath = path.join(dir, "acp", "event-ledger.json");
      const ledger = createFileAcpEventLedger({ filePath, maxSerializedBytes: 1024 });
      await ledger.startSession({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        cwd: "/work",
        complete: true,
      });
      await ledger.recordUpdate({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: { content: "x".repeat(5_000) },
        },
      });

      const bytes = Buffer.byteLength(await fs.readFile(filePath, "utf8"), "utf8");
      expect(bytes).toBeLessThanOrEqual(1024);
      await expect(
        ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
      ).resolves.toEqual({ complete: false, events: [] });
    });
  });

  it("ignores corrupt ledger files instead of replaying unknown state", async () => {
    await withTempDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
      const filePath = path.join(dir, "event-ledger.json");
      await fs.writeFile(filePath, "{bad json", "utf8");
      const ledger = createFileAcpEventLedger({ filePath });

      await expect(
        ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
      ).resolves.toEqual({ complete: false, events: [] });
    });
  });

  it("reloads file-backed state under lock before writing", async () => {
    await withTempDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
      const filePath = path.join(dir, "acp", "event-ledger.json");
      const first = createFileAcpEventLedger({ filePath });
      const second = createFileAcpEventLedger({ filePath });

      await first.startSession({
        sessionId: "session-1",
        sessionKey: "acp:gateway-session-1",
        cwd: "/work",
        complete: true,
      });
      await second.startSession({
        sessionId: "session-2",
        sessionKey: "acp:gateway-session-2",
        cwd: "/work",
        complete: true,
      });
      await first.recordUpdate({
        sessionId: "session-1",
        sessionKey: "acp:gateway-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Answer" },
        },
      });

      const reader = createFileAcpEventLedger({ filePath });
      const replay = await reader.readReplay({
        sessionId: "session-2",
        sessionKey: "acp:gateway-session-2",
      });
      expect(replay.complete).toBe(true);
      expect(replay.sessionKey).toBe("acp:gateway-session-2");
    });
  });
});
