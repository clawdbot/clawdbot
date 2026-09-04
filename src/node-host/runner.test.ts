/** Tests node-host runner startup, connection configuration, and lifecycle. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { getConfigResolutionFacts, setConfigResolutionFacts } from "../config/resolution-facts.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import {
  lastCapturedOptions,
  mocks,
  resetRunnerTestState,
  runNodeHost,
  startNodeHostMcpManager,
} from "./runner.test-support.js";

describe("runNodeHost", () => {
  beforeEach(resetRunnerTestState);

  it("runs startup state migrations before constructing node-host state", async () => {
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    expect(mocks.runStartupMigrations).toHaveBeenCalledTimes(1);
    expect(mocks.runStartupMigrations.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.configureNodeHost.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it.each([
    { runtime: "darwin", platform: "macos", deviceFamily: "Mac" },
    { runtime: "win32", platform: "windows", deviceFamily: "Windows" },
    { runtime: "linux", platform: "linux", deviceFamily: "Linux" },
    { runtime: "freebsd", platform: "unknown", deviceFamily: undefined },
  ] as const)(
    "maps $runtime to gateway platform $platform",
    async ({ runtime, platform, deviceFamily }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(runtime);
      try {
        await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
          "event loop readiness timeout",
        );
      } finally {
        platformSpy.mockRestore();
      }

      expect(lastCapturedOptions()?.platform).toBe(platform);
      expect(lastCapturedOptions()?.deviceFamily).toBe(deviceFamily);
      expect(lastCapturedOptions()?.modelIdentifier).toBe(
        runtime === "freebsd" ? undefined : "TestMachine1,1",
      );
    },
  );

  it("passes a paired bootstrap credential with first-connect preference", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "gateway.example",
        gatewayPort: 443,
        gatewayTls: true,
        gatewayBootstrapToken: "bootstrap-123",
        preferGatewayBootstrapToken: true,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()).toMatchObject({
      bootstrapToken: "bootstrap-123",
      preferBootstrapToken: true,
    });
    expect(lastCapturedOptions()?.token).toBeUndefined();
    expect(mocks.resolveGatewayCredentialsWithSecretInputs).not.toHaveBeenCalled();
  });

  it("persists the pairing candidate that completes the handshake", async () => {
    mocks.useFakeRuntime = true;
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    const processOnceSpy = vi.spyOn(process, "once");
    const previousExitCode = process.exitCode;
    try {
      const running = runNodeHost({
        gatewayHost: "192.168.1.20",
        gatewayPort: 18789,
        gatewayBootstrapToken: "bootstrap-123",
        preferGatewayBootstrapToken: true,
        gatewayCandidates: [
          { host: "192.168.1.20", port: 18789, tls: false },
          { host: "gateway.tailnet.example", port: 443, tls: true },
        ],
      });
      await vi.waitFor(() => expect(mocks.capturedGatewayClients).toHaveLength(1));

      const firstOptions = mocks.capturedGatewayClientOptions[0];
      firstOptions?.onClose?.(1006, "transport unavailable", {
        phase: "pre-hello",
        socketOpened: false,
        transportValidated: false,
        connectRequestSent: false,
        transientPreHelloCleanClose: false,
      });
      await vi.waitFor(() => expect(mocks.capturedGatewayClients).toHaveLength(2));

      expect(mocks.capturedGatewayClientOptions[1]?.url).toBe("wss://gateway.tailnet.example:443");

      mocks.capturedGatewayClientOptions[1]?.onHelloOk?.({} as never);
      await vi.waitFor(() => expect(mocks.configureNodeHost).toHaveBeenCalledTimes(2));
      expect(mocks.capturedConfiguredGatewayConfigs[1]).toEqual({
        host: "gateway.tailnet.example",
        port: 443,
        tls: true,
      });

      await vi.waitFor(() =>
        expect(processOnceSpy.mock.calls.some(([event]) => event === "SIGTERM")).toBe(true),
      );
      const onSigterm = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
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
  });

  it("stops the canonical runtime after a service enrollment hello", async () => {
    mocks.useFakeRuntime = true;
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    const previousExitCode = process.exitCode;
    try {
      const running = runNodeHost({
        gatewayHost: "gateway.example",
        gatewayPort: 443,
        gatewayTls: true,
        gatewayBootstrapToken: "bootstrap-token",
        preferGatewayBootstrapToken: true,
        stopAfterFirstConnect: true,
      });
      await vi.waitFor(() => expect(lastCapturedOptions()?.onHelloOk).toBeTypeOf("function"));
      lastCapturedOptions()?.onHelloOk?.({
        protocol: 1,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await running;

      expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalledOnce();
      expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
      expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("routes invoke input, cancellation, and connection close to the runtime", async () => {
    mocks.useFakeRuntime = true;
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    const options = lastCapturedOptions();

    options?.onEvent?.({
      type: "event",
      event: "node.invoke.input",
      payload: { id: "invoke-1", nodeId: "node-1", seq: 3, payloadJSON: '{"kind":"data"}' },
    });
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.cancel",
      payload: { invokeId: "invoke-1", nodeId: "node-1" },
    });
    options?.onClose?.(1000, "connection closed");

    expect(mocks.activeRuntime.handleInput).toHaveBeenCalledWith("invoke-1", 3, '{"kind":"data"}');
    expect(mocks.activeRuntime.cancel).toHaveBeenCalledWith("invoke-1");
    expect(mocks.activeRuntime.cancelAll).toHaveBeenCalledOnce();
  });

  it.each([
    ["127.0.0.1", "ws://127.0.0.1:18789"],
    ["gateway.local", "ws://gateway.local:18789"],
    ["::1", "ws://[::1]:18789"],
    ["[::1]", "ws://[::1]:18789"],
  ])("passes Gateway host %s as URL %s", async (gatewayHost, expectedUrl) => {
    await expect(
      runNodeHost({
        gatewayHost,
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(mocks.capturedGatewayClientOptions).toHaveLength(1);
    expect(mocks.capturedGatewayClientOptions[0]?.url).toBe(expectedUrl);
    expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalled();
  });

  it("strips remote credentials before resolving local node-host auth", async () => {
    const config = {
      gateway: {
        mode: "local",
        remote: { token: "remote-token", password: "remote-password" },
      },
    };
    setConfigResolutionFacts(
      config,
      new Set(["gateway.auth.token", "gateway.remote.token", "gateway.remote.password"]),
    );
    mocks.getRuntimeConfig.mockReturnValue(config);

    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    expect(mocks.resolveGatewayCredentialsWithSecretInputs).toHaveBeenCalledWith({
      config: {
        gateway: {
          mode: "local",
          remote: { token: undefined, password: undefined },
        },
      },
      env: process.env,
      localPrecedence: "env-first",
      remoteTokenPrecedence: "env-first",
      remotePasswordPrecedence: "env-first",
    });
    const resolvedConfig =
      mocks.resolveGatewayCredentialsWithSecretInputs.mock.calls[0]?.[0].config;
    expect(getConfigResolutionFacts(resolvedConfig)).toEqual(new Set(["gateway.auth.token"]));
    expect(config.gateway.remote).toEqual({
      token: "remote-token",
      password: "remote-password",
    });
  });

  it("keeps a ref'd lifetime handle until a ready foreground host stops", async () => {
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    const unref = vi.fn();
    const interval = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => {});
    const processOnceSpy = vi.spyOn(process, "once");
    const previousExitCode = process.exitCode;
    let resolveCloseMcp: (() => void) | undefined;
    mocks.closeMcpManager.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveCloseMcp = () => resolve(undefined);
        }),
    );
    try {
      const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
      await vi.waitFor(() =>
        expect(processOnceSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function)),
      );
      await vi.waitFor(() => expect(startNodeHostMcpManager).toHaveBeenCalled());

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(unref).not.toHaveBeenCalled();
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      const onSigterm = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      expect(onSigterm).toBeTypeOf("function");
      onSigterm?.("SIGTERM");
      await vi.waitFor(() => expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalledOnce());

      expect(clearIntervalSpy).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mocks.closeMcpManager).toHaveBeenCalledOnce());
      expect(resolveCloseMcp).toBeTypeOf("function");
      resolveCloseMcp?.();
      await running;

      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    } finally {
      for (const [event, listener] of processOnceSpy.mock.calls) {
        if ((event === "SIGINT" || event === "SIGTERM") && typeof listener === "function") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      processOnceSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("clears the lifetime handle when gateway startup rejects", async () => {
    const startupError = new Error("gateway startup failed");
    mocks.startGatewayClientWhenEventLoopReady.mockRejectedValueOnce(startupError);
    const interval = {} as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => {});
    try {
      await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toBe(
        startupError,
      );

      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
      expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalledOnce();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it.each([
    ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
    ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
    ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
    ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED,
  ])("closes MCP clients before exiting on terminal reconnect pause %s", async (detailCode) => {
    const readiness = createDeferred<{ ready: false; aborted: false; elapsedMs: number }>();
    const mcpClose = createDeferred<undefined>();
    mocks.startGatewayClientWhenEventLoopReady.mockReturnValueOnce(readiness.promise);
    mocks.closeMcpManager.mockReturnValueOnce(mcpClose.promise);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
    const stopped = expect(running).rejects.toThrow("event loop readiness timeout");
    try {
      await vi.waitFor(() => expect(startNodeHostMcpManager).toHaveBeenCalled());
      lastCapturedOptions()?.onReconnectPaused?.({
        code: 1008,
        reason: "connect failed",
        detailCode,
      });
      await vi.waitFor(() => {
        expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
      });
      expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      mcpClose.resolve(undefined);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

      readiness.resolve({ ready: false, aborted: false, elapsedMs: 0 });
      await stopped;
    } finally {
      mcpClose.resolve(undefined);
      readiness.resolve({ ready: false, aborted: false, elapsedMs: 0 });
      try {
        // Shutdown owns the exit callback; keep it intercepted until the run settles.
        await stopped;
      } finally {
        exit.mockRestore();
      }
    }
  });

  it("keeps pairing reconnect pauses visible without stopping the foreground host", async () => {
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    mocks.closeMcpManager.mockClear();
    mocks.capturedGatewayClients[0]?.stop.mockClear();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      lastCapturedOptions()?.onReconnectPaused?.({
        code: 1008,
        reason: "connect failed",
        detailCode: ConnectErrorDetailCodes.PAIRING_REQUIRED,
      });

      expect(stderr).toHaveBeenCalledWith(
        "node host gateway reconnect paused after close (1008): connect failed detail=PAIRING_REQUIRED; waiting for operator action\n",
      );
      expect(mocks.closeMcpManager).not.toHaveBeenCalled();
      expect(mocks.capturedGatewayClients[0]?.stop).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
  });

  it.each([
    ["/gws", "ws://127.0.0.1:18789/gws"],
    ["/gws/", "ws://127.0.0.1:18789/gws/"],
    ["gws", "ws://127.0.0.1:18789/gws"],
    ["", "ws://127.0.0.1:18789"],
    [undefined, "ws://127.0.0.1:18789"],
  ])(
    "forwards context path %s to config and the Gateway URL",
    async (gatewayContextPath, expectedUrl) => {
      await expect(
        runNodeHost({
          gatewayHost: "127.0.0.1",
          gatewayPort: 18789,
          gatewayContextPath,
        }),
      ).rejects.toThrow("event loop readiness timeout");

      expect(lastCapturedOptions()?.url).toBe(expectedUrl);
      expect(mocks.capturedConfiguredGatewayConfigs.at(-1)?.contextPath).toBe(gatewayContextPath);
    },
  );

  it("clears configured contextPath when opts do not pass one (retarget scenario)", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "192.168.1.1",
        gatewayPort: 9999,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastConfigured =
      mocks.capturedConfiguredGatewayConfigs[mocks.capturedConfiguredGatewayConfigs.length - 1];
    expect(lastConfigured?.contextPath).toBeUndefined();
    expect(lastCapturedOptions()?.url).toBe("ws://192.168.1.1:9999");
  });
});
