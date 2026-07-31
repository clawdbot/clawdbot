import { beforeEach, describe, expect, it } from "vitest";
import type { ClaudeAppServerBindingStore } from "./thread-store.js";
import { createClaudeTestBindingStore } from "./thread-store.test-helpers.js";

const IDENTITY = { sessionKey: "agent:main:direct:tester", sessionId: "sess-1" };

describe("claude app-server binding store", () => {
  let store: ClaudeAppServerBindingStore;

  beforeEach(() => {
    store = createClaudeTestBindingStore();
  });

  it("recordTurnSummary is a no-op when no binding exists yet", async () => {
    await store.recordTurnSummary(IDENTITY, { stopReason: "stop" });
    expect(await store.read(IDENTITY)).toBeNull();
  });

  it("attaches stop reason, usage, and a preview to an existing binding", async () => {
    await store.write(IDENTITY, { threadId: "thr_1", cwd: "/tmp/ws", model: "claude-sonnet-5" });
    await store.recordTurnSummary(IDENTITY, {
      stopReason: "stop",
      usage: { input: 100, output: 20, total: 120 },
      assistantPreview: "Hello there!",
    });
    const binding = await store.read(IDENTITY);
    expect(binding?.lastTurnStopReason).toBe("stop");
    expect(binding?.lastTurnUsage).toEqual({ input: 100, output: 20, total: 120 });
    expect(binding?.lastAssistantPreview).toBe("Hello there!");
    expect(binding?.turnCount).toBe(1);
    // Preserves fields it didn't touch.
    expect(binding?.threadId).toBe("thr_1");
    expect(binding?.model).toBe("claude-sonnet-5");
  });

  it("increments turnCount across successive turns", async () => {
    await store.write(IDENTITY, { threadId: "thr_1", cwd: "/tmp/ws" });
    await store.recordTurnSummary(IDENTITY, { stopReason: "stop" });
    await store.recordTurnSummary(IDENTITY, { stopReason: "stop" });
    expect((await store.read(IDENTITY))?.turnCount).toBe(2);
  });

  it("truncates a long preview and appends an ellipsis", async () => {
    await store.write(IDENTITY, { threadId: "thr_1", cwd: "/tmp/ws" });
    await store.recordTurnSummary(IDENTITY, { assistantPreview: "x".repeat(500) });
    const binding = await store.read(IDENTITY);
    expect(binding?.lastAssistantPreview?.length).toBe(201);
    expect(binding?.lastAssistantPreview?.endsWith("…")).toBe(true);
  });

  it("always stamps a fresh updatedAt on turn summaries and keeps createdAt", async () => {
    await store.write(IDENTITY, { threadId: "thr_1", cwd: "/tmp/ws" });
    const first = await store.read(IDENTITY);
    const firstUpdatedAt = first?.updatedAt;
    expect(firstUpdatedAt).toBeDefined();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    await store.recordTurnSummary(IDENTITY, { stopReason: "stop" });
    const second = await store.read(IDENTITY);
    expect(second?.updatedAt).toBeGreaterThan(firstUpdatedAt ?? 0);
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  it("keeps the previous preview when the new turn's summary omits one", async () => {
    await store.write(IDENTITY, { threadId: "thr_1", cwd: "/tmp/ws" });
    await store.recordTurnSummary(IDENTITY, { assistantPreview: "first reply" });
    await store.recordTurnSummary(IDENTITY, { stopReason: "toolUse" });
    const binding = await store.read(IDENTITY);
    expect(binding?.lastAssistantPreview).toBe("first reply");
    expect(binding?.lastTurnStopReason).toBe("toolUse");
  });

  it("treats a binding stamped by another session generation as absent", async () => {
    // Same conversation (session key), earlier session id: written before a
    // /new whose harness reset hook never ran.
    await store.write({ ...IDENTITY, sessionId: "sess-0" }, { threadId: "thr_old", cwd: "/tmp" });
    expect(await store.read(IDENTITY)).toBeNull();
    // Rebinding under the current generation replaces the stale row.
    await store.write(IDENTITY, { threadId: "thr_new", cwd: "/tmp" });
    expect((await store.read(IDENTITY))?.threadId).toBe("thr_new");
  });

  it("clear removes the binding", async () => {
    await store.write(IDENTITY, { threadId: "thr_1", cwd: "/tmp/ws" });
    await store.clear(IDENTITY);
    expect(await store.read(IDENTITY)).toBeNull();
  });

  it("falls back to a session-id key when no session key exists", async () => {
    const idOnly = { sessionId: "sess-orphan" };
    await store.write(idOnly, { threadId: "thr_1", cwd: "/tmp/ws" });
    expect((await store.read(idOnly))?.threadId).toBe("thr_1");
    expect(await store.read({ sessionId: "sess-other" })).toBeNull();
  });
});

describe("recordTurnSummary usage sanitization", () => {
  it("stores finite usage when the bridge reports a non-finite total", async () => {
    const store = createClaudeTestBindingStore();
    const identity = { sessionKey: "agent:main:direct:tester", sessionId: "sess-1" };
    await store.write(identity, { threadId: "thr_1", cwd: "/tmp/ws" });
    await store.recordTurnSummary(identity, {
      stopReason: "stop",
      usage: { input: 100, output: 20, total: Number.NaN },
    });
    const binding = await store.read(identity);
    // The whole summary write must survive; total falls back to input+output.
    expect(binding?.turnCount).toBe(1);
    expect(binding?.lastTurnUsage).toEqual({ input: 100, output: 20, total: 120 });
  });
});
