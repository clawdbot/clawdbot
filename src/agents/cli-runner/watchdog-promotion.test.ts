import { afterEach, describe, expect, it } from "vitest";
import { resetFacadeLoaderStateForTest } from "../../plugin-sdk/facade-loader.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { resolveCliNoOutputTimeoutMs } from "./reliability.js";

type CliBackendSetupEntry = {
  default: {
    register(api: {
      registerCliBackend: (backend: CliBackendPlugin) => void;
      registerProvider: () => void;
    }): void;
  };
};

afterEach(() => {
  resetFacadeLoaderStateForTest();
});

async function loadRegisteredBackend(pluginId: string): Promise<CliBackendPlugin> {
  const setup = await loadBundledPluginFacade<CliBackendSetupEntry>({
    pluginId,
    artifactBasename: "setup-api.js",
  });
  let registeredBackend: CliBackendPlugin | undefined;
  setup.default.register({
    registerCliBackend(backend) {
      registeredBackend = backend;
    },
    registerProvider() {},
  });
  if (!registeredBackend) {
    throw new Error(`Plugin ${pluginId} did not register a CLI backend`);
  }
  return registeredBackend;
}

describe.each([
  { pluginId: "anthropic", backendId: "claude-cli" },
  { pluginId: "google", backendId: "google-gemini-cli" },
])("$backendId registered watchdog policy", ({ pluginId, backendId }) => {
  it.each([
    {
      scenario: "promotes resumed cron runs",
      trigger: "cron" as const,
      expectedTimeoutMs: 480_000,
    },
    {
      scenario: "promotes resumed runs with an explicit timeout",
      trigger: "user" as const,
      runTimeoutOverrideMs: 600_000,
      expectedTimeoutMs: 480_000,
    },
    {
      scenario: "keeps the ordinary resumed-run watchdog",
      trigger: "user" as const,
      expectedTimeoutMs: 180_000,
    },
  ])("$scenario", async ({ trigger, runTimeoutOverrideMs, expectedTimeoutMs }) => {
    const backend = await loadRegisteredBackend(pluginId);

    expect(backend.id).toBe(backendId);
    expect(
      resolveCliNoOutputTimeoutMs({
        backend: backend.config,
        timeoutMs: 600_000,
        useResume: true,
        trigger,
        runTimeoutOverrideMs,
      }),
    ).toBe(expectedTimeoutMs);
  });

  it("preserves an explicitly configured backend watchdog", async () => {
    const backend = await loadRegisteredBackend(pluginId);

    expect(
      resolveCliNoOutputTimeoutMs({
        backend: {
          ...backend.config,
          reliability: {
            watchdog: {
              resume: { noOutputTimeoutRatio: 0.2, minMs: 1_000, maxMs: 120_000 },
            },
          },
        },
        timeoutMs: 600_000,
        useResume: true,
        trigger: "cron",
      }),
    ).toBe(120_000);
  });
});
