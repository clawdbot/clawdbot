// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "../../../src/gateway/events.js";
import { ConnectErrorDetailCodes } from "../../../src/gateway/protocol/connect-error-details.js";
import { connectGateway, resolveControlUiClientVersion } from "./app-gateway.ts";
import type { GatewayHelloOk } from "./gateway.ts";

const loadChatHistoryMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadControlUiBootstrapConfigMock = vi.hoisted(() => vi.fn(async () => undefined));

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  options: { clientVersion?: string };
  emitHello: (hello?: GatewayHelloOk) => void;
  emitClose: (info: {
    code: number;
    reason?: string;
    error?: { code: string; message: string; details?: unknown };
  }) => void;
  emitGap: (expected: number, received: number) => void;
  emitEvent: (evt: { event: string; payload?: unknown; seq?: number }) => void;
};

const gatewayClientInstances: GatewayClientMock[] = [];

vi.mock("./gateway.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.ts")>();

  function resolveGatewayErrorDetailCode(
    error: { details?: unknown } | null | undefined,
  ): string | null {
    const details = error?.details;
    if (!details || typeof details !== "object") {
      return null;
    }
    const code = (details as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  class GatewayBrowserClient {
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly request = vi.fn(async (method: string) => {
      if (method === "update.status") {
        return { sentinel: null };
      }
      if (method === "models.authStatus") {
        return { ts: 0, providers: [] };
      }
      return {};
    });

    constructor(
      private opts: {
        clientVersion?: string;
        onHello?: (hello: GatewayHelloOk) => void;
        onClose?: (info: {
          code: number;
          reason: string;
          error?: { code: string; message: string; details?: unknown };
        }) => void;
        onGap?: (info: { expected: number; received: number }) => void;
        onEvent?: (evt: { event: string; payload?: unknown; seq?: number }) => void;
      },
    ) {
      gatewayClientInstances.push({
        start: this.start,
        stop: this.stop,
        request: this.request,
        options: { clientVersion: this.opts.clientVersion },
        emitHello: (hello) => {
          this.opts.onHello?.(
            hello ?? {
              type: "hello-ok",
              protocol: 3,
              snapshot: {},
              auth: { role: "operator", scopes: [] },
            },
          );
        },
        emitClose: (info) => {
          this.opts.onClose?.({
            code: info.code,
            reason: info.reason ?? "",
            error: info.error,
          });
        },
        emitGap: (expected, received) => {
          this.opts.onGap?.({ expected, received });
        },
        emitEvent: (evt) => {
          this.opts.onEvent?.(evt);
        },
      });
    }
  }

  return { ...actual, GatewayBrowserClient, resolveGatewayErrorDetailCode };
});

vi.mock("./controllers/chat.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controllers/chat.ts")>();
  return {
    ...actual,
    loadChatHistory: loadChatHistoryMock,
  };
});

vi.mock("./controllers/control-ui-bootstrap.ts", () => ({
  loadControlUiBootstrapConfig: loadControlUiBootstrapConfigMock,
}));

type TestGatewayHost = Parameters<typeof connectGateway>[0] & {
  chatMessages: unknown[];
  chatSideResult: unknown;
  chatSideResultTerminalRuns: Set<string>;
  chatStream: string | null;
  chatToolMessages: Record<string, unknown>[];
  toolStreamById: Map<string, unknown>;
  toolStreamOrder: string[];
};

function createHost(): TestGatewayHost {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
    },
    password: "",
    clientInstanceId: "instance-test",
    client: null,
    connected: false,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    eventLogBuffer: [],
    eventLog: [],
    tab: "overview",
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    agentsLoading: false,
    agentsList: null,
    agentsError: null,
    debugHealth: null,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    localMediaPreviewRoots: [],
    serverVersion: null,
    pendingUpdateExpectedVersion: null,
    updateStatusBanner: null,
    sessionKey: "main",
    chatMessages: [],
    chatQueue: [],
    chatToolMessages: [],
    chatStreamSegments: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatSideResult: null,
    chatSending: false,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    refreshSessionsAfterChat: new Set<string>(),
    chatSideResultTerminalRuns: new Set<string>(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
  } as unknown as TestGatewayHost;
}

function connectHostGateway() {
  const host = createHost();
  connectGateway(host);
  const client = gatewayClientInstances[0];
  expect(client).toBeDefined();
  return { host, client };
}

function emitToolResultEvent(client: GatewayClientMock) {
  client.emitEvent({
    event: "agent",
    payload: {
      runId: "engine-run-1",
      seq: 1,
      stream: "tool",
      ts: 1,
      sessionKey: "main",
      data: {
        toolCallId: "tool-1",
        name: "fetch",
        phase: "result",
        result: { text: "ok" },
      },
    },
  });
}

describe("connectGateway", () => {
  beforeEach(() => {
    gatewayClientInstances.length = 0;
    loadChatHistoryMock.mockClear();
    loadControlUiBootstrapConfigMock.mockClear();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
    });
  });

  it("ignores stale client onGap callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitGap(10, 13);
    expect(host.lastError).toBeNull();

    secondClient.emitGap(20, 24);
    expect(gatewayClientInstances).toHaveLength(3);
    expect(secondClient.stop).toHaveBeenCalledTimes(1);
    expect(host.lastError).toBeNull();
  });

  it("ignores stale client onEvent callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({ event: "presence", payload: { presence: [{ host: "stale" }] } });
    expect(host.eventLogBuffer).toHaveLength(0);

    secondClient.emitEvent({ event: "presence", payload: { presence: [{ host: "active" }] } });
    expect(host.eventLogBuffer).toHaveLength(1);
    expect(host.eventLogBuffer[0]?.event).toBe("presence");
  });

  it("applies update.available only from active client", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({
      event: GATEWAY_EVENT_UPDATE_AVAILABLE,
      payload: {
        updateAvailable: { currentVersion: "1.0.0", latestVersion: "9.9.9", channel: "latest" },
      },
    });
    expect(host.updateAvailable).toBeNull();

    secondClient.emitEvent({
      event: GATEWAY_EVENT_UPDATE_AVAILABLE,
      payload: {
        updateAvailable: { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "latest" },
      },
    });
    expect(host.updateAvailable).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
  });

  it("clears pending update verification when the restarted version matches", async () => {
    const host = createHost();
    host.pendingUpdateExpectedVersion = "2.0.0";

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    client.request.mockImplementation(async (method: string) => {
      if (method === "update.status") {
        return {
          sentinel: {
            kind: "update",
            status: "ok",
            stats: {
              after: { version: "2.0.0" },
            },
          },
        };
      }
      return {};
    });

    client.emitHello({
      type: "hello-ok",
      protocol: 3,
      server: { version: "2.0.0" },
      auth: { role: "operator", scopes: [] },
      snapshot: {},
    });

    await vi.waitFor(() => {
      expect(host.pendingUpdateExpectedVersion).toBeNull();
    });
    expect(host.updateStatusBanner).toBeNull();
  });

  it("shows a hard error when the restarted version does not match the expected update", async () => {
    const host = createHost();
    host.pendingUpdateExpectedVersion = "2.0.0";

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    client.request.mockImplementation(async (method: string) => {
      if (method === "update.status") {
        return {
          sentinel: {
            kind: "update",
            status: "ok",
            stats: {
              after: { version: "1.0.0" },
            },
          },
        };
      }
      return {};
    });

    client.emitHello({
      type: "hello-ok",
      protocol: 3,
      server: { version: "1.0.0" },
      auth: { role: "operator", scopes: [] },
      snapshot: {},
    });

    await vi.waitFor(() => {
      expect(host.pendingUpdateExpectedVersion).toBeNull();
      expect(host.updateStatusBanner?.text).toContain(
        "Update installed but running version did not change",
      );
    });
  });

  it("surfaces post-restart sentinel failures after reconnect", async () => {
    const host = createHost();
    host.pendingUpdateExpectedVersion = "2.0.0";

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    client.request.mockImplementation(async (method: string) => {
      if (method === "update.status") {
        return {
          sentinel: {
            kind: "update",
            status: "error",
            stats: {
              reason: "restart-unhealthy",
              after: { version: "1.0.0" },
            },
          },
        };
      }
      return {};
    });

    client.emitHello({
      type: "hello-ok",
      protocol: 3,
      server: { version: "1.0.0" },
      auth: { role: "operator", scopes: [] },
      snapshot: {},
    });

    await vi.waitFor(() => {
      expect(host.pendingUpdateExpectedVersion).toBeNull();
      expect(host.updateStatusBanner).toEqual({
        tone: "danger",
        text: "Update error: restart-unhealthy. The replacement process never became healthy and the previous process stayed up.",
      });
    });
  });

  it("ignores stale client onClose callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitClose({ code: 1005 });
    expect(host.lastError).toBeNull();
    expect(host.lastErrorCode).toBeNull();

    secondClient.emitClose({ code: 1005 });
    expect(host.lastError).toBe("disconnected (1005): no reason");
    expect(host.lastErrorCode).toBeNull();
  });

  it("preserves pending approval requests across reconnect", () => {
    const host = createHost();
    host.execApprovalQueue = [
      {
        id: "approval-1",
        kind: "exec",
        title: "Approve command",
        summary: "rm -rf /tmp/nope",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      } as never,
    ];

    connectGateway(host);
    expect(host.execApprovalQueue).toHaveLength(1);

    connectGateway(host);
    expect(host.execApprovalQueue).toHaveLength(1);
    expect(host.execApprovalQueue[0]?.id).toBe("approval-1");
  });

  it("maps generic fetch-failed auth errors to actionable token mismatch message", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH);
    expect(host.lastError).toContain("gateway token mismatch");
  });

  it("maps TypeError fetch failures to actionable auth rate-limit guidance", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "TypeError: Failed to fetch",
        details: { code: ConnectErrorDetailCodes.AUTH_RATE_LIMITED },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.AUTH_RATE_LIMITED);
    expect(host.lastError).toContain("too many failed authentication attempts");
  });

  it("maps generic fetch failures to actionable device identity guidance", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED);
    expect(host.lastError).toContain("device identity required");
  });

  it("maps generic fetch failures to actionable origin guidance", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED);
    expect(host.lastError).toContain("origin not allowed");
  });

  it("preserves specific close errors even when auth detail codes are present", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "Failed to fetch gateway metadata from ws://127.0.0.1:18789",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH);
    expect(host.lastError).toBe("Failed to fetch gateway metadata from ws://127.0.0.1:18789");
  });

  it("prefers structured connect errors over close reason", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message:
          "unauthorized: gateway token mismatch (open the dashboard URL and paste the token in Control UI settings)",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });

    expect(host.lastError).toContain("gateway token mismatch");
    expect(host.lastErrorCode).toBe("AUTH_TOKEN_MISMATCH");
  });

  it("surfaces scope-upgrade approval details instead of a dead pairing error", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "NOT_PAIRED",
        message: "scope upgrade pending approval (requestId: req-123)",
        details: {
          code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
          reason: "scope-upgrade",
          requestId: "req-123",
        },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.PAIRING_REQUIRED);
    expect(host.lastError).toBe("scope upgrade pending approval (requestId: req-123)");
  });

  it("surfaces shutdown restart reasons before the socket closes", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "config change requires gateway restart (plugins.installs)",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1006 });

    expect(host.lastError).toBe(
      "Restarting: config change requires gateway restart (plugins.installs)",
    );
    expect(host.lastErrorCode).toBeNull();
  });

  it("clears pending shutdown messages on successful hello after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "config change",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1006 });

    expect(host.lastError).toBe("Restarting: config change");

    client.emitHello();
    expect(host.lastError).toBeNull();

    client.emitClose({ code: 1006 });
    expect(host.lastError).toBe("disconnected (1006): no reason");
  });

  it("refreshes bootstrap config after hello", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitHello();

    expect(loadControlUiBootstrapConfigMock).toHaveBeenCalledTimes(1);
    expect(loadControlUiBootstrapConfigMock).toHaveBeenCalledWith(host, { applyIdentity: false });
  });

  it("sends queued chat aborts after reconnect before clearing pending state", async () => {
    const host = createHost();
    host.chatRunId = "run-main";
    host.chatStream = "partial";
    host.pendingAbort = { runId: "run-main", sessionKey: "main" };

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitHello();
    await Promise.resolve();

    expect(client.request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "main",
      runId: "run-main",
    });
    expect(host.pendingAbort).toBeNull();
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
  });

  it("logs and drops stale queued chat abort failures after reconnect", async () => {
    const host = createHost();
    host.pendingAbort = { runId: "run-stale", sessionKey: "main" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    const error = new Error("run already finished");
    client.request.mockImplementationOnce(async () => {
      throw error;
    });

    client.emitHello();
    await Promise.resolve();

    expect(host.pendingAbort).toBeNull();
    expect(warn).toHaveBeenCalledWith("[openclaw] pending abort failed:", error);
    warn.mockRestore();
  });

  it("keeps shutdown restart reasons on service restart closes", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1012, reason: "service restart" });

    expect(host.lastError).toBe("Restarting: gateway restarting");
    expect(host.lastErrorCode).toBeNull();
  });

  it("prefers shutdown restart reasons over non-1012 close reasons", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1001, reason: "going away" });

    expect(host.lastError).toBe("Restarting: gateway restarting");
    expect(host.lastErrorCode).toBeNull();
  });

  it("does not reload chat history for each live tool result event", () => {
    const { client } = connectHostGateway();
    emitToolResultEvent(client);

    expect(loadChatHistoryMock).not.toHaveBeenCalled();
  });

  it("stores BTW side results for the active session", () => {
    const { host, client } = connectHostGateway();

    client.emitEvent({
      event: "chat.side_result",
      payload: {
        kind: "btw",
        runId: "btw-run-1",
        sessionKey: "main",
        question: "what changed?",
        text: "Only the UI layer is missing support.",
        ts: 123,
      },
    });

    expect(host.chatSideResult).toMatchObject({
      kind: "btw",
      runId: "btw-run-1",
      question: "what changed?",
      text: "Only the UI layer is missing support.",
    });
    expect(host.chatSideResultTerminalRuns.has("btw-run-1")).toBe(true);
  });

  it("ignores tracked BTW terminal finals without tearing down the active run", () => {
    const { host, client } = connectHostGateway();
    host.chatRunId = "main-run-1";
    emitToolResultEvent(client);
    host.chatStream = "still streaming";
    expect(host.toolStreamOrder).toHaveLength(1);

    client.emitEvent({
      event: "chat.side_result",
      payload: {
        kind: "btw",
        runId: "btw-run-2",
        sessionKey: "main",
        question: "what changed?",
        text: "A dedicated side-result card now renders in webchat.",
        ts: 456,
      },
    });
    client.emitEvent({
      event: "chat",
      payload: {
        runId: "btw-run-2",
        sessionKey: "main",
        state: "final",
      },
    });

    expect(loadChatHistoryMock).not.toHaveBeenCalled();
    expect(host.chatRunId).toBe("main-run-1");
    expect(host.chatStream).toBe("still streaming");
    expect(host.toolStreamOrder).toHaveLength(1);
    expect(host.chatSideResultTerminalRuns.has("btw-run-2")).toBe(false);
  });

  it.each(["aborted", "error"] as const)(
    "cleans up tracked BTW %s events without touching the active run",
    (terminalState) => {
      const { host, client } = connectHostGateway();
      host.chatRunId = "main-run-2";
      emitToolResultEvent(client);
      host.chatStream = "stream in progress";

      client.emitEvent({
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: `btw-run-${terminalState}`,
          sessionKey: "main",
          question: "what changed?",
          text: "Detached BTW response",
          ts: 789,
        },
      });
      client.emitEvent({
        event: "chat",
        payload: {
          runId: `btw-run-${terminalState}`,
          sessionKey: "main",
          state: terminalState,
          errorMessage: terminalState === "error" ? "btw failed" : undefined,
        },
      });

      expect(host.chatSideResultTerminalRuns.has(`btw-run-${terminalState}`)).toBe(false);
      expect(host.chatRunId).toBe("main-run-2");
      expect(host.chatStream).toBe("stream in progress");
      expect(host.toolStreamOrder).toHaveLength(1);
      expect(host.lastError).toBeNull();
    },
  );

  it.each(["aborted", "error"] as const)(
    "replays deferred session.message reloads after %s clears the active run",
    (terminalState) => {
      const { host, client } = connectHostGateway();
      host.chatRunId = "main-run-3";
      loadChatHistoryMock.mockClear();

      client.emitEvent({
        event: "session.message",
        payload: {
          sessionKey: "main",
        },
      });

      expect(loadChatHistoryMock).not.toHaveBeenCalled();

      client.emitEvent({
        event: "chat",
        payload: {
          runId: "main-run-3",
          sessionKey: "main",
          state: terminalState,
          errorMessage: terminalState === "error" ? "chat failed" : undefined,
        },
      });

      expect(host.chatRunId).toBeNull();
      expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
      expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    },
  );

  it("does not reload chat history after final assistant payload reconciles an active run", () => {
    const { host, client } = connectHostGateway();
    host.chatRunId = "main-run-4";
    loadChatHistoryMock.mockClear();

    client.emitEvent({
      event: "session.message",
      payload: {
        sessionKey: "main",
      },
    });
    client.emitEvent({
      event: "chat",
      payload: {
        runId: "main-run-4",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final answer" }],
        },
      },
    });

    expect(host.chatRunId).toBeNull();
    expect(host.chatMessages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      },
    ]);
    expect(loadChatHistoryMock).not.toHaveBeenCalled();
  });

  it("replays deferred session.message reloads after legacy silent final payload", () => {
    const { host, client } = connectHostGateway();
    host.chatRunId = "main-run-silent";
    loadChatHistoryMock.mockClear();

    client.emitEvent({
      event: "session.message",
      payload: {
        sessionKey: "main",
      },
    });
    client.emitEvent({
      event: "chat",
      payload: {
        runId: "main-run-silent",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "NO_REPLY" }],
        },
      },
    });

    expect(host.chatRunId).toBeNull();
    expect(host.chatMessages).toEqual([]);
    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
  });

  it("keeps deferred session.message reload pending across unrelated terminal events", () => {
    const { host, client } = connectHostGateway();
    host.chatRunId = "main-run-5";
    host.chatStream = "still streaming";
    loadChatHistoryMock.mockClear();

    client.emitEvent({
      event: "session.message",
      payload: {
        sessionKey: "main",
      },
    });
    client.emitEvent({
      event: "chat",
      payload: {
        runId: "other-run-1",
        sessionKey: "main",
        state: "final",
      },
    });

    expect(loadChatHistoryMock).not.toHaveBeenCalled();
    expect(host.chatRunId).toBe("main-run-5");
    expect(host.chatStream).toBe("still streaming");

    client.emitEvent({
      event: "chat",
      payload: {
        runId: "main-run-5",
        sessionKey: "main",
        state: "aborted",
      },
    });

    expect(host.chatRunId).toBeNull();
    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
  });

  it("keeps deferred session.message reload pending across unowned terminal events", () => {
    const { host, client } = connectHostGateway();
    host.chatRunId = "main-run-unowned";
    host.chatStream = "still streaming";
    loadChatHistoryMock.mockClear();

    client.emitEvent({
      event: "session.message",
      payload: {
        sessionKey: "main",
      },
    });
    client.emitEvent({
      event: "chat",
      payload: {
        sessionKey: "main",
        state: "final",
      },
    });

    expect(loadChatHistoryMock).not.toHaveBeenCalled();
    expect(host.chatRunId).toBe("main-run-unowned");
    expect(host.chatStream).toBe("still streaming");

    client.emitEvent({
      event: "chat",
      payload: {
        runId: "main-run-unowned",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
        },
      },
    });

    expect(host.chatRunId).toBeNull();
    expect(loadChatHistoryMock).not.toHaveBeenCalled();
  });

  it("clears tracked BTW terminal runs after reconnect hello", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    firstClient.emitEvent({
      event: "chat.side_result",
      payload: {
        kind: "btw",
        runId: "btw-run-reconnect",
        sessionKey: "main",
        question: "what changed?",
        text: "Temporary BTW state",
        ts: 987,
      },
    });
    expect(host.chatSideResultTerminalRuns.has("btw-run-reconnect")).toBe(true);

    connectGateway(host);
    const reconnectClient = gatewayClientInstances[1];
    expect(reconnectClient).toBeDefined();

    reconnectClient.emitHello();

    expect(host.chatSideResultTerminalRuns.size).toBe(0);
  });

  it("ignores BTW side results for other sessions", () => {
    const { host, client } = connectHostGateway();

    client.emitEvent({
      event: "chat.side_result",
      payload: {
        kind: "btw",
        runId: "btw-run-3",
        sessionKey: "other-session",
        question: "what changed?",
        text: "Nothing here.",
        ts: 789,
      },
    });

    expect(host.chatSideResult).toBeNull();
    expect(host.chatSideResultTerminalRuns.size).toBe(0);
  });

  it("routes plugin.approval.requested into execApprovalQueue with kind plugin", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "plugin.approval.requested",
      payload: {
        id: "plugin-approval-1",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 120_000,
        request: {
          title: "Dangerous command detected",
          description: "chmod 777 script.sh",
          severity: "high",
          pluginId: "sage",
          agentId: "agent-1",
          sessionKey: "main",
        },
      },
    });

    expect(host.execApprovalQueue).toHaveLength(1);
    expect(host.execApprovalQueue[0]?.id).toBe("plugin-approval-1");
    expect((host.execApprovalQueue[0] as { kind: string }).kind).toBe("plugin");
  });

  it("routes plugin.approval.resolved to remove from execApprovalQueue", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    // Add a plugin approval first
    client.emitEvent({
      event: "plugin.approval.requested",
      payload: {
        id: "plugin-approval-2",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 120_000,
        request: { title: "Alert" },
      },
    });
    expect(host.execApprovalQueue).toHaveLength(1);

    // Resolve it
    client.emitEvent({
      event: "plugin.approval.resolved",
      payload: { id: "plugin-approval-2", decision: "allow-once" },
    });
    expect(host.execApprovalQueue).toHaveLength(0);
  });

  it("reloads chat history once after the final chat event when tool output was used", () => {
    const { client } = connectHostGateway();
    emitToolResultEvent(client);

    client.emitEvent({
      event: "chat",
      payload: {
        runId: "engine-run-1",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
        },
      },
    });

    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveControlUiClientVersion", () => {
  it("returns serverVersion for same-origin websocket targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "ws://localhost:8787",
        serverVersion: "2026.3.7",
        pageUrl: "http://localhost:8787/openclaw/",
      }),
    ).toBe("2026.3.7");
  });

  it("returns serverVersion for same-origin relative targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "/ws",
        serverVersion: "2026.3.7",
        pageUrl: "https://control.example.com/openclaw/",
      }),
    ).toBe("2026.3.7");
  });

  it("returns serverVersion for same-origin http targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "https://control.example.com/ws",
        serverVersion: "2026.3.7",
        pageUrl: "https://control.example.com/openclaw/",
      }),
    ).toBe("2026.3.7");
  });

  it("returns serverVersion for loopback aliases on the same port", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "ws://127.0.0.1:18789",
        serverVersion: "2026.4.24",
        pageUrl: "http://localhost:18789/chat",
      }),
    ).toBe("2026.4.24");
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "ws://[::1]:18789",
        serverVersion: "2026.4.24",
        pageUrl: "http://127.0.0.1:18789/chat",
      }),
    ).toBe("2026.4.24");
  });

  it("omits serverVersion for loopback aliases on different ports", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "ws://127.0.0.1:18789",
        serverVersion: "2026.4.24",
        pageUrl: "http://localhost:19889/chat",
      }),
    ).toBeUndefined();
  });

  it("omits serverVersion for cross-origin targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "wss://gateway.example.com",
        serverVersion: "2026.3.7",
        pageUrl: "https://control.example.com/openclaw/",
      }),
    ).toBeUndefined();
  });
});
