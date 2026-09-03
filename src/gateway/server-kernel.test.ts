import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

describe("createGatewayKernel", () => {
  it("does not start recovered channels after close prelude begins", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-breaker-recovery-close",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        VITEST: "1",
      },
    });
    const originalPluginRegistry = captureActivePluginRegistrySnapshot();
    const startAccount = vi.fn(async () => {});
    const channelPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "telegram",
        config: {
          listAccountIds: (config) => Object.keys(config.channels?.telegram?.accounts ?? {}),
          resolveAccount: (config, accountId) =>
            config.channels?.telegram?.accounts?.[accountId ?? "default"] ?? {},
          isConfigured: (account) =>
            typeof (account as { botToken?: unknown }).botToken === "string",
        },
      }),
      gateway: { startAccount },
    };
    const registry = createTestRegistry([
      {
        pluginId: channelPlugin.id,
        plugin: channelPlugin,
        source: "gateway-kernel-test",
      },
    ]);
    registry.plugins.push(
      createPluginRecord({
        id: channelPlugin.id,
        source: "gateway-kernel-test",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      }),
    );
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    try {
      stageActivePluginRegistry(registry, null, "default");
      const token = "gateway-kernel-breaker-recovery-token";
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "telegram-breaker-recovery-token" },
            },
          },
        },
      });
      state.applyEnv();
      kernel = await createGatewayKernel(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        channelAutostartSuppression: {
          reason: "crash-loop-breaker",
          message: "safe mode",
        },
        controlUiEnabled: false,
        sidecarStartup: "defer",
        tryRecoverChannelAutostartSuppression: () => true,
      });

      await expect(kernel.channelManager.recoverAutostartSuppression()).resolves.toBe(true);
      expect(startAccount).not.toHaveBeenCalled();

      await kernel.beginClosePrelude();
      kernel.releaseStartupAccountStarts();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(startAccount).not.toHaveBeenCalled();
      expect(kernel.channelManager.isAutoRestartScheduled("telegram", "default")).toBe(false);
    } finally {
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        restoreActivePluginRegistrySnapshot(originalPluginRegistry);
        await state.cleanup();
      }
    }
  });

  it("reports startup and readiness as draining during a direct close", async () => {
    const port = 19_789;
    const state = await createOpenClawTestState({
      label: "gateway-kernel-direct-close-readiness",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-kernel-direct-close-readiness-token";
    const bootId = "gateway-kernel-direct-close";
    const configReloaderStop = createDeferred();
    const updateCheckStopped = createDeferred();
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      });
      state.applyEnv();
      kernel = await createGatewayKernel(port, {
        bootId,
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      kernel.kernel.unlockStartupMethods();
      kernel.kernel.markSidecarsReady();
      const { getStartup, getReadiness } = kernel.createHttpTransportOptions();
      expect(getStartup()).toMatchObject({ ok: true, status: "started" });
      expect(getReadiness()).toMatchObject({ ready: true, failing: [] });
      const reader = {
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
          role: "operator",
          scopes: ["operator.read"],
        },
        authenticatedUserProfile: {
          profileId: ensureProfileForEmail("mention-reader@example.test").id,
          displayName: "Reader",
          hasAvatar: false,
          updatedAt: 1,
        },
      } satisfies GatewayClient;
      expect(kernel.gatewayRequestContext.mentionInbox?.list(reader)).toMatchObject({
        ok: true,
        value: { gatewayInstanceId: bootId, items: [] },
      });

      const closeFirstStop = vi.fn(async () => {});
      kernel.kernel.swapBonjourStop(closeFirstStop);
      vi.spyOn(kernel.runtimeState.configReloader, "stop").mockReturnValue(
        configReloaderStop.promise,
      );
      const stopUpdateCheck = vi
        .spyOn(kernel.runtimeState, "stopGatewayUpdateCheck")
        .mockReturnValue(updateCheckStopped.promise);
      closing = kernel.createCloseHandler()({ reason: "direct close readiness test" });

      expect(getStartup()).toMatchObject({ ok: false, status: "draining" });
      expect(getReadiness()).toMatchObject({ ready: false, failing: ["gateway-draining"] });
      expect(kernel.gatewayRequestContext.mentionInbox?.list(reader)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      configReloaderStop.resolve();
      await vi.waitFor(() => expect(stopUpdateCheck).toHaveBeenCalled());
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closeFirstStop).not.toHaveBeenCalled();
      updateCheckStopped.resolve();
      await closing;
      expect(closeFirstStop).toHaveBeenCalledOnce();
      expect(kernel.runtimeState.bonjourStop).toBeNull();
    } finally {
      configReloaderStop.resolve();
      updateCheckStopped.resolve();
      try {
        await closing;
      } finally {
        try {
          await kernel?.closeOnStartupFailure();
        } finally {
          await state.cleanup();
        }
      }
    }
  });

  it("keeps startup readiness and sidecar shutdown at their lifecycle boundaries", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-deferred-readiness",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        VITEST: "1",
      },
    });
    const token = "gateway-kernel-deferred-readiness-token";
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    try {
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
      });
      state.applyEnv();
      kernel = await createGatewayKernel(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      const activeKernel = kernel;

      const client = createSyntheticPluginRuntimeClient({
        scopes: [...CLI_DEFAULT_OPERATOR_SCOPES],
      });
      const dispatchOptions = {
        client,
        context: kernel.gatewayRequestContext,
        methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
      };
      const runId = "deferred-readiness-chat";
      const chatParams = {
        sessionKey: "agent:main:deferred-readiness",
        message: "readiness truth",
        idempotencyKey: runId,
      };

      const getReadiness = kernel.createHttpTransportOptions().getReadiness;
      expect(getReadiness()).toMatchObject({
        ready: false,
        failing: ["startup-sidecars"],
      });
      await expect(
        dispatchGatewayRequestInProcess("chat.send", chatParams, dispatchOptions),
      ).rejects.toThrow("chat.send unavailable during gateway startup");

      kernel.dedupe.set(`chat:${runId}`, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "ok" },
      });
      kernel.kernel.unlockStartupMethods();
      kernel.kernel.markSidecarsReady();

      expect(getReadiness()).toMatchObject({ ready: true, failing: [] });
      await expect(
        dispatchGatewayRequestInProcess("chat.send", chatParams, dispatchOptions),
      ).resolves.toEqual({ runId, status: "ok" });

      const cleanupError = new Error("lifetime sidecar cleanup failed");
      let rejectFirstStop!: (error: Error) => void;
      const firstStop = new Promise<void>((_resolve, reject) => {
        rejectFirstStop = reject;
      });
      const reentrantSidecar = { stop: vi.fn(async () => {}) };
      let reentrantStop!: Promise<void>;
      const lifetimeSidecar = {
        stop: vi.fn<() => Promise<void>>().mockImplementationOnce(() => {
          activeKernel.registerGatewayLifetimeSidecars([lifetimeSidecar, reentrantSidecar]);
          reentrantStop = activeKernel.stopRegisteredGatewayLifetimeSidecars();
          return firstStop;
        }),
      };
      lifetimeSidecar.stop.mockResolvedValue(undefined);
      const trailingSidecar = vi.fn(async () => {});
      kernel.kernel.setGatewayLifetimeSidecars([lifetimeSidecar, { stop: trailingSidecar }]);

      const postReadyError = new Error("post-ready sidecar cleanup failed");
      let rejectPostReadyStop!: (error: Error) => void;
      const firstPostReadyStop = new Promise<void>((_resolve, reject) => {
        rejectPostReadyStop = reject;
      });
      const postReadySidecar = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(() => firstPostReadyStop)
        .mockResolvedValue(undefined);
      kernel.kernel.setPostReadySidecars([{ stop: postReadySidecar }]);

      const closePreludeReached = vi.spyOn(kernel.watchNodeHttpRuntime, "close");
      const closing = kernel.closeOnStartupFailure();
      await vi.waitFor(() => {
        expect(lifetimeSidecar.stop).toHaveBeenCalledOnce();
      });
      const lateSidecar = { stop: vi.fn(async () => {}) };
      kernel.registerGatewayLifetimeSidecars([lifetimeSidecar, lateSidecar]);
      const lateStop = kernel.stopRegisteredGatewayLifetimeSidecars();
      rejectFirstStop(cleanupError);

      await expect(reentrantStop).resolves.toBeUndefined();
      await expect(lateStop).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(postReadySidecar).toHaveBeenCalledOnce();
      });
      let releaseLateLifetimeStop!: () => void;
      const lateLifetimeStop = new Promise<void>((resolve) => {
        releaseLateLifetimeStop = resolve;
      });
      const lateLifetimeSidecar = { stop: vi.fn(() => lateLifetimeStop) };
      kernel.registerGatewayLifetimeSidecars([lateLifetimeSidecar]);
      let closeSettled = false;
      void closing.then(() => {
        closeSettled = true;
      });
      rejectPostReadyStop(postReadyError);
      await vi.waitFor(() => {
        expect(closePreludeReached).toHaveBeenCalledOnce();
      });
      expect(closeSettled).toBe(false);
      const duringSealSidecar = { stop: vi.fn(async () => {}) };
      kernel.registerGatewayLifetimeSidecars([duringSealSidecar]);
      releaseLateLifetimeStop();
      await expect(closing).resolves.toBeUndefined();
      closePreludeReached.mockRestore();
      expect(lifetimeSidecar.stop).toHaveBeenCalledTimes(2);
      expect(trailingSidecar).toHaveBeenCalledOnce();
      expect(reentrantSidecar.stop).toHaveBeenCalledOnce();
      expect(lateSidecar.stop).toHaveBeenCalledOnce();
      expect(duringSealSidecar.stop).toHaveBeenCalledOnce();
      expect(postReadySidecar).toHaveBeenCalledTimes(2);
      expect(kernel.runtimeState.gatewayLifetimeSidecars).toEqual([]);
      expect(kernel.runtimeState.postReadySidecars).toEqual([]);

      const postSealSidecar = { stop: vi.fn(async () => {}) };
      expect(() => activeKernel.registerGatewayLifetimeSidecars([postSealSidecar])).toThrow(
        "cannot publish a Gateway sidecar after shutdown sealed its owner",
      );
      expect(kernel.runtimeState.gatewayLifetimeSidecars).toEqual([]);
      expect(postSealSidecar.stop).not.toHaveBeenCalled();

      const persistentError = new Error("persistent sidecar cleanup failed");
      const persistentStop = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(persistentError)
        .mockRejectedValueOnce(persistentError)
        .mockResolvedValue(undefined);
      const persistentSidecar = { stop: persistentStop };
      const successfulPeer = { stop: vi.fn(async () => {}) };
      kernel.kernel.setGatewayLifetimeSidecars([persistentSidecar, successfulPeer]);

      await expect(kernel.closeOnStartupFailure()).resolves.toBeUndefined();
      expect(persistentStop).toHaveBeenCalledTimes(2);
      expect(successfulPeer.stop).toHaveBeenCalledOnce();
      expect(kernel.runtimeState.gatewayLifetimeSidecars).toEqual([persistentSidecar]);

      await expect(kernel.closeOnStartupFailure()).resolves.toBeUndefined();
      expect(persistentStop).toHaveBeenCalledTimes(3);
      expect(successfulPeer.stop).toHaveBeenCalledOnce();
      expect(kernel.runtimeState.gatewayLifetimeSidecars).toEqual([]);
    } finally {
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        await state.cleanup();
      }
    }
  });

  it("dispatches health and an agent turn without creating a transport", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-no-transport",
      layout: "home",
      env: {
        OPENCLAW_DIAGNOSTICS: "1",
        OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const originalPluginRegistry = captureActivePluginRegistrySnapshot();
    const inspectAccount = vi.fn(() => ({ enabled: true, configured: true }));
    const capturedRegistryCleanup = vi.fn();
    const ambientPlugin = createChannelTestPluginBase({
      id: "telegram",
      config: { inspectAccount },
    });
    const ambientRegistry = createTestRegistry([
      {
        pluginId: ambientPlugin.id,
        plugin: ambientPlugin,
        source: "gateway-kernel-test",
      },
    ]);
    ambientRegistry.plugins.push(
      createPluginRecord({
        id: ambientPlugin.id,
        source: "gateway-kernel-test",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      }),
    );
    ambientRegistry.runtimeLifecycles.push({
      pluginId: ambientPlugin.id,
      pluginName: ambientPlugin.meta.label,
      lifecycle: {
        id: "gateway-kernel-test-cleanup",
        cleanup: capturedRegistryCleanup,
      },
      source: "gateway-kernel-test",
    });
    let capturedLoadedPluginRegistry:
      | ReturnType<typeof captureActivePluginRegistrySnapshot>
      | undefined;
    let prematureCleanupCalls: number | undefined;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    try {
      stageActivePluginRegistry(ambientRegistry, null, "default");
      capturedLoadedPluginRegistry = captureActivePluginRegistrySnapshot();
      const timelinePath = state.path("kernel-startup.jsonl");
      state.envVars.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
      const token = "gateway-kernel-no-transport-token";
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
      });
      state.applyEnv();
      stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");

      kernel = await createGatewayKernel(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      expect(kernel.transportBridge.current()).toBeUndefined();
      await expect(kernel.ensureSandboxHostPort()).rejects.toThrow(
        "Gateway listener must start before the sandbox host",
      );

      kernel.kernel.setDispatchReady(true);
      const client = createSyntheticPluginRuntimeClient({
        scopes: [...CLI_DEFAULT_OPERATOR_SCOPES],
      });
      await expect(
        dispatchGatewayRequestInProcess(
          "health",
          {},
          {
            client,
            context: kernel.gatewayRequestContext,
            methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
          },
        ),
      ).resolves.toEqual(expect.objectContaining({ ok: true }));

      const idempotencyKey = "kernel-factory-agent";
      kernel.dedupe.set(`agent:${idempotencyKey}`, {
        ts: Date.now(),
        ok: true,
        payload: { runId: "kernel-run", status: "ok", summary: "cached" },
      });
      await expect(
        kernel.gatewayInstanceRuntime.recovery.dispatchAgent({
          message: "kernel factory proof",
          idempotencyKey,
        }),
      ).resolves.toEqual({ runId: "kernel-run", status: "ok", summary: "cached" });
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      flushDiagnosticsTimeline();
      const timeline = (await fs.readFile(timelinePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const measureNames = timeline
        .filter((event) => event.type === "span.start" && event.phase === "startup")
        .map((event) => {
          const attributes = event.attributes as { traceName?: string } | undefined;
          return attributes?.traceName ?? event.name;
        });
      expect(measureNames).toEqual([
        "state.ownership",
        "state.runtime-imports",
        "state.schema-preflight",
        "runtime.network-imports",
        "runtime.network-bootstrap",
        "config.runtime-imports",
        "config.snapshot",
        "config.snapshot.read",
        "config.snapshot.read.file",
        "config.snapshot.read.hash",
        "config.snapshot.read.parse",
        "config.snapshot.read.includes",
        "config.snapshot.read.env",
        "config.snapshot.read.validate",
        "plugins.metadata.scan",
        "plugins.metadata.freeze",
        "config.snapshot.read.materialize",
        "config.snapshot.read.observe",
        "config.auth",
        "config.auth.snapshot-validate",
        "config.auth.runtime-overrides",
        "config.auth.startup-overrides",
        "config.auth.secret-surface",
        "config.auth.secret-preflight",
        "config.auth.preflight-override",
        "config.auth.ensure",
        "config.auth.runtime-startup-overrides",
        "config.auth.secrets-activate",
        "agents.github-profile-cleanup",
        "plugins.bootstrap-imports",
        "startup.maintenance",
        "plugins.bootstrap",
        "gateway.kernel-state",
        "node-desktop.runtime-import",
        "runtime.config",
        "control-ui.root",
        "terminal.launch-import",
        "gateway.wizard-imports",
        "tls.runtime",
        "gateway.channel-manager-import",
        "runtime.state",
        "gateway.shutdown-runtime-import",
        "gateway.lifecycle",
        "gateway.core-runtime",
        "runtime.post-early-imports",
        "runtime.subscriptions",
        "runtime.services",
        "gateway.handlers",
        "runtime.early",
        "runtime.early.discovery",
        "gateway.request-runtime",
        "gateway.config-revision-key",
        "gateway.request-context",
      ]);
    } finally {
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        try {
          flushDiagnosticsTimeline();
          await state.cleanup();
        } finally {
          if (capturedLoadedPluginRegistry) {
            restoreActivePluginRegistrySnapshot(capturedLoadedPluginRegistry);
          }
          prematureCleanupCalls = capturedRegistryCleanup.mock.calls.length;
          restoreActivePluginRegistrySnapshot(originalPluginRegistry);
        }
      }
    }
    expect(prematureCleanupCalls).toBe(0);
    await vi.waitFor(() => expect(capturedRegistryCleanup).toHaveBeenCalledOnce());
    expect(inspectAccount).not.toHaveBeenCalled();
  });

  it("runs kernel teardown when required TLS material is unavailable", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-tls-failure",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const token = "gateway-kernel-tls-failure-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
        tls: {
          enabled: true,
          autoGenerate: false,
          certPath: state.path("missing-cert.pem"),
          keyPath: state.path("missing-key.pem"),
        },
      },
    });
    state.applyEnv();
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway tls: cert/key missing");
      expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      await state.cleanup();
    }
  });
});
