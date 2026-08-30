// Minimal-gateway boot smoke: guards the startup path the Control UI e2e suites
// depend on. Bundled plugins stay enabled on purpose — disabling them (as other
// gateway boot tests do) hides startup work that materializes plugin runtime,
// which is exactly how a startup stall shipped green while hanging every
// ui-e2e suite that boots a minimal test gateway.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfigSnapshot, resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { readLoggingConfig } from "../logging/config.js";
import { resetLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { installPluginMetadataOwner } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import {
  createPluginMetadataOwner,
  getCurrentPluginMetadataOwner,
} from "../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";

// Local boot completes in ~10s; the budget only buys headroom for loaded CI
// runners. A stall exhausts it and fails in the gateway lane instead of first
// surfacing on unrelated UI PRs.
const BOOT_BUDGET_MS = 90_000;

afterEach(() => {
  resetLogger();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  clearPluginMetadataLifecycleCaches();
});

describe("gateway minimal boot smoke", () => {
  it("releases the metadata owner when config validation rejects startup", async () => {
    const state = await createOpenClawTestState({
      label: "gateway-metadata-startup-failure",
      layout: "home",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        VITEST: "1",
      },
    });
    await state.writeConfig({ gateway: { mode: "invalid" } });
    state.applyEnv();
    try {
      const { createGatewayKernel } = await import("./server-kernel.js");
      await expect(createGatewayKernel(await getFreePort())).rejects.toThrow("Invalid config");
      expect(getCurrentPluginMetadataOwner()).toBeUndefined();
    } finally {
      await state.cleanup();
    }
  });

  it("suppresses ambient channel triggers when the server option is omitted", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-bootstrap-ambient-default",
      layout: "home",
      env: {
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
    const token = "gateway-bootstrap-test-token";
    await state.writeConfig({
      gateway: { auth: { mode: "token", token } },
      logging: { level: "debug" },
      plugins: {},
    });
    state.applyEnv();
    const pluginCache = createPluginCache();
    const pluginMetadataOwner = createPluginMetadataOwner(pluginCache);
    const disposePluginMetadataOwner = installPluginMetadataOwner(pluginMetadataOwner, pluginCache);

    try {
      const { prepareGatewayServerBootstrap } = await import("./server-startup-bootstrap.js");
      const log = createSubsystemLogger("gateway/bootstrap-test");
      const bootstrap = await prepareGatewayServerBootstrap({
        port,
        opts: {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        },
        log,
        logSecrets: log,
        loadWorkerEnvironmentStartupModule: async () =>
          await import("./server-worker-environment-startup.js"),
        formatRuntimeGatewayAuthTokenWarning: () => "unused",
        pluginMetadataOwner,
      });

      expect(bootstrap.ambientEnvTriggers).toBe("suppress");
      vi.stubEnv(
        "OPENCLAW_CONFIG_PATH",
        `/tmp/openclaw-bootstrap-missing-${process.pid}-${Date.now()}.json`,
      );
      expect(readLoggingConfig()).toMatchObject({ level: "debug" });
    } finally {
      disposePluginMetadataOwner();
      await state.cleanup();
    }
  });

  it(
    "carries auto-enabled plugin metadata through startup model selection",
    { timeout: BOOT_BUDGET_MS },
    async () => {
      const state = await createOpenClawTestState({
        label: "gateway-startup-metadata-handoff",
        layout: "home",
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: "1",
        },
      });
      const token = "gateway-startup-metadata-handoff-token";
      await state.writeConfig({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          entries: { main: { default: true } },
        },
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false } },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              apiKey: "fixture-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
            },
          },
        },
        plugins: { enabled: true },
      });
      state.applyEnv();
      const pluginCache = createPluginCache();
      const pluginMetadataOwner = createPluginMetadataOwner(pluginCache);
      const disposePluginMetadataOwner = installPluginMetadataOwner(
        pluginMetadataOwner,
        pluginCache,
      );
      const log = createSubsystemLogger("gateway/startup-metadata-test");
      try {
        const { prepareGatewayServerBootstrap } = await import("./server-startup-bootstrap.js");
        const bootstrap = await prepareGatewayServerBootstrap({
          port: await getFreePort(),
          opts: {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          },
          log,
          logSecrets: log,
          loadWorkerEnvironmentStartupModule: async () =>
            await import("./server-worker-environment-startup.js"),
          formatRuntimeGatewayAuthTokenWarning: () => "unused",
          pluginMetadataOwner,
        });

        expect(getRuntimeConfigSnapshot()).toBe(bootstrap.cfgAtStart);
        const { resolveConfiguredModelRef } = await import("../agents/model-selection.js");
        expect(
          resolveConfiguredModelRef({
            cfg: bootstrap.cfgAtStart,
            defaultProvider: "openai",
            defaultModel: "fallback",
          }),
        ).toEqual({ provider: "openai", model: "gpt-5.5" });
      } finally {
        disposePluginMetadataOwner();
        await state.cleanup();
      }
    },
  );

  it("boots a minimal test gateway within budget", { timeout: BOOT_BUDGET_MS }, async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-minimal-boot-smoke",
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
    const token = "gateway-minimal-boot-smoke-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
      },
    });
    state.applyEnv();
    try {
      const { startGatewayServer } = await import("./server.js");
      const server = await startGatewayServer(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      expect(server).toBeTruthy();
      expect(getCurrentPluginMetadataOwner()?.getActive()).toBeDefined();
      await server.close({ reason: "minimal boot smoke complete" });
      expect(getCurrentPluginMetadataOwner()).toBeUndefined();
    } finally {
      await state.cleanup();
    }
  });
});
