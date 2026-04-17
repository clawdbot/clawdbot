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

const mockState = vi.hoisted(() => ({
  gateways: [] as MockGatewayClient[],
  gatewayAuth: [] as GatewayClientAuth[],
  agentSideConnectionCtor: vi.fn(),
  agentStart: vi.fn(),
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

  constructor(opts: GatewayClientCallbacks & GatewayClientAuth) {
    this.callbacks = opts;
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

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    gateway: {
      mode: "local",
    },
  }),
  resolveGatewayPort: vi.fn(() => 18_789),
}));

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

vi.mock("../infra/is-main.js", () => ({
  isMainModule: () => false,
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
    const gateway = getMockGateway();
    gateway.emitHello();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockState.agentSideConnectionCtor).toHaveBeenCalledTimes(1);
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
    mockState.agentSideConnectionCtor.mockReset();
    mockState.agentStart.mockReset();
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

      expect(mockState.resolveGatewayClientBootstrap).toHaveBeenCalledWith(
        expect.objectContaining({
          env: process.env,
        }),
      );
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

      expect(mockState.resolveGatewayClientBootstrap).toHaveBeenCalledWith(
        expect.objectContaining({
          env: process.env,
          gatewayUrl: "wss://override.example/ws",
        }),
      );

      await emitHelloAndWaitForAgentSideConnection();
      await stopServeWithSigint(signalHandlers, servePromise);
    } finally {
      onceSpy.mockRestore();
    }
  });
});
