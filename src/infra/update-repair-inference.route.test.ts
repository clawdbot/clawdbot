import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "../system-agent/inference-route.js";
import { selectUpdateRepairInference } from "./update-repair-inference.js";

const probe = vi.hoisted(() => vi.fn());

vi.mock("../plugins/cli-backends.runtime.js", () => ({
  resolveRuntimeCliBackends: () => [
    {
      id: "fixture-cli",
      modelProvider: "fixture",
      pluginId: "fixture",
      config: { command: "fixture-agent" },
    },
  ],
}));
vi.mock("../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreForRuntime: () => ({ version: 1, profiles: {} }),
}));
vi.mock("../agents/model-auth-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-auth-availability.js")>()),
  createModelAuthAvailabilityResolver: () => ({
    evaluateModelAuth: () => ({ availability: true }),
  }),
}));
vi.mock("../system-agent/setup-inference-test.js", () => ({ runSetupInferenceTest: probe }));
vi.mock("../system-agent/setup-inference-persist.js", () => ({
  cleanupSetupInferenceTempDir: async ({ tempDir }: { tempDir: string }) => {
    const fs = await import("node:fs/promises");
    await fs.rm(tempDir, { recursive: true, force: true });
  },
}));

const config: OpenClawConfig = {
  agents: {
    defaults: { systemAgent: { agentId: "owner" } },
    entries: {
      owner: {
        agentDir: "/isolated/owner",
        model: {
          primary: "fixture/primary@owner-profile",
          fallbacks: ["fixture/backup", "fixture/spare"],
        },
        models: { "fixture/primary": { agentRuntime: { id: "fixture-cli" } } },
      },
      other: { agentDir: "/isolated/other", model: "alpha/other" },
    },
  },
};

beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
  });
  probe.mockReset().mockResolvedValue({ ok: true, latencyMs: 1, text: "OK", auth: {} });
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("update repair logical routes", () => {
  it.each([false, true])(
    "preserves the logical primary before fallbacks when its CLI runtime differs (primary fails: %s)",
    async (primaryFails) => {
      const original = await resolveSystemAgentConfiguredRouteFromConfig(config, "owner");
      expect(original).toMatchObject({
        runner: "cli",
        provider: "fixture-cli",
        modelLabel: "fixture/primary",
        authProfileId: "owner-profile",
      });
      if (primaryFails) {
        probe.mockResolvedValueOnce({ ok: false, status: "format", error: "model unavailable" });
      }

      const selected = await selectUpdateRepairInference({
        config,
        runtime: { log() {}, error() {}, exit() {} },
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });

      expect(probe.mock.calls.map(([params]) => params.plan.modelRef)).toEqual(
        primaryFails ? ["fixture/primary", "fixture/backup"] : ["fixture/primary"],
      );
      expect(probe.mock.calls[0]?.[0].plan).toMatchObject({
        provider: "fixture",
        authProfileId: "owner-profile",
        agentDir: "/isolated/owner",
        agentHarnessRuntimeOverride: "openclaw",
      });
      expect(selected).toMatchObject({
        ok: true,
        route: {
          runner: "embedded",
          agentId: "owner",
          agentDir: "/isolated/owner",
          provider: "fixture",
          model: primaryFails ? "backup" : "primary",
        },
        modelFallbacks: primaryFails ? ["fixture/spare"] : ["fixture/backup", "fixture/spare"],
      });
    },
  );
});
