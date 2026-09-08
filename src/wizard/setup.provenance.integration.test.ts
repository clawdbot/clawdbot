// Real classic wizard prompts and config IO across agent preparation; host effects are synthetic.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resetConfigRuntimeState } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { WizardSelectParams } from "./prompts.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => ({ plugins: [], diagnostics: [] }),
}));
vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  loadPluginManifestRegistryForPluginRegistry: () => ({ plugins: [], diagnostics: [] }),
}));
vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
}));
vi.mock("./setup.shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup.shared.js")>();
  return {
    ...actual,
    writeWizardConfigFile: async (...args: Parameters<typeof actual.writeWizardConfigFile>) => {
      vi.stubEnv("CLASSIC_RESPONSE_PREFIX", "prefix-at-write");
      return await actual.writeWizardConfigFile(...args);
    },
  };
});
vi.mock("./setup.gateway-config.js", () => ({
  configureGatewayForSetup: async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
    vi.stubEnv("CLASSIC_RESPONSE_PREFIX", "prefix-during-ensure");
    return {
      nextConfig: { ...nextConfig, gateway: { ...nextConfig.gateway, mode: "local", port: 19001 } },
      settings: {
        port: 19001,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "fixture-token",
        tailscaleMode: "off",
      },
    };
  },
}));
vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources: async () => [],
  listSetupMigrationOptions: async () => [],
  runSetupMigrationImport: vi.fn(),
}));
vi.mock("./setup.memory-import.js", () => ({ runSetupMemoryImportStep: vi.fn() }));
vi.mock("./setup.finalize.js", () => ({
  finalizeSetupWizard: async () => ({ launchedTui: false }),
}));
vi.mock("../commands/onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-helpers.js")>()),
  printWizardHeader: vi.fn(),
  probeGatewayReachable: async () => ({ ok: false }),
  ensureWorkspaceAndSessions: vi.fn(),
}));

import { runSetupWizard } from "./setup.js";

const runtime = {
  log: vi.fn(),
  error: (message: unknown) => {
    throw new Error(String(message));
  },
  exit: (code: number) => {
    throw new Error(`Unexpected exit ${code}`);
  },
};

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

describe("classic setup matched config bases", () => {
  it.each(
    ["retained-roster", "rebased-roster", "new-roster", "fresh-config"].flatMap((state) =>
      [false, true].map((telemetry) => ({ state, telemetry })),
    ),
  )(
    "preserves consent and pending edits for $state (telemetry: $telemetry)",
    async ({ state, telemetry }) => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const workspace = path.join(home, "workspace");
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        vi.stubEnv("CLASSIC_RESPONSE_PREFIX", "prefix-before");
        await fs.mkdir(stateDir, { recursive: true });
        if (state !== "fresh-config") {
          const config: OpenClawConfig = {
            agents: {
              defaults: { workspace },
              ...(state === "retained-roster"
                ? { entries: { main: { workspace } } }
                : state === "rebased-roster"
                  ? { entries: { main: {} } }
                  : {}),
            },
            gateway: { mode: "local", port: 18789 },
            messages: { responsePrefix: "${CLASSIC_RESPONSE_PREFIX}" },
            plugins: { enabled: false },
          };
          await fs.writeFile(configPath, JSON.stringify(config));
        }
        resetConfigRuntimeState();
        const confirm = vi.fn(async () => true);
        const prompter = createWizardPrompter({
          confirm,
          select: async <T>(params: WizardSelectParams<T>): Promise<T> => {
            const choice = params.options.find((option) => option.value === telemetry);
            if (!choice) {
              throw new Error(`Unexpected selection: ${params.message}`);
            }
            return choice.value;
          },
        });
        await runSetupWizard(
          {
            flow: "quickstart",
            mode: "local",
            authChoice: "skip",
            agentName: "main",
            workspace,
            gatewayPort: 19001,
            installDaemon: false,
            skipChannels: true,
            skipSearch: true,
            skipSkills: true,
            skipHealth: true,
            skipHooks: true,
            skipUi: true,
          },
          runtime,
          prompter,
        );

        const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        expect.soft(saved.wizard?.securityAcknowledgedAt).toEqual(expect.any(String));
        expect
          .soft(saved.telemetry)
          .toEqual({ enabled: telemetry, consentedAt: expect.any(String) });
        expect.soft(saved.gateway?.port).toBe(19001);
        expect.soft(saved.agents?.defaults?.workspace).toBe(workspace);
        expect.soft(saved.agents?.entries).toHaveProperty("main");
        if (state !== "fresh-config") {
          expect.soft(saved.messages?.responsePrefix).toBe("${CLASSIC_RESPONSE_PREFIX}");
        } else {
          expect.soft(saved.messages?.responsePrefix).toBeUndefined();
        }
        expect.soft(saved.agents?.defaults).not.toHaveProperty("maxConcurrent");
        expect.soft(saved.agents?.defaults).not.toHaveProperty("compaction");
        expect(confirm).toHaveBeenCalledOnce();
      });
    },
  );
});
