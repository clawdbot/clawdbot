import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClient } from "../../../packages/gateway-client/src/index.js";
import {
  PROTOCOL_VERSION,
  type BoardSnapshot,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDashboardTool } from "../../agents/tools/dashboard-tool.js";
import type { InProcessGatewayCaller } from "../../agents/tools/in-process-gateway.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../../process/gateway-work-admission.test-helpers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createBoardHarness as createHarness } from "./board.test-support.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const reviewWidgetApproval = vi.hoisted(() => vi.fn());

vi.mock("../../agents/exec-auto-reviewer.js", () => ({
  createModelExecAutoReviewer: vi.fn(() => reviewWidgetApproval),
}));
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
    resetGatewayWorkAdmission();
    resetBoardEventNoticeStateForTest();
    resetSystemEventsForTest();
    reviewWidgetApproval.mockReset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
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
      instanceId: store.getSnapshot({ sessionKey: "session", agentId: "main" }).widgets[0]
        ?.instanceId,
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
      expect.objectContaining({ assertActive: expect.any(Function) }),
    );
  });

  it("fences awaited board mutation through Gateway dispatch when its root retires", async () => {
    const documentStarted = createDeferred();
    const releaseDocument = createDeferred<{ html: string; cspSandbox: "scripts" }>();
    const harness = createHarness(async () => {
      documentStarted.resolve();
      return await releaseDocument.promise;
    });
    const handler = harness.handlers["board.widget.put"];
    if (!handler) {
      throw new Error("board.widget.put handler missing");
    }
    const methodRegistry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors({ "board.widget.put": handler }),
    );
    const events: string[] = [];
    const connected = createDeferred();
    const gatewayClients = new Set<GatewayWsClient>();
    const { broadcast } = createGatewayBroadcaster({ clients: gatewayClients });
    const gatewayContext = {
      broadcast,
      getGatewayMethodRegistry: () => methodRegistry,
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main" }] },
        tools: { exec: { mode: "ask" } },
      }),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;
    gatewayContext.resolveGatewayContext = () => gatewayContext;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "board-authority-proof", ts: Date.now() },
        }),
      );
      socket.on("message", (data) => {
        const request = JSON.parse(rawDataToString(data)) as {
          id: string;
          method: string;
          params?: unknown;
          type: "req";
        };
        if (request.method === "connect") {
          gatewayClients.add({
            socket,
            connect: {
              role: "operator",
              scopes: ["operator.admin"],
            } as GatewayWsClient["connect"],
            connId: "board-authority-proof",
            usesSharedGatewayAuth: false,
          });
          socket.send(
            JSON.stringify({
              type: "res",
              id: request.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: PROTOCOL_VERSION,
                server: { version: "board-authority-proof", connId: "board-authority-proof" },
                features: { methods: ["board.widget.put"], events: ["board.changed"] },
                snapshot: {
                  presence: [],
                  health: {},
                  stateVersion: { presence: 1, health: 1 },
                  uptimeMs: 1,
                },
                auth: { role: "operator", scopes: ["operator.admin"] },
                policy: {
                  maxPayload: 512 * 1024,
                  maxBufferedBytes: 1024 * 1024,
                  tickIntervalMs: 60_000,
                },
              },
            }),
          );
          return;
        }
        void handleGatewayRequest({
          req: request,
          respond: (ok, payload, error) => {
            socket.send(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok,
                ...(payload === undefined ? {} : { payload }),
                ...(error === undefined ? {} : { error }),
              }),
            );
          },
          client: null,
          isWebchatConnect: () => false,
          context: gatewayContext,
          methodRegistry,
        });
      });
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("board authority proof server did not get a TCP address");
    }
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${address.port}`,
      onEvent: (event) => events.push(event.event ?? ""),
      onHelloOk: () => connected.resolve(),
      onConnectError: (error) => connected.reject(error),
    });
    try {
      client.start();
      await connected.promise;
      const request = client.request(
        "board.widget.put",
        {
          sessionKey: "session",
          name: "canvas",
          content: { kind: "canvas-doc", docId: "canvas-doc" },
        },
        { timeoutMs: null },
      );
      const requestOutcome = request.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await documentStarted.promise;

      resetGatewayWorkAdmission();
      releaseDocument.resolve({ html: "<p>canvas</p>", cspSandbox: "scripts" });

      const { error } = await requestOutcome;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("dashboard unavailable");
      expect(harness.store.getSnapshot({ sessionKey: "session", agentId: "main" }).widgets).toEqual(
        [],
      );
      expect(events).not.toContain("board.changed");

      await client.request("board.widget.put", {
        sessionKey: "session",
        name: "live",
        content: { kind: "canvas-doc", docId: "live-canvas-doc" },
      });
      expect(
        harness.store.getSnapshot({ sessionKey: "session", agentId: "main" }).widgets,
      ).toMatchObject([{ name: "live" }]);
      expect(events).toContain("board.changed");
    } finally {
      client.stop();
      gatewayClients.clear();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("rejects ticketed events after the issuing request authority retires", async () => {
    let active = true;
    const requestContext: { value?: GatewayRequestContext } = {};
    const harness = createHarness(undefined, undefined, undefined, {
      resolveGatewayContext: () => (active ? requestContext.value : undefined),
    });
    requestContext.value = harness.context;
    await harness.invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "counter" },
    });
    const board = await harness.invoke("board.get", { sessionKey: "session" });
    const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
    const ticket = snapshot.widgets[0]?.viewTicket;

    const allowed = await harness.invoke("board.event", { ticket, payload: { count: 1 } });
    expect(allowed.mock.calls[0]?.[0]).toBe(true);
    active = false;
    const denied = await harness.invoke("board.event", { ticket, payload: { count: 2 } });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(denied.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(peekSystemEvents("agent:main:session")).toHaveLength(1);
  });

  it.each([
    {
      name: "layout update before applyOps",
      run: async () => {
        const harness = createHarness();
        const response = await runWithGatewayRootWorkAdmissionForTest(async () => {
          resetGatewayWorkAdmission();
          return await harness.invoke("board.update", {
            sessionKey: "session",
            ops: [{ kind: "tab_create", tabId: "ops", title: "Ops" }],
          });
        });
        return {
          response,
          verify: () =>
            expect(
              harness.store.getSnapshot({ sessionKey: "session", agentId: "main" }).tabs,
            ).toEqual([]),
        };
      },
    },
    {
      name: "automatic widget approval before grant",
      run: async () => {
        const pluginRegistry = createEmptyPluginRegistry();
        markPluginRegistryActive(pluginRegistry);
        reviewWidgetApproval.mockImplementationOnce(async () => {
          markPluginRegistryRetired(pluginRegistry);
          markPluginRegistryActive(pluginRegistry);
          return {
            decision: "allow-once",
            risk: "low",
            rationale: "approved before plugin reload",
          };
        });
        const harness = createHarness(undefined, undefined, undefined, {
          getRuntimeConfig: () => ({
            agents: { list: [{ id: "main" }] },
            tools: { exec: { mode: "auto" } },
          }),
        });
        const response = await withPluginRuntimeGatewayRequestScope(
          { isWebchatConnect: () => false, pluginRegistry },
          () =>
            runWithGatewayRootWorkAdmissionForTest(() =>
              harness.invoke("board.widget.put", {
                sessionKey: "session",
                name: "approval",
                content: { kind: "html", html: "approval" },
                declared: { netOrigins: ["https://example.com"] },
              }),
            ),
        );
        return {
          response,
          verify: () =>
            expect(
              harness.store.getSnapshot({ sessionKey: "session", agentId: "main" }).widgets,
            ).toMatchObject([{ name: "approval", grantState: "pending" }]),
        };
      },
    },
    {
      name: "explicit widget grant before store grant",
      run: async () => {
        const harness = createHarness();
        const put = await harness.invoke("board.widget.put", {
          sessionKey: "session",
          name: "grant",
          content: { kind: "html", html: "grant" },
          declared: { netOrigins: ["https://example.com"] },
        });
        const snapshot = put.mock.calls[0]?.[1] as BoardSnapshot | undefined;
        const widget = snapshot?.widgets[0];
        if (!widget) {
          throw new Error("board.widget.put did not return a widget");
        }
        harness.broadcast.mockClear();
        const response = await runWithGatewayRootWorkAdmissionForTest(async () => {
          resetGatewayWorkAdmission();
          return await harness.invoke("board.widget.grant", {
            sessionKey: "session",
            name: widget.name,
            decision: "granted",
            revision: widget.revision,
            instanceId: widget.instanceId,
          });
        });
        return {
          response,
          verify: () =>
            expect(
              harness.store.getSnapshot({ sessionKey: "session", agentId: "main" }).widgets,
            ).toMatchObject([{ name: "grant", grantState: "pending" }]),
        };
      },
    },
    {
      name: "widget event before notice append",
      run: async () => {
        const harness = createHarness();
        await harness.invoke("board.widget.put", {
          sessionKey: "session",
          name: "counter",
          content: { kind: "html", html: "counter" },
        });
        harness.broadcast.mockClear();
        const response = await runWithGatewayRootWorkAdmissionForTest(async () => {
          resetGatewayWorkAdmission();
          return await harness.invoke("board.event", {
            sessionKey: "session",
            widget: "counter",
            payload: { count: 1 },
          });
        });
        return {
          response,
          verify: () => expect(peekSystemEvents("agent:main:session")).toEqual([]),
        };
      },
    },
  ])("fences $name to its request and plugin authority", async ({ run }) => {
    const { response, verify } = await run();

    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    verify();
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
      instanceId: store.getSnapshot({ sessionKey: "session", agentId: "main" }).widgets[0]
        ?.instanceId,
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
      instanceId: store.getSnapshot({ sessionKey: "session", agentId: "main" }).widgets[0]
        ?.instanceId,
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
    expect(triggerCronJob).toHaveBeenCalledWith(
      "job-1",
      expect.any(Object),
      expect.objectContaining({ assertActive: expect.any(Function) }),
    );
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
    expect(boardStore.getSnapshot({ sessionKey }).widgets).toHaveLength(1);
  });

  it("replaces a dashboard widget through Gateway while preserving layout patches", async () => {
    const sessionKey = "agent:main:board-put-proof";
    const stateDir = tempDirs.make("openclaw-board-put-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, storePath: database.path },
      { sessionId: "board-put-proof", updatedAt: Date.now() },
    );
    const createTool = () => {
      const store = new SqliteBoardStore({
        resolveSession: () => ({ agentId: "main", sessionKey }),
        env,
      });
      const { invoke } = createHarness(undefined, {}, store);
      const callGateway: InProcessGatewayCaller = async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        const response = await invoke(method, params);
        expect(response.mock.calls[0]?.[0]).toBe(true);
        return response.mock.calls[0]?.[1] as T;
      };
      return createDashboardTool({ agentSessionKey: sessionKey, agentId: "main", callGateway });
    };
    let tool = createTool();
    const put = (name: string, props?: Record<string, unknown>) =>
      tool.execute(`put-${name}`, {
        action: "widget_put",
        name,
        pluginKind: "proof:card",
        ...(props ? { props } : {}),
      });

    await put("target", { cardId: "card-123", compact: true });
    await put("sibling", { side: "right" });
    const moved = (
      await tool.execute("move", { action: "widget_move", name: "target", after: "sibling" })
    ).details as BoardSnapshot;
    expect(moved.widgets.map((widget) => widget.name)).toEqual(["sibling", "target"]);
    expect(moved.widgets[1]?.props).toEqual({ cardId: "card-123", compact: true });

    const replaced = (await put("target")).details as BoardSnapshot;
    expect(replaced.widgets.map((widget) => widget.name)).toEqual(["sibling", "target"]);
    expect(replaced.widgets[0]?.props).toEqual({ side: "right" });
    expect(replaced.widgets[1]).not.toHaveProperty("props");
    const read = (await tool.execute("read", { action: "read" })).details as BoardSnapshot;
    expect(read.widgets).toEqual(replaced.widgets);

    const descriptor = JSON.parse(
      (
        database.db
          .prepare(
            "SELECT descriptor_json FROM board_widgets WHERE session_key = ? AND name = 'target'",
          )
          .get(sessionKey) as { descriptor_json: string }
      ).descriptor_json,
    );
    expect(descriptor).not.toHaveProperty("props");

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    tool = createTool();
    const reopened = (await tool.execute("reopen", { action: "read" })).details as BoardSnapshot;
    expect(reopened.widgets).toEqual(read.widgets);
  });
});
