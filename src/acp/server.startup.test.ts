import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayClientCallbacks = {
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

const mockState = vi.hoisted(() => ({
  gateways: [] as MockGatewayClient[],
  gatewayAuth: [] as GatewayClientAuth[],
  gatewayOptions: [] as GatewayClientOptions[],
  agentSideConnectionCtor: vi.fn(),
  agentStart: vi.fn(),
  routeLogsToStderr: vi.fn(),
  startProxy: vi.fn(async (_config: unknown) => null as unknown),
  stopProxy: vi.fn(async (_handle: unknown) => {}),
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

  emitHello(): void {
    this.callbacks.onHelloOk?.();
  }

  emitConnectError(message: string): void {
    this.callbacks.onConnectError?.(new Error(message));
  }
}

vi.mock("@agentclientprotocol/sdk", () => ({
  AgentSideConnection: function AgentSideConnection(
    factory: (conn: unknown) => unknown,
    stream: unknown,
  ) {
    mockState.agentSideConnectionCtor(factory, stream);
    factory({});
  },
  ndJsonStream: vi.fn(() => ({ type: "mock-stream" })),
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

vi.mock("../logging/console.js", () => ({
  routeLogsToStderr: () => mockState.routeLogsToStderr(),
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

    handleGatewayReconnect(): void {}

    handleGatewayDisconnect(): void {}

    async handleGatewayEvent(): Promise<void> {}
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
    mockState.gateways.length = 0;
    mockState.gatewayAuth.length = 0;
    mockState.gatewayOptions.length = 0;
    mockState.agentSideConnectionCtor.mockReset();
    mockState.agentStart.mockReset();
    mockState.routeLogsToStderr.mockReset();
    mockState.startProxy.mockReset();
    mockState.stopProxy.mockReset();
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

  it("subscribes the Gateway client to run-scoped tool events", async () => {
    const { signalHandlers, onceSpy } = captureProcessSignalHandlers();

    try {
      const servePromise = serveAcpGateway({});
      await emitHelloAndWaitForAgentSideConnection();

      expect(mockState.gatewayOptions[0]?.caps).toEqual(["tool-events"]);

      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
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
});
