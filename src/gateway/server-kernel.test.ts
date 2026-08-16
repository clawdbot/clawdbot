import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createGatewayKernel } from "./server-kernel.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

describe("createGatewayKernel", () => {
  it("keeps readiness red until deferred startup unlocks chat dispatch", async () => {
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
      const failingSidecar = vi.fn(async () => {
        throw cleanupError;
      });
      const trailingSidecar = vi.fn(async () => {});
      kernel.kernel.setGatewayLifetimeSidecars([
        { stop: failingSidecar },
        { stop: trailingSidecar },
      ]);

      await expect(kernel.stopRegisteredGatewayLifetimeSidecars()).rejects.toBe(cleanupError);
      expect(failingSidecar).toHaveBeenCalledOnce();
      expect(trailingSidecar).toHaveBeenCalledOnce();
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
        "plugins.metadata.scan",
        "plugins.metadata.freeze",
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
        "startup.maintenance",
        "plugins.bootstrap",
        "plugins.metadata.scan",
        "plugins.metadata.freeze",
        "runtime.config",
        "control-ui.root",
        "tls.runtime",
        "runtime.state",
        "runtime.early",
        "runtime.early.discovery",
        "runtime.post-early-imports",
        "runtime.subscriptions",
        "runtime.services",
        "gateway.handlers",
        "gateway.request-context",
      ]);
    } finally {
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        try {
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
