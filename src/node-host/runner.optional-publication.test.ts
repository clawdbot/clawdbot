import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { GatewayClientRequestError, type GatewayClientOptions } from "../gateway/client.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../infra/node-runner-inventory.js";
import type { configureNodeHost } from "./config.js";
import { runNodeHost } from "./runner.js";

const NODE_PLUGIN_TOOLS_UPDATE_METHOD = "node.pluginTools.update";
const NODE_SKILLS_UPDATE_METHOD = "node.skills.update";

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  capturedGatewayClients: [] as Array<{
    request: Mock<(method: string, params?: unknown) => Promise<unknown>>;
    stop: ReturnType<typeof vi.fn>;
    updateNodeManifest: ReturnType<typeof vi.fn>;
  }>,
  nodePluginTools: [] as Array<Record<string, unknown>>,
  nodeSkillDescriptors: [] as Array<Record<string, unknown>>,
  nodeHostCommands: [] as string[],
  nodeHostCaps: [] as string[],
  availabilityChanged: undefined as (() => void) | undefined,
  closeMcpManager: vi.fn(async () => undefined),
  configureNodeHost: vi.fn(async (params: Parameters<typeof configureNodeHost>[0]) => ({
    version: 1 as const,
    nodeId: params.nodeId?.trim() || "node-test",
    displayName: params.displayName?.trim() || params.fallbackDisplayName,
    gateway: params.gateway,
  })),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: false,
    aborted: false,
    elapsedMs: 0,
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({ gateway: { handshakeTimeoutMs: 1_000 } })),
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mocks.startGatewayClientWhenEventLoopReady,
}));

vi.mock("../gateway/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/client.js")>();
  return {
    ...actual,
    GatewayClient: function GatewayClient(opts: GatewayClientOptions) {
      const client = {
        request: vi.fn(async () => ({})),
        stop: vi.fn(),
        updateNodeManifest: vi.fn(),
      };
      mocks.capturedGatewayClientOptions.push(opts);
      mocks.capturedGatewayClients.push(client);
      return client;
    },
  };
});

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
    commands: [...mocks.nodeHostCommands],
    caps: [...mocks.nodeHostCaps],
    nodePluginTools: [...mocks.nodePluginTools],
  })),
  watchRegisteredNodeHostCommandAvailability: vi.fn((_context: unknown, onChange: () => void) => {
    mocks.availabilityChanged = onChange;
    return () => {
      mocks.availabilityChanged = undefined;
    };
  }),
}));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    descriptors: [],
    callMcpTool: vi.fn(),
    close: mocks.closeMcpManager,
  })),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => mocks.nodeSkillDescriptors),
}));

vi.mock("./startup-state-migrations.js", () => ({
  runStartupMigrations: vi.fn(async () => undefined),
}));

async function withReadyNodeHost(
  runTest: (params: {
    client: (typeof mocks.capturedGatewayClients)[number];
    options: GatewayClientOptions | undefined;
  }) => Promise<void>,
): Promise<void> {
  mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
    ready: true,
    aborted: false,
    elapsedMs: 0,
  });
  const processOnceSpy = vi.spyOn(process, "once");
  const previousExitCode = process.exitCode;
  let running: Promise<void> | undefined;
  try {
    running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
    await vi.waitFor(() => expect(mocks.availabilityChanged).toBeDefined());
    const client = mocks.capturedGatewayClients[0];
    if (!client) {
      throw new Error("expected captured Gateway client");
    }
    await runTest({ client, options: mocks.capturedGatewayClientOptions.at(-1) });
  } finally {
    const onSigterm = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
    try {
      onSigterm?.("SIGTERM");
      await running;
    } finally {
      for (const [event, listener] of processOnceSpy.mock.calls) {
        if ((event === "SIGINT" || event === "SIGTERM") && typeof listener === "function") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      processOnceSpy.mockRestore();
    }
  }
}

describe("runNodeHost connection and optional publications", () => {
  beforeEach(() => {
    mocks.capturedGatewayClientOptions.length = 0;
    mocks.capturedGatewayClients.length = 0;
    mocks.nodePluginTools = [
      {
        pluginId: "test-plugin",
        name: "remote_echo",
        description: "Echo from node host",
        command: "test.echo",
        parameters: { type: "object", properties: {} },
      },
    ];
    mocks.nodeSkillDescriptors = [];
    mocks.nodeHostCommands = [];
    mocks.nodeHostCaps = [];
    mocks.availabilityChanged = undefined;
    vi.clearAllMocks();
  });

  it("exits after three identical permanent Gateway upgrade rejections", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const rejection = new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "gateway rejected websocket upgrade (HTTP 403)",
          details: {
            reason: "websocket-upgrade-rejected",
            httpStatus: 403,
            gatewayErrorType: "proxy_attribution_required",
            gatewayErrorMessage: "Configure gateway.trustedProxies narrowly",
          },
        });
        options?.onConnectError?.(rejection);
        options?.onConnectError?.(rejection);
        expect(client.stop).not.toHaveBeenCalled();
        options?.onConnectError?.(rejection);

        await vi.waitFor(() => expect(process.exitCode).toBe(1));
        expect(client.stop).toHaveBeenCalledOnce();
        expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
        expect(stderr).toHaveBeenCalledWith(
          "node host gateway permanently rejected connection (proxy_attribution_required): Configure gateway.trustedProxies narrowly; exiting\n",
        );
      } finally {
        stderr.mockRestore();
      }
    });
  });

  it("keeps retrying transient upgrade failures and resets permanent rejection streaks", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const permanentRejection = new GatewayClientRequestError({
          code: "UNAVAILABLE",
          details: {
            reason: "websocket-upgrade-rejected",
            httpStatus: 403,
            gatewayErrorType: "proxy_attribution_required",
          },
        });
        const rejectTwice = () => {
          options?.onConnectError?.(permanentRejection);
          options?.onConnectError?.(permanentRejection);
        };
        const transientErrors = [
          new Error("connect ECONNRESET"),
          ...[
            { httpStatus: 429, gatewayErrorType: "rate_limited" },
            { httpStatus: 503, gatewayErrorType: "proxy_attribution_required" },
            { httpStatus: 403 },
            { httpStatus: 403, gatewayErrorType: "another_rejection" },
          ].map(
            (details) =>
              new GatewayClientRequestError({
                code: "UNAVAILABLE",
                details: { reason: "websocket-upgrade-rejected", ...details },
              }),
          ),
        ];

        for (const transientError of transientErrors) {
          rejectTwice();
          options?.onConnectError?.(transientError);
          expect(client.stop).not.toHaveBeenCalled();
        }
        rejectTwice();
        options?.onHelloOk?.({
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "test-connection" },
          features: { methods: [], events: [] },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 0, health: 0 },
            uptimeMs: 0,
          },
          auth: { role: "node", scopes: [] },
          policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
        });
        rejectTwice();
        expect(client.stop).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("permanently rejected"));
      } finally {
        stderr.mockRestore();
      }
    });
  });

  it("learns unsupported optional publications once per connection without a request flood", async () => {
    mocks.nodeSkillDescriptors = [
      {
        name: "release-helper",
        description: "Prepare a release",
        content: "---\nname: release-helper\ndescription: Prepare a release\n---\n",
      },
    ];
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation(async (method: string) => {
        if (
          method === NODE_PLUGIN_TOOLS_UPDATE_METHOD ||
          method === NODE_SKILLS_UPDATE_METHOD ||
          method === NODE_RUNNER_INVENTORY_UPDATE_METHOD
        ) {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: `unknown method: ${method}`,
          });
        }
        return {};
      });
      options?.onHelloOk?.({
        protocol: 3,
        features: { methods: ["health", "node.invoke.result", "node.event"], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);

      for (let index = 0; index < 10; index += 1) {
        mocks.availabilityChanged?.();
      }

      await vi.waitFor(() => {
        expect(
          client.request.mock.calls.filter(
            ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
          ),
        ).toHaveLength(1);
        expect(
          client.request.mock.calls.filter(([method]) => method === NODE_SKILLS_UPDATE_METHOD),
        ).toHaveLength(1);
        expect(
          client.request.mock.calls.filter(
            ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
          ),
        ).toEqual([
          [
            NODE_RUNNER_INVENTORY_UPDATE_METHOD,
            {
              protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
              workerHost: { enabled: false },
            },
          ],
        ]);
      });
    });
  });

  it("treats exact v3 authorization failures as unsupported optional publications", async () => {
    mocks.nodeSkillDescriptors = [
      {
        name: "release-helper",
        description: "Prepare a release",
        content: "---\nname: release-helper\ndescription: Prepare a release\n---\n",
      },
    ];
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation(async (method: string) => {
        if (
          method === NODE_PLUGIN_TOOLS_UPDATE_METHOD ||
          method === NODE_SKILLS_UPDATE_METHOD ||
          method === NODE_RUNNER_INVENTORY_UPDATE_METHOD
        ) {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "unauthorized role: node",
          });
        }
        return {};
      });
      options?.onHelloOk?.({
        protocol: 3,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => {
        expect(
          client.request.mock.calls.filter(
            ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
          ),
        ).toHaveLength(1);
      });

      mocks.availabilityChanged?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(
        client.request.mock.calls.filter(([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD),
      ).toHaveLength(1);
      expect(
        client.request.mock.calls.filter(([method]) => method === NODE_SKILLS_UPDATE_METHOD),
      ).toHaveLength(1);
      expect(
        client.request.mock.calls.filter(
          ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
        ),
      ).toHaveLength(1);

      client.request.mockResolvedValue({});
      options?.onClose?.(1000, "legacy gateway closed");
      options?.onHelloOk?.({
        protocol: 4,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);

      await vi.waitFor(() => {
        expect(
          client.request.mock.calls.filter(
            ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
          ),
        ).toHaveLength(2);
        expect(
          client.request.mock.calls.filter(([method]) => method === NODE_SKILLS_UPDATE_METHOD),
        ).toHaveLength(2);
        expect(
          client.request.mock.calls.filter(
            ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
          ),
        ).toHaveLength(2);
      });
    });
  });

  it("treats the exact v4 inventory authorization shape as an unsupported hidden method", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation(async (method: string) => {
        if (method === NODE_RUNNER_INVENTORY_UPDATE_METHOD) {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "unauthorized role: node",
          });
        }
        return {};
      });
      options?.onHelloOk?.({
        protocol: 4,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => {
        expect(
          client.request.mock.calls.filter(
            ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
          ),
        ).toHaveLength(1);
      });

      for (let index = 0; index < 10; index += 1) {
        mocks.availabilityChanged?.();
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(
        client.request.mock.calls.filter(
          ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
        ),
      ).toHaveLength(1);
    });
  });

  it.each([
    { protocol: 4, message: "unauthorized role: node", label: "exact v4 authorization" },
    { protocol: 3, message: "unauthorized role: node.", label: "near-match v3 authorization" },
  ])("fails closed without flooding on $label failures", async ({ protocol, message }) => {
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation(async (method: string) => {
        if (method === NODE_PLUGIN_TOOLS_UPDATE_METHOD) {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message,
          });
        }
        return {};
      });
      options?.onHelloOk?.({
        protocol,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => {
        expect(
          client.request.mock.calls.filter(
            ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
          ),
        ).toHaveLength(1);
      });

      for (let index = 0; index < 10; index += 1) {
        mocks.availabilityChanged?.();
      }

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(
        client.request.mock.calls.filter(([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD),
      ).toHaveLength(1);

      mocks.nodePluginTools = [];
      mocks.availabilityChanged?.();
      await vi.waitFor(() => {
        expect(
          client.request.mock.calls.filter(
            ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
          ),
        ).toHaveLength(2);
      });
      mocks.availabilityChanged?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(
        client.request.mock.calls.filter(([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD),
      ).toHaveLength(2);
    });
  });

  it("publishes the latest inventory queued during a failed optional publication", async () => {
    let rejectFirstPluginPublication: ((error: Error) => void) | undefined;
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation((method: string) => {
        if (method === NODE_PLUGIN_TOOLS_UPDATE_METHOD && !rejectFirstPluginPublication) {
          return new Promise((_resolve, reject) => {
            rejectFirstPluginPublication = reject;
          });
        }
        return Promise.resolve({});
      });
      options?.onHelloOk?.({
        protocol: 3,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => expect(rejectFirstPluginPublication).toBeDefined());

      mocks.nodePluginTools = [];
      mocks.availabilityChanged?.();
      rejectFirstPluginPublication?.(new Error("temporary publish failure"));

      await vi.waitFor(() => {
        expect(client.request).toHaveBeenCalledWith(NODE_PLUGIN_TOOLS_UPDATE_METHOD, {
          tools: [],
        });
      });
    });
  });

  it("deduplicates unchanged successful inventory while publishing and after settlement", async () => {
    let resolveInitialPublication: (() => void) | undefined;
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation((method: string) => {
        if (method === NODE_PLUGIN_TOOLS_UPDATE_METHOD && !resolveInitialPublication) {
          return new Promise((resolve) => {
            resolveInitialPublication = () => resolve({});
          });
        }
        return Promise.resolve({});
      });
      options?.onHelloOk?.({
        protocol: 4,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => expect(resolveInitialPublication).toBeDefined());

      for (let index = 0; index < 10; index += 1) {
        mocks.availabilityChanged?.();
      }
      resolveInitialPublication?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(
        client.request.mock.calls.filter(([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD),
      ).toHaveLength(1);

      mocks.availabilityChanged?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(
        client.request.mock.calls.filter(([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD),
      ).toHaveLength(1);
    });
  });

  it("does not publish stale inventory after the desired value returns to the in-flight value", async () => {
    const initialPluginTools = [...mocks.nodePluginTools];
    let resolveInitialPublication: (() => void) | undefined;
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation((method: string) => {
        if (method === NODE_PLUGIN_TOOLS_UPDATE_METHOD && !resolveInitialPublication) {
          return new Promise((resolve) => {
            resolveInitialPublication = () => resolve({});
          });
        }
        return Promise.resolve({});
      });
      options?.onHelloOk?.({
        protocol: 4,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => expect(resolveInitialPublication).toBeDefined());

      mocks.nodePluginTools = [];
      mocks.availabilityChanged?.();
      mocks.nodePluginTools = initialPluginTools;
      mocks.availabilityChanged?.();
      resolveInitialPublication?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const pluginPublications = client.request.mock.calls.filter(
        ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
      );
      expect(pluginPublications).toHaveLength(1);
      expect(pluginPublications[0]?.[1]).toEqual({ tools: initialPluginTools });
    });
  });

  it("preserves retry backoff across duplicate inventory events", async () => {
    let pluginPublicationCount = 0;
    const rejectPublications: Array<((error: Error) => void) | undefined> = [];
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation((method: string) => {
        if (method !== NODE_PLUGIN_TOOLS_UPDATE_METHOD) {
          return Promise.resolve({});
        }
        pluginPublicationCount += 1;
        if (pluginPublicationCount <= 3) {
          return new Promise((_resolve, reject) => {
            rejectPublications[pluginPublicationCount - 1] = reject;
          });
        }
        return Promise.resolve({});
      });
      options?.onHelloOk?.({
        protocol: 4,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => expect(rejectPublications[0]).toBeDefined());

      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const flushPublicationSettlement = async () => {
          for (let index = 0; index < 10; index += 1) {
            await Promise.resolve();
          }
        };
        mocks.availabilityChanged?.();
        rejectPublications[0]?.(new Error("temporary publish failure"));
        await flushPublicationSettlement();
        expect(pluginPublicationCount).toBe(1);
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 250);
        await vi.runOnlyPendingTimersAsync();
        await flushPublicationSettlement();
        expect(pluginPublicationCount).toBe(2);
        mocks.availabilityChanged?.();
        rejectPublications[1]?.(new Error("temporary publish failure"));
        await flushPublicationSettlement();
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 500);
        await vi.runOnlyPendingTimersAsync();
        await flushPublicationSettlement();
        expect(pluginPublicationCount).toBe(3);
        mocks.availabilityChanged?.();
        rejectPublications[2]?.(new Error("temporary publish failure"));
        await flushPublicationSettlement();
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1_000);
        await vi.runOnlyPendingTimersAsync();
        await flushPublicationSettlement();
        expect(pluginPublicationCount).toBe(4);
      } finally {
        setTimeoutSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("republishes an acknowledged value after an ambiguous different-value failure", async () => {
    const initialPluginTools = [...mocks.nodePluginTools];
    let pluginPublicationCount = 0;
    let rejectChangedPublication: ((error: Error) => void) | undefined;
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation((method: string) => {
        if (method !== NODE_PLUGIN_TOOLS_UPDATE_METHOD) {
          return Promise.resolve({});
        }
        pluginPublicationCount += 1;
        if (pluginPublicationCount === 2) {
          return new Promise((_resolve, reject) => {
            rejectChangedPublication = reject;
          });
        }
        return Promise.resolve({});
      });
      options?.onHelloOk?.({
        protocol: 4,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => expect(pluginPublicationCount).toBe(1));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      mocks.nodePluginTools = [];
      mocks.availabilityChanged?.();
      await vi.waitFor(() => expect(rejectChangedPublication).toBeDefined());
      rejectChangedPublication?.(new Error("publication outcome unknown"));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      mocks.nodePluginTools = initialPluginTools;
      mocks.availabilityChanged?.();
      await vi.waitFor(() => {
        const publications = client.request.mock.calls.filter(
          ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
        );
        expect(publications.length).toBeGreaterThanOrEqual(3);
        expect(publications.at(-1)?.[1]).toEqual({ tools: initialPluginTools });
      });
    });
  });

  it("retains the latest inventory when it returns to a previously rejected value", async () => {
    const initialPluginTools = [...mocks.nodePluginTools];
    let pluginPublicationCount = 0;
    let rejectFirstPluginPublication: ((error: Error) => void) | undefined;
    let resolveSecondPluginPublication: (() => void) | undefined;
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation((method: string) => {
        if (method !== NODE_PLUGIN_TOOLS_UPDATE_METHOD) {
          return Promise.resolve({});
        }
        pluginPublicationCount += 1;
        if (pluginPublicationCount === 1) {
          return new Promise((_resolve, reject) => {
            rejectFirstPluginPublication = reject;
          });
        }
        if (pluginPublicationCount === 2) {
          return new Promise((resolve) => {
            resolveSecondPluginPublication = () => resolve({});
          });
        }
        return Promise.resolve({});
      });
      options?.onHelloOk?.({
        protocol: 4,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => expect(rejectFirstPluginPublication).toBeDefined());

      mocks.nodePluginTools = [];
      mocks.availabilityChanged?.();
      rejectFirstPluginPublication?.(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "temporary validation failure",
        }),
      );
      await vi.waitFor(() => expect(resolveSecondPluginPublication).toBeDefined());

      mocks.nodePluginTools = initialPluginTools;
      mocks.availabilityChanged?.();
      resolveSecondPluginPublication?.();

      await vi.waitFor(() => {
        const pluginPublications = client.request.mock.calls.filter(
          ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
        );
        expect(pluginPublications).toHaveLength(3);
        expect(pluginPublications.at(-1)?.[1]).toEqual({ tools: initialPluginTools });
      });
    });
  });

  it.each([true, false])("retires inventory before manifest reconnect", async (deferInitial) => {
    let resolveInitialPublication: (() => void) | undefined;
    await withReadyNodeHost(async ({ client, options }) => {
      const pluginPublications = () =>
        client.request.mock.calls.filter(([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD);
      if (deferInitial) {
        client.request.mockImplementation((method: string) => {
          if (method === NODE_PLUGIN_TOOLS_UPDATE_METHOD && !resolveInitialPublication) {
            return new Promise((resolve) => {
              resolveInitialPublication = () => resolve({});
            });
          }
          return Promise.resolve({});
        });
      }
      options?.onHelloOk?.({
        protocol: 3,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      if (deferInitial) {
        await vi.waitFor(() => expect(resolveInitialPublication).toBeDefined());
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(pluginPublications()).toHaveLength(1);

      Object.assign(mocks, { nodePluginTools: [], nodeHostCaps: ["canvas"] });
      mocks.availabilityChanged?.();
      resolveInitialPublication?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(pluginPublications()).toHaveLength(1);

      options?.onHelloOk?.({
        protocol: 3,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await vi.waitFor(() => expect(pluginPublications()).toHaveLength(2));
      expect(client.request).toHaveBeenLastCalledWith(NODE_PLUGIN_TOOLS_UPDATE_METHOD, {
        tools: [],
      });
    });
  });

  it("does not report a stale publication failure after manifest reconnect", async () => {
    let rejectInitialPublication: ((error: Error) => void) | undefined;
    await withReadyNodeHost(async ({ client, options }) => {
      client.request.mockImplementation((method: string) => {
        if (method === NODE_PLUGIN_TOOLS_UPDATE_METHOD && !rejectInitialPublication) {
          return new Promise((_resolve, reject) => {
            rejectInitialPublication = reject;
          });
        }
        return Promise.resolve({});
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        options?.onHelloOk?.({
          protocol: 3,
          features: { methods: [], events: [] },
        } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
        await vi.waitFor(() => expect(rejectInitialPublication).toBeDefined());
        stderr.mockClear();

        Object.assign(mocks, { nodePluginTools: [], nodeHostCaps: ["canvas"] });
        mocks.availabilityChanged?.();
        rejectInitialPublication?.(new Error("gateway closed (1012): node manifest changed"));

        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("publish failed"));
      } finally {
        stderr.mockRestore();
      }
    });
  });
});
