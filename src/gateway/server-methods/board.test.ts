import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { InMemoryBoardStore } from "../../boards/board-store.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-descriptors.js";
import { createBoardHandlers } from "./board.js";
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

function createHarness() {
  const store = new InMemoryBoardStore();
  const broadcast = vi.fn();
  const handlers = createBoardHandlers(store);
  const invoke = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await handlers[method]!({
      req: { type: "req", id: "test", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { broadcast } as unknown as GatewayRequestContext,
    });
    return respond;
  };
  return { store, broadcast, invoke };
}

describe("board gateway methods", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetBoardEventNoticeStateForTest();
    resetSystemEventsForTest();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("registers every contract method with its required scope", () => {
    expect(
      Object.fromEntries(
        ["board.get", "board.update", "board.widget.put", "board.widget.grant", "board.event"].map(
          (method) => [method, resolveCoreOperatorGatewayMethodScope(method)],
        ),
      ),
    ).toEqual({
      "board.get": "operator.read",
      "board.update": "operator.write",
      "board.widget.put": "operator.write",
      "board.widget.grant": "operator.approvals",
      "board.event": "operator.write",
    });
  });

  it("rejects malformed params before touching the store", async () => {
    const { invoke, store } = createHarness();
    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "Invalid Name",
      content: { kind: "html", html: "ok" },
    });
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(store.listSessionsWithBoards()).toEqual([]);
  });

  it("adds fresh frame URLs only to admitted HTML widgets on board.get", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "status",
      content: { kind: "html", html: "<p>ok</p>" },
      declared: {
        netOrigins: ["https://status.example"],
        tools: ["status.refresh"],
      },
    });
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "app",
      content: {
        kind: "mcp-app",
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://resource",
          originSessionKey: "origin",
          toolCallId: "call",
        },
      },
    });

    const pendingResponse = await invoke("board.get", { sessionKey: "agent:main:main" });
    const pending = pendingResponse.mock.calls[0]?.[1] as BoardSnapshot;
    expect(pending.widgets.find((widget) => widget.name === "status")).not.toHaveProperty(
      "frameUrl",
    );

    await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "status",
      decision: "granted",
      revision: 1,
    });
    await invoke("board.widget.put", {
      sessionKey: "agent:main:main",
      name: "rejected",
      content: { kind: "html", html: "<p>no</p>" },
      declared: { tools: ["status.reject"] },
    });
    await invoke("board.widget.grant", {
      sessionKey: "agent:main:main",
      name: "rejected",
      decision: "rejected",
      revision: 1,
    });

    const firstResponse = await invoke("board.get", { sessionKey: "agent:main:main" });
    const first = firstResponse.mock.calls[0]?.[1] as BoardSnapshot;
    const htmlFrameUrl = first.widgets.find((widget) => widget.name === "status")?.frameUrl;
    expect(htmlFrameUrl).toMatch(
      /^\/__openclaw__\/board\/agent%3Amain%3Amain\/status\/index\.html\?bt=v1\./u,
    );
    expect(first.widgets.find((widget) => widget.name === "status")?.declaredSummary).toEqual([
      "Network access: https://status.example",
      "Tool access: status.refresh",
    ]);
    expect(first.widgets.find((widget) => widget.name === "app")).not.toHaveProperty("frameUrl");
    expect(first.widgets.find((widget) => widget.name === "rejected")).not.toHaveProperty(
      "frameUrl",
    );

    const secondResponse = await invoke("board.get", { sessionKey: "agent:main:main" });
    const second = secondResponse.mock.calls[0]?.[1] as BoardSnapshot;
    expect(second.widgets.find((widget) => widget.name === "status")?.frameUrl).not.toBe(
      htmlFrameUrl,
    );
  });

  it("applies updates and broadcasts board.changed", async () => {
    const { invoke, broadcast } = createHarness();
    const response = await invoke("board.update", {
      sessionKey: "session",
      ops: [{ kind: "tab_create", tabId: "notes", title: "Notes" }],
    });
    expect(response).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "session", revision: 1 }),
    );
    expect(broadcast).toHaveBeenCalledWith("board.changed", {
      sessionKey: "session",
      revision: 1,
    });
  });

  it("puts widgets, emits iframe-specific changes, and grants declared capabilities", async () => {
    const { invoke, broadcast } = createHarness();
    const put = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "weather",
      content: { kind: "html", html: "<p>weather</p>" },
      declared: { tools: ["weather.refresh"] },
    });
    expect(put).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        widgets: [expect.objectContaining({ name: "weather", grantState: "pending" })],
      }),
    );
    expect(put.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        widgets: [expect.objectContaining({ declaredSummary: ["Tool access: weather.refresh"] })],
      }),
    );
    expect(broadcast).toHaveBeenCalledWith("board.changed", {
      sessionKey: "session",
      revision: 1,
      widget: "weather",
    });

    const grant = await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "weather",
      decision: "granted",
      revision: 1,
    });
    expect(grant).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        revision: 2,
        widgets: [expect.objectContaining({ grantState: "granted" })],
      }),
    );
    expect(broadcast).toHaveBeenLastCalledWith("board.changed", {
      sessionKey: "session",
      revision: 2,
    });
  });

  it("supports rejected grants and rejects grants from non-pending state", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "widget",
      content: { kind: "html", html: "ok" },
      declared: { netOrigins: ["https://example.com"] },
    });
    const rejected = await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "widget",
      decision: "rejected",
      revision: 1,
    });
    expect(rejected.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        widgets: [expect.objectContaining({ grantState: "rejected" })],
      }),
    );
    const repeated = await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "widget",
      decision: "granted",
      revision: 1,
    });
    expect(repeated.mock.calls[0]?.[0]).toBe(false);
  });

  it("rejects stale grant revisions without changing the pending widget", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "widget",
      content: { kind: "html", html: "ok" },
      declared: { tools: ["widget.read"] },
    });
    const stale = await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "widget",
      decision: "granted",
      revision: 2,
    });
    expect(stale.mock.calls[0]?.[0]).toBe(false);
    const current = await invoke("board.get", { sessionKey: "session" });
    expect(current.mock.calls[0]?.[1]).toMatchObject({
      widgets: [{ name: "widget", revision: 1, grantState: "pending" }],
    });
  });

  it("appends bounded dashboard notices and coalesces duplicate bursts", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    const first = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: { count: 1 },
    });
    const duplicate = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: { count: 1 },
    });
    expect(first.mock.calls[0]?.[1]).toEqual({ ok: true, appended: true });
    expect(duplicate.mock.calls[0]?.[1]).toEqual({ ok: true, appended: false });
    expect(peekSystemEvents("session")).toEqual(['[dashboard] {"count":1} on widget counter']);
  });

  it("caps board.event payloads at 8KB and notices at 500 characters", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: "x".repeat(1_000),
    });
    expect(peekSystemEvents("session")[0]).toHaveLength(500);
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
