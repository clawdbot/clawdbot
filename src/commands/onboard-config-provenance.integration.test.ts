// Real config IO across setup prompts; package, auth, and host effects stay synthetic.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const controls = vi.hoisted(() => ({ mode: "remote", drift: () => {}, preEnsureDrift: () => {} }));

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
vi.mock("./onboard-non-interactive/config-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./onboard-non-interactive/config-write.js")>();
  return {
    commitNonInteractiveOnboardConfig: async (
      params: Parameters<typeof actual.commitNonInteractiveOnboardConfig>[0],
    ) => {
      controls.drift();
      return await actual.commitNonInteractiveOnboardConfig(params);
    },
  };
});
vi.mock("./onboard-non-interactive/local/auth-choice-inference.js", () => ({
  inferAuthChoiceFromFlags: () => {
    controls.preEnsureDrift();
    return { matches: [] };
  },
}));
vi.mock("../agents/agent-create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-create.js")>()),
  createAgent: async ({ entry }: { entry: { id: string; name: string; workspace: string } }) => {
    const { mutateConfigFileWithRetry } = await import("../config/config.js");
    const mutation = await mutateConfigFileWithRetry({
      mutate: (draft) => {
        draft.agents = {
          ...draft.agents,
          entries: { [entry.id]: { name: entry.name, workspace: entry.workspace } },
        };
      },
    });
    return {
      status: "created",
      agentId: entry.id,
      name: entry.name,
      workspace: entry.workspace,
      agentDir: path.join(entry.workspace, "agent"),
      bootstrapPending: true,
      configHash: mutation.persistedHash,
    };
  },
}));
vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: vi.fn(async () => ({ armed: false })),
}));
vi.mock("./onboard-agent-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-agent-target.js")>()),
  ensureOnboardingAgentWorkspace: vi.fn(async () => {}),
}));
vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  probeGatewayReachable: vi.fn(async () => ({ ok: false })),
  resolveAdvertisedControlUiLinks: vi.fn(async () => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  })),
}));
vi.mock("./configure.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./configure.shared.js")>()),
  intro: vi.fn(),
  outro: vi.fn(),
  select: vi.fn(async () => {
    controls.drift();
    return controls.mode;
  }),
}));
vi.mock("./onboard-remote.js", () => ({
  promptRemoteGatewayConfig: async (config: OpenClawConfig) => ({
    ...config,
    gateway: { ...config.gateway, mode: "remote", remote: { url: "wss://gateway.example.test" } },
  }),
}));
vi.mock("./configure.gateway.js", () => ({
  promptGatewayConfig: async (config: OpenClawConfig) => ({
    config: { ...config, gateway: { ...config.gateway, port: 19001 } },
    port: 19001,
  }),
}));

import { runConfigureWizard } from "./configure.wizard.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";

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
  controls.drift = () => {};
  controls.preEnsureDrift = () => {};
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

describe("setup config provenance", () => {
  it.each([
    "noninteractive-remote",
    "noninteractive-local",
    "configure-remote",
    "configure-local",
    "noninteractive-first-local",
    "noninteractive-legacy-local",
  ])("preserves authored environment references through %s", async (flow) => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const workspace = path.join(home, "workspace");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("SETUP_PROVENANCE_TOKEN", "synthetic-before");
      await fs.mkdir(stateDir, { recursive: true });
      const firstAgent = flow === "noninteractive-first-local";
      const legacyRoster = flow === "noninteractive-legacy-local";
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: { workspace },
            ...(firstAgent
              ? {}
              : { entries: legacyRoster ? { main: {} } : { ops: { workspace } } }),
          },
          gateway: { mode: "local", auth: { mode: "token", token: "${SETUP_PROVENANCE_TOKEN}" } },
        }),
      );
      resetConfigRuntimeState();
      const initial = await readConfigFileSnapshot();
      expect(initial.valid).toBe(true);
      expect(initial.sourceConfig.gateway?.auth?.token).toBe("synthetic-before");
      controls.drift = () => vi.stubEnv("SETUP_PROVENANCE_TOKEN", "synthetic-after");
      if (firstAgent || legacyRoster) {
        controls.preEnsureDrift = () =>
          vi.stubEnv("SETUP_PROVENANCE_TOKEN", "synthetic-during-ensure");
      }
      if (flow.startsWith("noninteractive")) {
        await runNonInteractiveSetup(
          {
            nonInteractive: true,
            mode: flow.endsWith("remote") ? "remote" : "local",
            remoteUrl: "wss://gateway.example.test",
            workspace,
            gatewayPort: 19001,
            ...(firstAgent || legacyRoster ? {} : { authChoice: "skip" }),
            agentName: firstAgent ? "main" : "ops",
            skipBootstrap: true,
            skipHooks: true,
            skipSkills: true,
            skipHealth: true,
            installDaemon: false,
          },
          runtime,
        );
      } else {
        controls.mode = flow.endsWith("remote") ? "remote" : "local";
        await runConfigureWizard({ command: "configure", sections: ["gateway"] }, runtime);
      }
      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persisted.gateway?.auth?.token).toBe("${SETUP_PROVENANCE_TOKEN}");
      expect(persisted.gateway?.mode).toBe(flow.endsWith("remote") ? "remote" : "local");
      if (flow.endsWith("local")) {
        expect(persisted.gateway?.port).toBe(19001);
      }
      if (!legacyRoster) {
        expect(persisted.agents?.entries?.[firstAgent ? "main" : "ops"]?.workspace).toBe(workspace);
      } else {
        expect(persisted.agents?.entries).toHaveProperty("main");
      }
      expect(persisted.agents?.defaults).toEqual({
        workspace,
        ...(flow.startsWith("noninteractive") ? { skipBootstrap: true } : {}),
      });
      const reloaded = await readConfigFileSnapshot();
      expect(reloaded.sourceConfig.gateway?.auth?.token).toBe("synthetic-after");
    });
  });
});
