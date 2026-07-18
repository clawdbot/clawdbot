/** Tests ACP server startup readiness, Gateway bootstrap, and shutdown wiring. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayClientCallbacks = {
  onEvent?: (evt: { event: string; payload?: unknown }) => void;
  onHelloOk?: () => void;
  onConnectError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
};

type GatewayClientAuth = {
  token?: string;
  password?: string;
};
type ResolveGatewayClientBootstrap = (params: unknown) => Promise<{
  url: string;
  urlSource: string;
  auth: GatewayClientAuth;
}>;
type GatewayClientOptions = GatewayClientCallbacks &
  GatewayClientAuth & {
    caps?: string[];
    url?: string;
  };
type MockAcpStream = {
  writable: WritableStream<unknown>;
  readable: ReadableStream<unknown>;
};

const mockState = vi.hoisted(() => ({
  acpProtocolVersion: 1,
  acpInputMessages: [] as unknown[],
  gateways: [] as MockGatewayClient[],
  gatewayAuth: [] as GatewayClientAuth[],
  gatewayOptions: [] as GatewayClientOptions[],
  agentSideConnectionCtor: vi.fn(),
  agentHandleGatewayEvent: vi.fn(async (_evt: unknown) => {}),
  agentStart: vi.fn(),
  agentShutdown: vi.fn(),
  routeLogsToStderr: vi.fn(),
  startProxy: vi.fn(async (_configForTest: unknown) => null as unknown),
  stopProxy: vi.fn(async (_handle: unknown) => {}),
  closeOpenClawStateDatabase: vi.fn(),
  gatewayStopDeferred: null as {
    resolve: () => void;
    promise: Promise<void>;
  } | null,
  resolveGatewayClientBootstrap: vi.fn<ResolveGatewayClientBootstrap>(async (_params) => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    auth: {
      token: undefined,
      password: undefined,
    },
  })),
}));

class MockGatewayClient {
  private callbacks: GatewayClientCallbacks;

  constructor(opts: GatewayClientOptions) {
    this.callbacks = opts;
    mockState.gatewayOptions.push(opts);
    mockState.gatewayAuth.push({ token: opts.token, password: opts.password });
    mockState.gateways.push(this);
  }

  start(): void {}

  stop(): void {
    this.callbacks.onClose?.(1000, "gateway stopped");
  }

  async stopAndWait(): Promise<void> {
    if (mockState.gatewayStopDeferred) {
      await mockState.gatewayStopDeferred.promise;
    }
    this.stop();
  }

  emitHello(): void {
    this.callbacks.onHelloOk?.();
  }

  emitConnectError(message: string): void {
    this.callbacks.onConnectError?.(new Error(message));
  }
  emitEvent(event: { event: string; payload?: unknown }): void {
    this.callbacks.onEvent?.(event);
  }
}

vi.mock("@agentclientprotocol/sdk", () => ({
  AGENT_METHODS: {
    initialize: "initialize",
  },
  AgentSideConnection: function AgentSideConnection(
    factory: (conn: unknown) => unknown,
    stream: unknown,
  ) {
    mockState.agentSideConnectionCtor(factory, stream);
    factory({});
  },
  PROTOCOL_VERSION: mockState.acpProtocolVersion,
  ndJsonStream: vi.fn(() => ({
    writable: new WritableStream(),
    readable: new ReadableStream({
      start(controller) {
        for (const message of mockState.acpInputMessages) {
          controller.enqueue(message);
        }
        controller.close();
      },
    }),
  })),
}));

vi.mock("../config/config.js", () => {
  const loadConfig = () => ({
    gateway: {
      mode: "local",
    },
  });
  return {
    getRuntimeConfig: loadConfig,
    loadConfig,
    resolveGatewayPort: vi.fn(() => 18_789),
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
  buildGatewayConnectionDetails: ({ url }: { url?: string }) => {
    if (typeof url === "string" && url.trim().length > 0) {
      return {
        url: url.trim(),
        urlSource: "cli --url",
      };
    }
    return {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
    };
  },
}));

vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: (params: unknown) =>
    mockState.resolveGatewayClientBootstrap(params),
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async (client: MockGatewayClient) => {
    client.start();
    return {
      ready: true,
      elapsedMs: 0,
      maxDriftMs: 0,
      checks: 2,
      aborted: false,
    };
  }),
}));

vi.mock("../infra/is-main.js", () => ({
  isMainModule: () => false,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: () => mockState.routeLogsToStderr(),
  };
});

vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabase: () => mockState.closeOpenClawStateDatabase(),
}));

vi.mock("./event-ledger.js", () => ({
  createSqliteAcpEventLedger: vi.fn(() => ({})),
}));

vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: (config: unknown) => mockState.startProxy(config),
  stopProxy: (handle: unknown) => mockState.stopProxy(handle),
}));

vi.mock("./translator.js", () => ({
  AcpGatewayAgent: class {
    start(): void {
      mockState.agentStart();
    }

    shutdown(): void {
      mockState.agentShutdown();
    }

    handleGatewayReconnect(): void {}

    handleGatewayDisconnect(): void {}

    async handleGatewayEvent(event: unknown): Promise<void> {
      await mockState.agentHandleGatewayEvent(event);
    }
  },
}));

describe("serveAcpGateway startup", () => {
  let serveAcpGateway: typeof import("./server.js").serveAcpGateway;

  function getMockGateway() {
    const gateway = mockState.gateways[0];
    if (!gateway) {
      throw new Error("Expected mocked gateway instance");
    }
    return gateway;
  }

  function getGatewayBootstrapParams(): { env?: unknown; gatewayUrl?: unknown } {
    const firstCall = mockState.resolveGatewayClientBootstrap.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected gateway bootstrap resolution call");
    }
    const params = firstCall[0];
    if (!params || typeof params !== "object") {
      throw new Error("Expected gateway bootstrap params");
    }
    return params;
  }

  function captureProcessSignalHandlers() {
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const onceSpy = vi.spyOn(process, "once").mockImplementation(((
      signal: NodeJS.Signals,
      handler: () => void,
    ) => {
      signalHandlers.set(signal, handler);
      return process;
    }) as typeof process.once);
    return { signalHandlers, onceSpy };
  }

  async function emitHelloAndWaitForAgentSideConnection() {
    await vi.waitFor(() => {
      expect(mockState.gateways).toHaveLength(1);
    });
    const gateway = getMockGateway();
    gateway.emitHello();
    await vi.waitFor(() => {
      expect(mockState.agentSideConnectionCtor).toHaveBeenCalledTimes(1);
    });
  }

  function getCapturedAcpStream(): MockAcpStream {
    const stream = mockState.agentSideConnectionCtor.mock.calls[0]?.[1];
    if (
      !stream ||
      typeof stream !== "object" ||
      !(stream as MockAcpStream).readable ||
      !(stream as MockAcpStream).writable
    ) {
      throw new Error("Expected AgentSideConnection stream");
    }
    return stream as MockAcpStream;
  }

  async function readCapturedAcpMessages(): Promise<unknown[]> {
    const reader = getCapturedAcpStream().readable.getReader();
    const messages: unknown[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return messages;
        }
        messages.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function captureAcpMessagesAfterStartup(inputMessages: unknown[]): Promise<unknown[]> {
    mockState.acpInputMessages.push(...inputMessages);
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();
    const servePromise = serveAcpGateway({});

    try {
      await emitHelloAndWaitForAgentSideConnection();
      return await readCapturedAcpMessages();
    } finally {
      signalHandlers.get("SIGINT")?.();
      await servePromise;
      onceSpy.mockRestore();
    }
  }

  async function stopServeWithSigint(
    signalHandlers: Map<NodeJS.Signals, () => void>,
    servePromise: Promise<void>,
  ) {
    signalHandlers.get("SIGINT")?.();
    await servePromise;
  }

  beforeAll(async () => {
    ({ serveAcpGateway } = await import("./server.js"));
  });

  beforeEach(async () => {
    mockState.acpInputMessages.length = 0;
    mockState.gateways.length = 0;
    mockState.gatewayAuth.length = 0;
    mockState.gatewayOptions.length = 0;
    mockState.agentSideConnectionCtor.mockReset();
    mockState.agentHandleGatewayEvent.mockReset();
    mockState.agentStart.mockReset();
    mockState.agentShutdown.mockReset();
    mockState.routeLogsToStderr.mockReset();
    mockState.startProxy.mockReset();
    mockState.stopProxy.mockReset();
    mockState.closeOpenClawStateDatabase.mockReset();
    mockState.gatewayStopDeferred = null;
    mockState.startProxy.mockResolvedValue(null);
    mockState.stopProxy.mockResolvedValue(undefined);
    mockState.resolveGatewayClientBootstrap.mockReset();
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      auth: {
        token: undefined,
        password: undefined,
      },
    });
  });

  it("preserves console exports for a co-sharded subsystem logger", async () => {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");

    expect(() =>
      createSubsystemLogger("test/acp-startup").isEnabled("info", "console"),
    ).not.toThrow();
  });

  it("waits for gateway hello before creating AgentSideConnection", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await Promise.resolve();

      expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("advertises approval handling and subscribes to run-scoped tool events", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await emitHelloAndWaitForAgentSideConnection();

      expect(mockState.gatewayOptions[0]?.caps).toEqual(["exec-approvals", "tool-events"]);

      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "default logging",
      opts: {},
      expected: ["openclaw acp: gateway event chat failed\n"],
    },
    {
      name: "verbose logging",
      opts: { verbose: true },
      expected: [
        "openclaw acp: gateway event chat failed\n",
        "openclaw acp: gateway event chat error: Error: handler boom\n",
      ],
    },
  ])("contains rejected gateway event handling with $name", async ({ opts, expected }) => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    mockState.agentHandleGatewayEvent.mockRejectedValueOnce(new Error("handler boom"));

    try {
      const servePromise = serveAcpGateway(opts);
      await emitHelloAndWaitForAgentSideConnection();

      getMockGateway().emitEvent({ event: "chat" });
      await vi.waitFor(() => {
        expect(writes).toEqual(expected);
      });

      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      writeSpy.mockRestore();
      onceSpy.mockRestore();
    }
  });

  it("routes logs to stderr before loading gateway config", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await Promise.resolve();

      expect(mockState.routeLogsToStderr).toHaveBeenCalledTimes(1);
      expect(mockState.routeLogsToStderr.mock.invocationCallOrder[0]).toBeLessThan(
        mockState.resolveGatewayClientBootstrap.mock.invocationCallOrder[0] ??
          Number.MAX_SAFE_INTEGER,
      );

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("rejects startup when gateway connect fails before hello", async () => {
    const onceSpy = vi
      .spyOn(process, "once")
      .mockImplementation(
        ((_signal: NodeJS.Signals, _handler: () => void) => process) as typeof process.once,
      );

    try {
      const servePromise = serveAcpGateway({});
      await Promise.resolve();

      const gateway = getMockGateway();
      gateway.emitConnectError("connect failed");
      await expect(servePromise).rejects.toThrow("connect failed");
      expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("passes resolved SecretInput gateway credentials to the ACP gateway client", async () => {
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      auth: {
        token: undefined,
        password: "resolved-secret-password", // pragma: allowlist secret
      },
    });
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await Promise.resolve();

      const bootstrapParams = getGatewayBootstrapParams();
      expect(bootstrapParams.env).toBe(process.env);
      expect(mockState.gatewayAuth[0]).toEqual({
        token: undefined,
        password: "resolved-secret-password", // pragma: allowlist secret
      });

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("passes CLI URL override context into shared gateway auth resolution", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({
        gatewayUrl: "wss://override.example/ws",
      });
      await Promise.resolve();

      const bootstrapParams = getGatewayBootstrapParams();
      expect(bootstrapParams.env).toBe(process.env);
      expect(bootstrapParams.gatewayUrl).toBe("wss://override.example/ws");

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("passes the configured Gateway URL into the ACP gateway client", async () => {
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      url: "ws://127.0.0.1:19999",
      urlSource: "cli --url",
      auth: {
        token: undefined,
        password: undefined,
      },
    });
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({
        gatewayUrl: "ws://127.0.0.1:19999",
      });
      await Promise.resolve();

      expect(mockState.gatewayOptions[0]?.url).toBe("ws://127.0.0.1:19999");

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("does not proxy the standalone ACP control-plane Gateway connection", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await vi.waitFor(() => {
        expect(mockState.gateways).toHaveLength(1);
      });

      expect(mockState.startProxy).not.toHaveBeenCalled();
      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
      expect(mockState.stopProxy).not.toHaveBeenCalled();
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("closes the shared state database on shutdown", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();
    expect(mockState.closeOpenClawStateDatabase).not.toHaveBeenCalled();

    try {
      const servePromise = serveAcpGateway({});
      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
      expect(mockState.agentShutdown).toHaveBeenCalledOnce();
      expect(mockState.closeOpenClawStateDatabase).toHaveBeenCalledOnce();
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("waits for Gateway transport teardown before closing the shared state database", async () => {
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    mockState.gatewayStopDeferred = { resolve: resolveStop, promise: stopPromise };
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await emitHelloAndWaitForAgentSideConnection();
      signalHandlers.get("SIGTERM")?.();
      await vi.waitFor(() => {
        expect(mockState.agentShutdown).toHaveBeenCalledOnce();
      });
      expect(mockState.closeOpenClawStateDatabase).not.toHaveBeenCalled();

      resolveStop();
      await servePromise;
      expect(mockState.closeOpenClawStateDatabase).toHaveBeenCalledOnce();
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("closes a real node:sqlite DatabaseSync handle through serveAcpGateway shutdown", async () => {
    // Use the real state-db module to open and verify a DatabaseSync handle —
    // this proves the full serveAcpGateway → shutdown → close path, not just
    // the closeOpenClawStateDatabase helper in isolation.
    const actualStateDb = await vi.importActual<typeof import("../state/openclaw-state-db.js")>(
      "../state/openclaw-state-db.js",
    );

    const realDb = actualStateDb.openOpenClawStateDatabase();
    expect(realDb.db.isOpen).toBe(true);
    expect(actualStateDb.isOpenClawStateDatabaseOpen()).toBe(true);

    // Wire the test mock so serveAcpGateway's shutdown handler calls the
    // real closeOpenClawStateDatabase, which closes the handle we opened above.
    mockState.closeOpenClawStateDatabase.mockImplementation(() => {
      actualStateDb.closeOpenClawStateDatabase();
    });

    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();
    try {
      const servePromise = serveAcpGateway({});
      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);

      // After serveAcpGateway shutdown completes, the real DatabaseSync
      // handle must be closed — proving the ACP shutdown fix works
      // end-to-end, not just in the helper function.
      expect(realDb.db.isOpen).toBe(false);
      expect(actualStateDb.isOpenClawStateDatabaseOpen()).toBe(false);
    } finally {
      actualStateDb.closeOpenClawStateDatabase();
      onceSpy.mockRestore();
    }
  });

  it("coerces MCP date-string initialize protocol versions", async () => {
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        clientCapabilities: {},
      },
    };

    await expect(captureAcpMessagesAfterStartup([initializeRequest])).resolves.toEqual([
      {
        ...initializeRequest,
        params: {
          ...initializeRequest.params,
          protocolVersion: mockState.acpProtocolVersion,
        },
      },
    ]);
  });

  it("coerces non-integer numeric initialize protocol versions", async () => {
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1.5,
        clientCapabilities: {},
      },
    };

    await expect(captureAcpMessagesAfterStartup([initializeRequest])).resolves.toEqual([
      {
        ...initializeRequest,
        params: {
          ...initializeRequest.params,
          protocolVersion: mockState.acpProtocolVersion,
        },
      },
    ]);
  });

  it("passes uint16 numeric initialize protocol versions through unchanged", async () => {
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 42,
        clientCapabilities: {},
      },
    };

    const [message] = await captureAcpMessagesAfterStartup([initializeRequest]);
    expect(message).toBe(initializeRequest);
  });

  it("passes non-initialize JSON-RPC messages through unchanged", async () => {
    const sessionRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        protocolVersion: "2025-11-25",
        cwd: "/tmp/openclaw",
      },
    };

    const [message] = await captureAcpMessagesAfterStartup([sessionRequest]);
    expect(message).toBe(sessionRequest);
  });
});
