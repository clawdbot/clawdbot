import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError, type GatewayClientOptions } from "../gateway/client.js";
import type { configureNodeHost } from "./config.js";
import type { NodeInvokeRequestPayload } from "./invoke-types.js";
import { runNodeHost } from "./runner.js";

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  capturedGatewayClients: [] as Array<{
    request: ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>;
    stop: ReturnType<typeof vi.fn>;
    updateNodeManifest: ReturnType<typeof vi.fn>;
  }>,
  activeRuntime: {
    invoke: vi.fn(async (_payload: NodeInvokeRequestPayload) => {}),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    close: vi.fn(async () => {}),
  },
  configureNodeHost: vi.fn(async (params: Parameters<typeof configureNodeHost>[0]) => ({
    version: 1 as const,
    nodeId: params.nodeId?.trim() || "node-test",
    displayName: params.displayName?.trim() || params.fallbackDisplayName,
    gateway: params.gateway,
  })),
  getRuntimeConfig: vi.fn(() => ({
    gateway: { handshakeTimeoutMs: 1_000 },
  })),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: false,
    aborted: false,
    elapsedMs: 0,
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mocks.startGatewayClientWhenEventLoopReady,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClientRequestError: class MockGatewayClientRequestError extends Error {
    readonly gatewayCode: string;

    constructor(params: { code: string; message: string }) {
      super(params.message);
      this.gatewayCode = params.code;
    }
  },
  GatewayClient: function GatewayClient(opts: GatewayClientOptions) {
    const client = {
      request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({})),
      stop: vi.fn(),
      updateNodeManifest: vi.fn(),
    };
    mocks.capturedGatewayClientOptions.push(opts);
    mocks.capturedGatewayClients.push(client);
    return client;
  },
}));

vi.mock("../gateway/credentials-secret-inputs.js", () => ({
  resolveGatewayCredentialsWithSecretInputs: vi.fn(async () => ({})),
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: vi.fn(() => ({
    id: "device-test",
    publicKey: "public-key-test",
    privateKey: "private-key-test",
  })),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "test-node"),
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutableFromPathEnv: vi.fn(() => null),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./config.js", () => ({
  configureNodeHost: mocks.configureNodeHost,
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    commands: [],
    caps: [],
    nodePluginTools: [],
  })),
  watchRegisteredNodeHostCommandAvailability: vi.fn(() => () => undefined),
}));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    configuredServerCount: 0,
    descriptors: [],
    callMcpTool: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => []),
}));

vi.mock("./startup-state-migrations.js", () => ({
  runStartupMigrations: vi.fn(async () => undefined),
}));

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    prepareNodeHostRuntime: async () => ({
      manifest: { caps: [], commands: [], pathEnv: process.env.PATH ?? "" },
      initialInventory: { skills: [], pluginTools: [] },
      start: () => mocks.activeRuntime,
    }),
  };
});

function hello(options: GatewayClientOptions | undefined) {
  options?.onHelloOk?.({
    protocol: 1,
    features: { methods: [], events: [] },
  } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
}

function deferNegotiation(
  client: (typeof mocks.capturedGatewayClients)[number] | undefined,
): () => void {
  let resolveNegotiation: (() => void) | undefined;
  client?.request.mockImplementation((method: string) => {
    if (method === "node.protocolFeatures.update") {
      return new Promise((resolve) => {
        resolveNegotiation = () => resolve({});
      });
    }
    return Promise.resolve({});
  });
  return () => resolveNegotiation?.();
}

async function waitForProtocolFeaturesNegotiation(
  client: (typeof mocks.capturedGatewayClients)[number] | undefined,
  expectedCount = 1,
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      client?.request.mock.calls.filter(([method]) => method === "node.protocolFeatures.update"),
    ).toHaveLength(expectedCount);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function startFakeNodeHost() {
  await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
    "event loop readiness timeout",
  );
  return {
    options: mocks.capturedGatewayClientOptions[0],
    client: mocks.capturedGatewayClients[0],
  };
}

describe("node-host session envelope negotiation", () => {
  beforeEach(() => {
    mocks.capturedGatewayClientOptions.length = 0;
    mocks.capturedGatewayClients.length = 0;
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
    });
  });

  it("preserves legacy semantics for invokes received before negotiation completes", async () => {
    const { options, client } = await startFakeNodeHost();
    const resolveNegotiation = deferNegotiation(client);

    hello(options);
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.request",
      payload: {
        id: "invoke-negotiating",
        nodeId: "node-1",
        command: "system.run",
        paramsJSON: '{"sessionKey":"nested-session"}',
      },
    });
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.input",
      payload: {
        id: "invoke-negotiating",
        nodeId: "node-1",
        seq: 1,
        payloadJSON: '{"kind":"data"}',
      },
    });
    await vi.waitFor(() => {
      expect(mocks.activeRuntime.invoke).toHaveBeenCalledOnce();
      expect(mocks.activeRuntime.handleInput).toHaveBeenCalledWith(
        "invoke-negotiating",
        1,
        '{"kind":"data"}',
      );
    });
    const invokePayload = mocks.activeRuntime.invoke.mock.calls[0]?.[0];
    expect(invokePayload).toEqual(
      expect.objectContaining({
        id: "invoke-negotiating",
        paramsJSON: '{"sessionKey":"nested-session"}',
      }),
    );
    expect(Object.hasOwn(invokePayload ?? {}, "sessionKey")).toBe(false);
    expect(mocks.activeRuntime.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activeRuntime.handleInput.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    resolveNegotiation();
    await waitForProtocolFeaturesNegotiation(client);
  });

  it("does not let negotiation block explicit envelopes or unrelated controls", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { options, client } = await startFakeNodeHost();
      const resolveNegotiation = deferNegotiation(client);

      hello(options);
      options?.onEvent?.({
        type: "event",
        event: "node.invoke.request",
        payload: {
          id: "invoke-explicit-envelope",
          nodeId: "node-1",
          command: "system.run",
          timeoutMs: 10,
          sessionKey: "agent:main:explicit",
        },
      });
      options?.onEvent?.({
        type: "event",
        event: "node.invoke.input",
        payload: {
          id: "invoke-explicit-envelope",
          nodeId: "node-1",
          seq: 1,
          payloadJSON: '{"kind":"data"}',
        },
      });
      options?.onEvent?.({
        type: "event",
        event: "node.invoke.cancel",
        payload: {
          invokeId: "invoke-already-running",
          nodeId: "node-1",
        },
      });

      await vi.waitFor(() => {
        expect(mocks.activeRuntime.invoke).toHaveBeenCalledTimes(1);
        expect(mocks.activeRuntime.invoke).toHaveBeenLastCalledWith(
          expect.objectContaining({
            id: "invoke-explicit-envelope",
            sessionKey: "agent:main:explicit",
            timeoutMs: 10,
          }),
        );
        expect(mocks.activeRuntime.handleInput).toHaveBeenCalledWith(
          "invoke-explicit-envelope",
          1,
          '{"kind":"data"}',
        );
        expect(mocks.activeRuntime.cancel).toHaveBeenCalledWith("invoke-already-running");
      });
      expect(mocks.activeRuntime.invoke.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.activeRuntime.handleInput.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      resolveNegotiation();
      await waitForProtocolFeaturesNegotiation(client);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("charges queued dispatch against the invoke deadline", async () => {
    const dateNowSpy = vi.spyOn(Date, "now");
    let nowMs = 1_000;
    dateNowSpy.mockImplementation(() => nowMs);
    try {
      const { options, client } = await startFakeNodeHost();
      const resolveNegotiation = deferNegotiation(client);

      hello(options);
      options?.onEvent?.({
        type: "event",
        event: "node.invoke.request",
        payload: {
          id: "invoke-with-deadline",
          nodeId: "node-1",
          command: "system.run",
          timeoutMs: 100,
        },
      });

      nowMs += 40;
      await vi.waitFor(() => {
        expect(mocks.activeRuntime.invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "invoke-with-deadline",
            timeoutMs: 60,
          }),
        );
      });
      resolveNegotiation();
      await waitForProtocolFeaturesNegotiation(client);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("does not dispatch invokes that expire before queued dispatch", async () => {
    const dateNowSpy = vi.spyOn(Date, "now");
    let nowMs = 1_000;
    dateNowSpy.mockImplementation(() => nowMs);
    try {
      const { options, client } = await startFakeNodeHost();
      const resolveNegotiation = deferNegotiation(client);

      hello(options);
      options?.onEvent?.({
        type: "event",
        event: "node.invoke.request",
        payload: {
          id: "invoke-expired",
          nodeId: "node-1",
          command: "system.run",
          timeoutMs: 10,
        },
      });
      options?.onEvent?.({
        type: "event",
        event: "node.invoke.input",
        payload: {
          id: "invoke-expired",
          nodeId: "node-1",
          seq: 0,
          payloadJSON: '{"kind":"barrier"}',
        },
      });

      nowMs += 10;
      await vi.waitFor(() => {
        expect(mocks.activeRuntime.handleInput).toHaveBeenCalledWith(
          "invoke-expired",
          0,
          '{"kind":"barrier"}',
        );
      });
      expect(mocks.activeRuntime.invoke).not.toHaveBeenCalled();
      resolveNegotiation();
      await waitForProtocolFeaturesNegotiation(client);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("does not dispatch invokes cancelled before queued dispatch", async () => {
    const { options, client } = await startFakeNodeHost();
    const resolveNegotiation = deferNegotiation(client);

    hello(options);
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.request",
      payload: {
        id: "invoke-cancelled",
        nodeId: "node-1",
        command: "system.run",
      },
    });
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.cancel",
      payload: {
        invokeId: "invoke-cancelled",
        nodeId: "node-1",
      },
    });

    await vi.waitFor(() => {
      expect(mocks.activeRuntime.cancel).toHaveBeenCalledWith("invoke-cancelled");
    });
    expect(mocks.activeRuntime.invoke).not.toHaveBeenCalled();
    resolveNegotiation();
    await waitForProtocolFeaturesNegotiation(client);
  });

  it("preserves absent envelopes only after an old gateway is confirmed", async () => {
    const { options, client } = await startFakeNodeHost();
    client?.request.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.protocolFeatures.update",
      }),
    );

    hello(options);
    await waitForProtocolFeaturesNegotiation(client);
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.request",
      payload: {
        id: "invoke-legacy",
        nodeId: "node-1",
        command: "system.run",
        paramsJSON: '{"sessionKey":"legacy-session"}',
      },
    });

    await vi.waitFor(() => expect(mocks.activeRuntime.invoke).toHaveBeenCalledOnce());
    const payload = mocks.activeRuntime.invoke.mock.calls[0]?.[0];
    expect(payload && Object.hasOwn(payload, "sessionKey")).toBe(false);
  });

  it("renegotiates authoritative envelopes after reconnecting from an old gateway", async () => {
    const { options, client } = await startFakeNodeHost();
    client?.request.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.protocolFeatures.update",
      }),
    );

    hello(options);
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.request",
      payload: {
        id: "invoke-legacy",
        nodeId: "node-1",
        command: "system.run",
      },
    });
    await vi.waitFor(() => expect(mocks.activeRuntime.invoke).toHaveBeenCalledOnce());
    expect(Object.hasOwn(mocks.activeRuntime.invoke.mock.calls[0]?.[0] ?? {}, "sessionKey")).toBe(
      false,
    );

    options?.onClose?.(1000, "old gateway closed");
    const resolveNegotiation = deferNegotiation(client);
    hello(options);
    resolveNegotiation();
    await waitForProtocolFeaturesNegotiation(client, 2);
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.request",
      payload: {
        id: "invoke-authoritative",
        nodeId: "node-1",
        command: "system.run",
      },
    });

    await vi.waitFor(() => expect(mocks.activeRuntime.invoke).toHaveBeenCalledTimes(2));
    expect(mocks.activeRuntime.invoke.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        id: "invoke-authoritative",
        sessionKey: null,
      }),
    );
    expect(
      client?.request.mock.calls.filter(([method]) => method === "node.protocolFeatures.update"),
    ).toHaveLength(2);
  });
});
