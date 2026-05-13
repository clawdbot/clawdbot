import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainSessionStoreWriterQueuesForTest } from "../config/sessions.js";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./pi-embedded-subscribe.compaction-test-helpers.js";
import {
  handleCompactionEnd,
  handleCompactionStart,
  reconcileSessionStoreCompactionCountAfterSuccess,
} from "./pi-embedded-subscribe.handlers.compaction.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

function createCompactionContext(params: {
  storePath: string;
  sessionKey: string;
  agentId?: string;
  initialCount: number;
  info?: (message: string, meta?: Record<string, unknown>) => void;
}): EmbeddedPiSubscribeContext {
  let compactionCount = params.initialCount;
  return {
    params: {
      runId: "run-test",
      session: { messages: [] } as never,
      config: { session: { store: params.storePath } } as never,
      sessionKey: params.sessionKey,
      sessionId: "session-1",
      agentId: params.agentId ?? "test-agent",
      onAgentEvent: undefined,
    },
    state: {
      compactionInFlight: true,
      pendingCompactionRetry: 0,
    } as never,
    log: {
      debug: vi.fn(),
      info: params.info ?? vi.fn(),
      warn: vi.fn(),
    },
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    incrementCompactionCount: () => {
      compactionCount += 1;
    },
    getCompactionCount: () => compactionCount,
    noteCompactionTokensAfter: vi.fn(),
    getLastCompactionTokensAfter: vi.fn(() => undefined),
  } as unknown as EmbeddedPiSubscribeContext;
}

function loggedInfoMetaAt(info: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const [, meta] = info.mock.calls[index] ?? [];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(`expected info metadata for call ${index + 1}`);
  }
  return meta as Record<string, unknown>;
}

function loggedInfoMessageAt(info: ReturnType<typeof vi.fn>, index: number): string {
  const [message] = info.mock.calls[index] ?? [];
  if (typeof message !== "string") {
    throw new Error(`expected info message for call ${index + 1}`);
  }
  return message;
}

afterEach(async () => {
  await drainSessionStoreWriterQueuesForTest();
});

describe("reconcileSessionStoreCompactionCountAfterSuccess", () => {
  it("raises the stored compaction count to the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-reconcile-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(2);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });

  it("does not double count when the store is already at or above the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-idempotent-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 3,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(3);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(3);
  });
});

describe("compaction lifecycle logging", () => {
  it("logs lifecycle events at info level for gateway watch visibility", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-log-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 0,
    });
    const info = vi.fn();
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      info,
    });

    handleCompactionStart(ctx, {
      type: "compaction_start",
      reason: "threshold",
    });
    handleCompactionEnd(ctx, {
      type: "compaction_end",
      reason: "threshold",
      result: { kept: 12 },
      willRetry: false,
      aborted: false,
    });

    expect(loggedInfoMessageAt(info, 0)).toBe("embedded run auto-compaction start");
    const startMeta = loggedInfoMetaAt(info, 0);
    expect(startMeta.event).toBe("embedded_run_compaction_start");
    expect(startMeta.reason).toBe("threshold");
    expect(startMeta.runId).toBe("run-test");
    expect(startMeta.consoleMessage).toBe(
      "embedded run auto-compaction start: runId=run-test reason=threshold",
    );

    expect(loggedInfoMessageAt(info, 1)).toBe("embedded run auto-compaction complete");
    const endMeta = loggedInfoMetaAt(info, 1);
    expect(endMeta.event).toBe("embedded_run_compaction_end");
    expect(endMeta.reason).toBe("threshold");
    expect(endMeta.runId).toBe("run-test");
    expect(endMeta.completed).toBe(true);
    expect(endMeta.compactionCount).toBe(1);
    expect(endMeta.consoleMessage).toBe(
      "embedded run auto-compaction complete: runId=run-test reason=threshold compactionCount=1 willRetry=false",
    );
  });

  it("logs manual compaction as incomplete when no result is produced", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-incomplete-log-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 0,
    });
    const info = vi.fn();
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      info,
    });

    handleCompactionStart(ctx, {
      type: "compaction_start",
      reason: "manual",
    });
    handleCompactionEnd(ctx, {
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      willRetry: false,
      aborted: false,
    });

    expect(loggedInfoMessageAt(info, 0)).toBe("embedded run manual compaction start");
    const startMeta = loggedInfoMetaAt(info, 0);
    expect(startMeta.event).toBe("embedded_run_compaction_start");
    expect(startMeta.reason).toBe("manual");
    expect(startMeta.runId).toBe("run-test");
    expect(startMeta.consoleMessage).toBe(
      "embedded run manual compaction start: runId=run-test reason=manual",
    );

    expect(loggedInfoMessageAt(info, 1)).toBe("embedded run manual compaction incomplete");
    const endMeta = loggedInfoMetaAt(info, 1);
    expect(endMeta.event).toBe("embedded_run_compaction_end");
    expect(endMeta.reason).toBe("manual");
    expect(endMeta.runId).toBe("run-test");
    expect(endMeta.completed).toBe(false);
    expect(endMeta.aborted).toBe(false);
    expect(endMeta.consoleMessage).toBe(
      "embedded run manual compaction incomplete: runId=run-test reason=manual aborted=false willRetry=false",
    );
  });

  it("defaults legacy synthetic compaction events to threshold logs", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-legacy-log-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 0,
    });
    const info = vi.fn();
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      info,
    });

    handleCompactionStart(ctx, {
      type: "compaction_start",
    });
    handleCompactionEnd(ctx, {
      type: "compaction_end",
      result: { kept: 12 },
      willRetry: false,
      aborted: false,
    });

    expect(loggedInfoMessageAt(info, 0)).toBe("embedded run auto-compaction start");
    const startMeta = loggedInfoMetaAt(info, 0);
    expect(startMeta.event).toBe("embedded_run_compaction_start");
    expect(startMeta.reason).toBe("threshold");
    expect(startMeta.runId).toBe("run-test");
    expect(startMeta.consoleMessage).toBe(
      "embedded run auto-compaction start: runId=run-test reason=threshold",
    );

    expect(loggedInfoMessageAt(info, 1)).toBe("embedded run auto-compaction complete");
    const endMeta = loggedInfoMetaAt(info, 1);
    expect(endMeta.event).toBe("embedded_run_compaction_end");
    expect(endMeta.reason).toBe("threshold");
    expect(endMeta.runId).toBe("run-test");
    expect(endMeta.completed).toBe(true);
    expect(endMeta.compactionCount).toBe(1);
    expect(endMeta.consoleMessage).toBe(
      "embedded run auto-compaction complete: runId=run-test reason=threshold compactionCount=1 willRetry=false",
    );
  });
});

describe("handleCompactionEnd", () => {
  it("reconciles the session store after a successful compaction end event", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-handler-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 1,
    });

    handleCompactionEnd(ctx, {
      type: "compaction_end",
      reason: "threshold",
      result: { kept: 12 },
      willRetry: false,
      aborted: false,
    });

    await waitForCompactionCount({
      storePath,
      sessionKey,
      expected: 2,
    });

    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
    expect(ctx.noteCompactionTokensAfter).toHaveBeenCalledWith(undefined);
  });
});
