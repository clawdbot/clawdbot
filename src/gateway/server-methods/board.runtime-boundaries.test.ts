import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createBoardHarness as createHarness } from "./board.test-support.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

vi.mock("./sessions.runtime.js", () => ({
  performGatewaySessionReset: vi.fn(async ({ key, reason }: { key: string; reason: string }) => ({
    ok: true,
    key,
    agentId: "main",
    entry: { sessionId: `reset-${reason}` },
    resolved: {},
  })),
}));

describe("board gateway runtime boundaries", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetBoardEventNoticeStateForTest();
    resetSystemEventsForTest();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("enforces data bindings against the granted tool set", async () => {
    const readDataBinding = vi.fn(async () => ({ sessions: ["one"] }));
    const { invoke, store } = createHarness(undefined, { readDataBinding });
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "reader",
      content: { kind: "html", html: "reader" },
    });
    let board = await invoke("board.get", { sessionKey: "session" });
    let snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const denied = await invoke("board.data.read", {
      ticket: snapshot.widgets[0]?.viewTicket,
      bindingId: "sessions.list",
      params: { limit: 2 },
    });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(readDataBinding).not.toHaveBeenCalled();

    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "reader",
      content: { kind: "html", html: "reader" },
      declared: { tools: ["sessions.list"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "reader",
      decision: "granted",
      revision: 2,
      instanceId: store.getSnapshot("session").widgets[0]?.instanceId,
    });
    board = await invoke("board.get", { sessionKey: "session" });
    snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const allowed = await invoke("board.data.read", {
      ticket: snapshot.widgets[0]?.viewTicket,
      bindingId: "sessions.list",
      params: { limit: 2 },
    });
    expect(allowed.mock.calls[0]?.[1]).toEqual({ sessions: ["one"] });
    expect(readDataBinding).toHaveBeenCalledWith(
      "sessions.list",
      { limit: 2 },
      expect.objectContaining({ params: expect.any(Object) }),
    );
  });

  it("rejects unknown data bindings inside the gateway allowlist boundary", async () => {
    const { invoke, store } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "reader",
      content: { kind: "html", html: "reader" },
      declared: { tools: ["secrets.dump"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "reader",
      decision: "granted",
      revision: 1,
      instanceId: store.getSnapshot("session").widgets[0]?.instanceId,
    });
    const board = await invoke("board.get", { sessionKey: "session" });
    const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const response = await invoke("board.data.read", {
      ticket: snapshot.widgets[0]?.viewTicket,
      bindingId: "secrets.dump",
    });
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not allowed") }),
    );
  });

  it("runs only the exact granted cron job capability", async () => {
    const triggerCronJob = vi.fn(async (jobId: string) => ({ ok: true, jobId }));
    const { invoke, store } = createHarness(undefined, { triggerCronJob });
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "runner",
      content: { kind: "html", html: "runner" },
      declared: { tools: ["cron.trigger:job-1"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "runner",
      decision: "granted",
      revision: 1,
      instanceId: store.getSnapshot("session").widgets[0]?.instanceId,
    });
    const board = await invoke("board.get", { sessionKey: "session" });
    const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const ticket = snapshot.widgets[0]?.viewTicket;

    const denied = await invoke("board.action", {
      ticket,
      action: "cron.trigger",
      jobId: "job-2",
    });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(triggerCronJob).not.toHaveBeenCalled();

    const allowed = await invoke("board.action", {
      ticket,
      action: "cron.trigger",
      jobId: "job-1",
    });
    expect(allowed.mock.calls[0]?.[1]).toEqual({ ok: true, jobId: "job-1" });
    expect(triggerCronJob).toHaveBeenCalledWith("job-1", expect.any(Object));
  });

  it("caps board.event payloads and preserves Unicode at the notice boundary", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    const clippedCodeUnits = 500 - "[dashboard] ".length - " on widget counter".length - 1;
    // JSON's opening quote places the emoji across the legacy slice boundary.
    const payload = `${"x".repeat(clippedCodeUnits - 2)}😀tail`;
    await invoke("board.event", { sessionKey: "session", widget: "counter", payload });
    const unicodeNotice = peekSystemEvents("agent:main:session")[0] ?? "";
    expect(unicodeNotice.length).toBeLessThanOrEqual(500);
    expect(unicodeNotice).not.toContain(String.fromCharCode(0xd83d));
    expect(unicodeNotice).toMatch(/… on widget counter$/u);
    await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: "x".repeat(1_000),
    });
    expect(peekSystemEvents("agent:main:session")[1]).toHaveLength(500);
    const oversized = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: "x".repeat(8_193),
    });
    expect(oversized.mock.calls[0]?.[0]).toBe(false);
  });

  it("keeps board state across the real sessions.reset handler", async () => {
    const sessionKey = "agent:main:board-reset-proof";
    const stateDir = tempDirs.make("openclaw-board-reset-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, storePath: database.path },
      { sessionId: "board-reset-proof", updatedAt: Date.now() },
    );
    const boardStore = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    boardStore.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });
    const respond = vi.fn<RespondFn>();
    await sessionMutationHandlers["sessions.reset"]!({
      req: { type: "req", id: "reset", method: "sessions.reset", params: {} },
      params: { key: sessionKey, reason: "reset" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        broadcast: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(boardStore.getSnapshot(sessionKey).widgets).toHaveLength(1);
  });
});
