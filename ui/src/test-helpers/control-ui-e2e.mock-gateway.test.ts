/* @vitest-environment jsdom */
// Exercises the serialized mock gateway exactly as a page would: the init
// script installs MockWebSocket on window, and requests flow over it.
import { describe, expect, it } from "vitest";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";

type ResponseFrame = {
  event?: string;
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

function flushMockTimers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function waitForMockCycle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 300);
  });
}

describe("mock gateway stateful config", () => {
  it("takes existing mock sockets offline without closing their replacement", async () => {
    const passthroughPrefix = "ws://source-ui/?token=";
    const script = createControlUiMockGatewayInitScript({
      webSocketPassthroughPrefixes: [passthroughPrefix],
    });
    window.sessionStorage.clear();
    const priorWebSocket = window.WebSocket;
    class PassthroughWebSocket extends EventTarget {
      static readonly CLOSED = 3;
      static readonly CLOSING = 2;
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readyState = PassthroughWebSocket.OPEN;

      close(): void {
        this.readyState = PassthroughWebSocket.CLOSED;
      }
    }
    window.WebSocket = PassthroughWebSocket as unknown as typeof WebSocket;

    try {
      // oxlint-disable-next-line typescript/no-implied-eval -- Exercises the serialized browser fixture.
      new Function(script)();

      const passthrough = new WebSocket(`${passthroughPrefix}vite`);
      const first = new WebSocket("ws://mock-gateway/first");
      const second = new WebSocket("ws://mock-gateway/second");
      await flushMockTimers();
      expect(passthrough.readyState).toBe(WebSocket.OPEN);
      expect(first.readyState).toBe(WebSocket.OPEN);
      expect(second.readyState).toBe(WebSocket.OPEN);

      let replacement: WebSocket | undefined;
      first.addEventListener("close", () => {
        replacement = new WebSocket("ws://mock-gateway/replacement");
      });

      const controls = (
        window as Window & {
          openclawControlUiE2eGateway?: { setOnline: (online: boolean) => void };
        }
      ).openclawControlUiE2eGateway;
      expect(controls).toBeDefined();
      controls?.setOnline(false);

      expect(passthrough.readyState).toBe(WebSocket.OPEN);
      expect(first.readyState).toBe(WebSocket.CLOSED);
      expect(second.readyState).toBe(WebSocket.CLOSED);
      expect(replacement?.readyState).toBe(WebSocket.CONNECTING);

      controls?.setOnline(true);
      expect(replacement?.readyState).toBe(WebSocket.OPEN);
    } finally {
      window.WebSocket = priorWebSocket;
    }
  });

  it("round-trips config.set through config.get with an advancing hash", async () => {
    const raw = '{\n  "logging": {\n    "level": "info"\n  }\n}\n';
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "config.get": {
          raw,
          config: { logging: { level: "info" } },
          hash: "fixture-hash",
          valid: true,
          issues: [],
        },
      },
    });
    // Execute the generated init script the way the browser <script> tag does.
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    const request = async (id: string, method: string, params: unknown) => {
      socket.send(JSON.stringify({ type: "req", id, method, params }));
      await flushMockTimers();
      const response = frames.find((frame) => frame.type === "res" && frame.id === id);
      if (!response) {
        throw new Error(`No mock response for ${method}`);
      }
      return response.payload as Record<string, unknown>;
    };

    const initial = await request("get-1", "config.get", {});
    expect(initial).toMatchObject({
      raw,
      hash: "fixture-hash",
      configRevisionHash: "fixture-hash",
      appliedConfigHash: "fixture-hash",
    });
    expect(initial.config).toEqual({ logging: { level: "info" } });

    const nextRaw = raw.replace("info", "debug");
    const set = await request("set-1", "config.set", {
      raw: nextRaw,
      baseHash: "fixture-hash",
    });
    // Acks carry the persisted hash, mirroring the real gateway contract.
    expect(set).toEqual({
      ok: true,
      hash: "mock-config-hash-1",
      config: { logging: { level: "debug" } },
    });

    const reloaded = await request("get-2", "config.get", {});
    expect(reloaded).toMatchObject({
      raw: nextRaw,
      hash: "mock-config-hash-1",
      configRevisionHash: "mock-config-hash-1",
      appliedConfigHash: "fixture-hash",
    });
    expect(reloaded.config).toEqual({ logging: { level: "debug" } });

    const applied = await request("apply-1", "config.apply", {
      raw: nextRaw,
      baseHash: "mock-config-hash-1",
    });
    expect(applied).toEqual({
      ok: true,
      hash: "mock-config-hash-2",
      config: { logging: { level: "debug" } },
    });
    expect(await request("get-3", "config.get", {})).toMatchObject({
      hash: "mock-config-hash-2",
      configRevisionHash: "mock-config-hash-2",
      appliedConfigHash: "mock-config-hash-2",
    });

    const json5Raw = '{\n  // Keep this comment.\n  logging: { level: "warn", },\n}\n';
    const json5Ack = await request("set-json5", "config.set", {
      raw: json5Raw,
      baseHash: "mock-config-hash-2",
    });
    expect(json5Ack).toEqual({
      ok: true,
      hash: "mock-config-hash-3",
      config: { logging: { level: "warn" } },
    });
    const json5Reloaded = await request("get-json5", "config.get", {});
    expect(json5Reloaded).toMatchObject({ raw: json5Raw, hash: "mock-config-hash-3" });
    expect(json5Reloaded.config).toEqual({ logging: { level: "warn" } });

    socket.close();
  });

  it("leaves config methods untouched when the scenario has no raw fixture", async () => {
    const script = createControlUiMockGatewayInitScript({
      methodResponses: { "config.set": { custom: true } },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(JSON.stringify({ type: "req", id: "set-1", method: "config.set", params: {} }));
    await flushMockTimers();
    const response = frames.find((frame) => frame.type === "res" && frame.id === "set-1");
    expect(response?.payload).toEqual({ custom: true });
    socket.close();
  });

  it("hydrates legacy persisted config state without losing revision hashes", async () => {
    const raw = '{"logging":{"level":"info"}}';
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "config.get": {
          raw,
          config: { logging: { level: "info" } },
          hash: "fixture-hash",
          appliedConfigHash: "fixture-applied-hash",
          valid: true,
          issues: [],
        },
      },
    });
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      "openclaw.control-ui-e2e.configState",
      JSON.stringify({ raw, revision: 2 }),
    );
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();
    socket.send(JSON.stringify({ type: "req", id: "get-1", method: "config.get", params: {} }));
    await flushMockTimers();

    expect(frames.find((frame) => frame.id === "get-1")?.payload).toMatchObject({
      hash: "fixture-hash",
      configRevisionHash: "fixture-hash",
      appliedConfigHash: "fixture-applied-hash",
    });
    socket.close();
  });
});

describe("mock gateway stateful sessions", () => {
  it("acknowledges broad session observation with the real Gateway response", async () => {
    const script = createControlUiMockGatewayInitScript({});
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(
      JSON.stringify({ type: "req", id: "subscribe-events", method: "sessions.subscribe" }),
    );
    await flushMockTimers();

    expect(frames.find((frame) => frame.id === "subscribe-events")?.payload).toEqual({
      subscribed: true,
    });
    socket.close();
  });

  it("makes a successfully adopted catalog session visible to the next sessions.list", async () => {
    const sessionKey = "agent:main:adopted-codex";
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.catalog.continue": { sessionKey },
      },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Exercises the serialized Gateway initialization exactly as the browser does.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(
      JSON.stringify({
        type: "req",
        id: "continue-1",
        method: "sessions.catalog.continue",
        params: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
      }),
    );
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "continue-1")?.payload).toEqual({ sessionKey });

    socket.send(
      JSON.stringify({
        type: "req",
        id: "list-adopted-1",
        method: "sessions.list",
        params: { agentId: "main", search: "adopted-codex" },
      }),
    );
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "list-adopted-1")?.payload).toMatchObject({
      count: 2,
      sessions: [
        expect.objectContaining({ key: "main" }),
        expect.objectContaining({ key: sessionKey, hasActiveRun: false, status: "done" }),
      ],
    });
    socket.close();
  });

  it("publishes a catalog adoption only after its deferred response succeeds", async () => {
    const sessionKey = "agent:main:deferred-catalog-adoption";
    const script = createControlUiMockGatewayInitScript({
      deferredMethods: ["sessions.catalog.continue"],
      methodResponses: {
        "sessions.catalog.continue": { sessionKey },
      },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Exercises the serialized Gateway initialization exactly as the browser does.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(
      JSON.stringify({
        type: "req",
        id: "deferred-adoption",
        method: "sessions.catalog.continue",
        params: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
      }),
    );
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "deferred-adoption")).toBeUndefined();

    const gateway = (
      window as unknown as {
        openclawControlUiE2eGateway?: {
          resolveDeferred: (method: string, payload?: unknown) => void;
        };
      }
    ).openclawControlUiE2eGateway;
    if (!gateway) {
      throw new Error("Mock Gateway was not installed");
    }
    gateway.resolveDeferred("sessions.catalog.continue", { sessionKey });
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "deferred-adoption")?.payload).toEqual({
      sessionKey,
    });

    socket.send(
      JSON.stringify({
        type: "req",
        id: "list-after-deferred-adoption",
        method: "sessions.list",
        params: { agentId: "main", search: "deferred-catalog-adoption" },
      }),
    );
    await flushMockTimers();
    expect(
      frames.find((frame) => frame.id === "list-after-deferred-adoption")?.payload,
    ).toMatchObject({
      count: 2,
      sessions: [
        expect.objectContaining({ key: "main" }),
        expect.objectContaining({ key: sessionKey }),
      ],
    });
    socket.close();
  });

  it("does not publish a rejected catalog adoption to sessions.list", async () => {
    const sessionKey = "agent:main:rejected-adoption";
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.catalog.continue": {
          __mockError: { code: "INVALID_REQUEST", message: "catalog adoption rejected" },
        },
      },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Exercises the serialized Gateway initialization exactly as the browser does.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(
      JSON.stringify({
        type: "req",
        id: "rejected-adoption",
        method: "sessions.catalog.continue",
        params: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
      }),
    );
    await flushMockTimers();
    socket.send(
      JSON.stringify({
        type: "req",
        id: "list-after-rejected-adoption",
        method: "sessions.list",
        params: { agentId: "main", search: "rejected-adoption" },
      }),
    );
    await flushMockTimers();

    const listed = frames.find((frame) => frame.id === "list-after-rejected-adoption")?.payload;
    expect(listed).toMatchObject({ count: 1, sessions: [{ key: "main" }] });
    expect(JSON.stringify(listed)).not.toContain(sessionKey);
    socket.close();
  });

  it("makes a newly created session visible to the next sessions.list", async () => {
    const sessionKey = "agent:main:created-session";
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.create": { key: sessionKey, runStarted: true },
      },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(
      JSON.stringify({
        type: "req",
        id: "create-1",
        method: "sessions.create",
        params: { agentId: "main" },
      }),
    );
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "create-1")?.payload).toEqual({
      key: sessionKey,
      runStarted: true,
    });

    socket.send(
      JSON.stringify({
        type: "req",
        id: "list-1",
        method: "sessions.list",
        params: { agentId: "main", search: "created-session" },
      }),
    );
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "list-1")?.payload).toMatchObject({
      count: 2,
      sessions: [
        expect.objectContaining({ key: "main" }),
        expect.objectContaining({
          key: sessionKey,
          hasActiveRun: true,
          status: "running",
        }),
      ],
    });
    socket.close();
  });

  it("does not publish a rejected session creation to sessions.list", async () => {
    const sessionKey = "agent:main:rejected-session";
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.create": {
          __mockError: { code: "INVALID_REQUEST", message: "session creation rejected" },
        },
      },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(
      JSON.stringify({
        type: "req",
        id: "rejected-create",
        method: "sessions.create",
        params: { agentId: "main", key: sessionKey },
      }),
    );
    await flushMockTimers();
    socket.send(
      JSON.stringify({
        type: "req",
        id: "list-after-rejection",
        method: "sessions.list",
        params: { agentId: "main", search: "rejected-session" },
      }),
    );
    await flushMockTimers();

    const listed = frames.find((frame) => frame.id === "list-after-rejection")?.payload;
    expect(listed).toMatchObject({ count: 1, sessions: [{ key: "main" }] });
    expect(JSON.stringify(listed)).not.toContain(sessionKey);
    socket.close();
  });

  it("cycles subscription-scoped session events and stops after unsubscribe", async () => {
    const sessionKey = "agent:main:sidebar-narration-demo";
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.companion.ask": {
          cases: [
            {
              match: { sessionKey },
              response: {
                answer: "It is rerunning the focused test to verify the latest fix.",
                ts: 1_000,
              },
            },
          ],
        },
      },
      repeatingSessionEvents: {
        intervalMs: 250,
        events: [
          {
            event: "agent",
            payload: {
              data: {
                replace: true,
                text: "Rebasing onto main and rerunning the sidebar suite.",
              },
              sessionKey,
              stream: "assistant",
            },
          },
          {
            event: "session.tool",
            payload: { data: { name: "exec" }, sessionKey, stream: "tool" },
          },
          {
            event: "session.observer",
            payload: {
              headline: "Rerunning focused tests",
              health: "grinding",
              revision: 1,
              runId: "mock-observer-run",
              sessionKey,
              updatedAt: 1_000,
            },
          },
        ],
      },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(
      JSON.stringify({
        type: "req",
        id: "subscribe-1",
        method: "sessions.messages.subscribe",
        params: { key: sessionKey },
      }),
    );
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "subscribe-1")?.payload).toEqual({
      key: sessionKey,
    });
    socket.send(
      JSON.stringify({
        type: "req",
        id: "companion-ask-1",
        method: "sessions.companion.ask",
        params: { sessionKey, question: "Why is it rerunning that test?" },
      }),
    );
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "companion-ask-1")?.payload).toEqual({
      answer: "It is rerunning the focused test to verify the latest fix.",
      ts: 1_000,
    });
    expect(frames.find((frame) => frame.event === "agent")?.payload).toMatchObject({
      sessionKey,
      stream: "assistant",
      data: { text: "Rebasing onto main and rerunning the sidebar suite." },
    });

    await waitForMockCycle();
    expect(frames.find((frame) => frame.event === "session.tool")?.payload).toMatchObject({
      sessionKey,
      stream: "tool",
      data: { name: "exec" },
    });

    await waitForMockCycle();
    expect(frames.find((frame) => frame.event === "session.observer")?.payload).toMatchObject({
      headline: "Rerunning focused tests",
      runId: "mock-observer-run",
      sessionKey,
    });

    // Second assistant cycle must repeat: the replayed snapshot carries
    // replace, so the narration controller re-renders instead of deduping.
    await waitForMockCycle();
    const assistantFrames = frames.filter((frame) => frame.event === "agent");
    expect(assistantFrames.length).toBeGreaterThanOrEqual(2);
    expect(assistantFrames.at(-1)?.payload).toMatchObject({
      sessionKey,
      stream: "assistant",
      data: { replace: true, text: "Rebasing onto main and rerunning the sidebar suite." },
    });

    socket.send(
      JSON.stringify({
        type: "req",
        id: "unsubscribe-1",
        method: "sessions.messages.unsubscribe",
        params: { key: sessionKey },
      }),
    );
    await flushMockTimers();
    const eventCount = frames.filter((frame) => frame.type === "event").length;
    await waitForMockCycle();
    expect(frames.filter((frame) => frame.type === "event")).toHaveLength(eventCount);
    socket.close();
  });

  it("keeps archive filtering opt-in for static session fixtures", async () => {
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: {},
          path: "",
          sessions: [{ key: "agent:main:research", archived: false }],
          ts: 0,
        },
        "sessions.patch": { ok: true },
      },
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    socket.send(
      JSON.stringify({
        type: "req",
        id: "patch-1",
        method: "sessions.patch",
        params: { key: "agent:main:research", archived: true },
      }),
    );
    await flushMockTimers();
    socket.send(JSON.stringify({ type: "req", id: "list-1", method: "sessions.list", params: {} }));
    await flushMockTimers();

    expect(frames.find((frame) => frame.id === "list-1")?.payload).toMatchObject({
      count: 1,
      sessions: [{ key: "agent:main:research", archived: false }],
    });
    socket.close();
  });

  it("moves archive patches between active and archived session lists", async () => {
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.list": {
          count: 2,
          defaults: {},
          path: "",
          sessions: [
            { key: "agent:main:research", archived: false },
            { key: "agent:main:launch-notes", archived: true },
          ],
          ts: 0,
        },
        "sessions.patch": { ok: true },
      },
      sessionArchiveFiltering: true,
    });
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes the generated init script standalone, proving it captures no module closures.
    new Function(script)();

    const socket = new WebSocket("ws://mock-gateway");
    const frames: ResponseFrame[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as ResponseFrame);
    });
    await flushMockTimers();

    const request = async (id: string, method: string, params: unknown) => {
      socket.send(JSON.stringify({ type: "req", id, method, params }));
      await flushMockTimers();
      const response = frames.find((frame) => frame.type === "res" && frame.id === id);
      if (!response) {
        throw new Error(`No mock response for ${method}`);
      }
      return response.payload as Record<string, unknown>;
    };
    const keys = (payload: Record<string, unknown>) =>
      (payload.sessions as Array<{ key: string }>).map((row) => row.key);

    expect(keys(await request("list-1", "sessions.list", {}))).toEqual(["agent:main:research"]);
    expect(keys(await request("list-2", "sessions.list", { archived: true }))).toEqual([
      "agent:main:launch-notes",
    ]);
    expect(
      await request("patch-3", "sessions.patch", {
        key: "agent:main:research",
        archived: true,
      }),
    ).toEqual({ ok: true });
    expect(keys(await request("list-4", "sessions.list", {}))).toEqual([]);
    expect(keys(await request("list-5", "sessions.list", { archived: true }))).toEqual([
      "agent:main:research",
      "agent:main:launch-notes",
    ]);

    await request("patch-6", "sessions.patch", {
      key: "agent:main:launch-notes",
      archived: false,
    });
    expect(keys(await request("list-7", "sessions.list", {}))).toEqual(["agent:main:launch-notes"]);
    expect(keys(await request("list-8", "sessions.list", { archived: true }))).toEqual([
      "agent:main:research",
    ]);
    socket.close();
  });
});
