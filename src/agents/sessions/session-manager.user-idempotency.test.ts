// Focused coverage for exact-key user admission and physical SQLite parent ownership.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

describe("SessionManager user idempotency", () => {
  it("preserves distinct keyed user turns with the same visible text", () => {
    const sessionManager = SessionManager.inMemory();
    const makeMessage = (idempotencyKey: string, timestamp: number) => ({
      role: "user" as const,
      content: "same question",
      idempotencyKey,
      timestamp,
    });
    const first = sessionManager.appendMessage(makeMessage("first-run:user", 1));
    const second = sessionManager.appendMessage(makeMessage("second-run:user", 2));

    expect(second).not.toBe(first);
    expect(sessionManager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
  });

  it("allows an explicitly caller-checked keyed user append", () => {
    const sessionManager = SessionManager.inMemory();
    const message = {
      role: "user" as const,
      content: "caller-owned user",
      idempotencyKey: "caller-checked:user",
      timestamp: 1,
    };
    const first = sessionManager.appendMessage(message);

    expect(sessionManager.appendMessage(message, { idempotencyLookup: "caller-checked" })).not.toBe(
      first,
    );
  });

  it("rejects a keyed user collision outside the current SQLite append parent", async () => {
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-ancestor",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-ancestor",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-ancestor:user",
      timestamp: 1,
    };
    await upsertSessionEntry(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "pre-persisted-user",
      message: userMessage,
      now: 1,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "persisted-assistant",
      message: buildAssistantMessage("answer"),
      parentId: "pre-persisted-user",
    });
    const sessionManager = SessionManager.open(scope, dir);

    expect(() => sessionManager.appendMessage(userMessage)).toThrow(
      "Session transcript parent entry was not persisted",
    );
    expect(sessionManager.getLeafId()).toBe("persisted-assistant");
    expect(
      (await loadTranscriptEvents(scope)).filter(
        (event) =>
          (event as { message?: { role?: string; idempotencyKey?: string } }).message?.role ===
            "user" &&
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
            userMessage.idempotencyKey,
      ),
    ).toHaveLength(1);
  });

  it("adopts a keyed user persisted after the manager loaded", async () => {
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-concurrent-ingress",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-concurrent-ingress",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-concurrent-ingress:user",
      timestamp: 1,
    };
    await upsertSessionEntry(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "existing-assistant",
      message: buildAssistantMessage("previous answer"),
      now: 1,
    });
    const sessionManager = SessionManager.open(scope, dir);
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "ingress-persisted-user",
      message: userMessage,
      now: 2,
      parentId: "existing-assistant",
    });
    const modelChangeId = sessionManager.appendModelChange("openai", "gpt-5.5");
    const thinkingId = sessionManager.appendThinkingLevelChange("off");
    const metadataId = sessionManager.appendCustomEntry("model-snapshot", {
      modelApi: "openai-responses",
      modelId: "gpt-5.5",
      provider: "openai",
    });

    expect(sessionManager.appendMessage(userMessage)).toBe("ingress-persisted-user");
    expect(sessionManager.getAppendParentId()).toBe(metadataId);

    const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events.find((event) => (event as { id?: string }).id === modelChangeId)).toMatchObject({
      parentId: "ingress-persisted-user",
    });
    expect(events.find((event) => (event as { id?: string }).id === thinkingId)).toMatchObject({
      parentId: modelChangeId,
    });
    expect(events.find((event) => (event as { id?: string }).id === metadataId)).toMatchObject({
      parentId: thinkingId,
    });
    expect(events.find((event) => (event as { id?: string }).id === assistantId)).toMatchObject({
      parentId: metadataId,
    });
    expect(
      events.filter(
        (event) =>
          (event as { message?: { role?: string; idempotencyKey?: string } }).message?.role ===
            "user" &&
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
            userMessage.idempotencyKey,
      ),
    ).toHaveLength(1);
  });

  it("adopts a persisted user across context-free session setup metadata", async () => {
    const dir = tempDirs.make("openclaw-session-manager-user-idempotency-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-runtime-user-setup-metadata",
      sessionKey: "agent:main:dashboard:sqlite-runtime-user-setup-metadata",
      storePath: path.join(dir, "sessions.json"),
    };
    const userMessage = {
      role: "user" as const,
      content: "question",
      idempotencyKey: "runtime-user-setup-metadata:user",
      timestamp: 1,
    };
    await upsertSessionEntry(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "pre-persisted-user",
      message: userMessage,
      now: 1,
    });

    const sessionManager = SessionManager.open(scope, dir);
    sessionManager.appendModelChange("openai", "gpt-5.5");
    sessionManager.appendThinkingLevelChange("off");
    const metadataId = sessionManager.appendCustomEntry("model-snapshot", {
      modelApi: "openai-responses",
      modelId: "gpt-5.5",
      provider: "openai",
    });

    expect(sessionManager.appendMessage(userMessage)).toBe("pre-persisted-user");
    expect(sessionManager.getAppendParentId()).toBe(metadataId);

    const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));
    const events = await loadTranscriptEvents(scope);
    expect(events.find((event) => (event as { id?: string }).id === assistantId)).toMatchObject({
      parentId: metadataId,
    });
    expect(
      events.filter(
        (event) =>
          (event as { message?: { role?: string; idempotencyKey?: string } }).message?.role ===
            "user" &&
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
            userMessage.idempotencyKey,
      ),
    ).toHaveLength(1);
  });
});
