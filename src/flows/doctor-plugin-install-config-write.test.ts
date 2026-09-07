import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorConfigSnapshot } from "../commands/doctor-config-snapshot.test-helpers.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store.js";
import { runWriteConfigHealth } from "./doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const mocks = vi.hoisted(() => ({
  lockedSnapshot: vi.fn<() => ConfigFileSnapshot>(),
  write: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  transformConfigFile: async ({
    transform,
  }: Parameters<typeof import("../config/config.js").transformConfigFile>[0]) => {
    const snapshot = mocks.lockedSnapshot();
    const next = await transform(
      snapshot.sourceConfig,
      { snapshot, previousHash: snapshot.hash ?? null, attempt: 0 },
      {},
    );
    return mocks.write(next);
  },
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (config: unknown) => config,
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated() {},
}));

vi.mock("../commands/doctor/shared/config-flow-steps.js", () => ({
  restoreDoctorConfigEnvRefs: (config: unknown) => config,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Doctor install-source write ownership", () => {
  it.each(["root", "include"] as const)(
    "refuses %s source records added before the locked write snapshot",
    async (source) => {
      const initialConfig = { plugins: { installs: {} } };
      const changedConfig = {
        plugins: { installs: { added: { source: "path" as const, installPath: "/new-plugin" } } },
      };
      const parsed =
        source === "include" ? { plugins: { $include: "./plugins.json" } } : initialConfig;
      const initial = {
        ...createDoctorConfigSnapshot({ config: initialConfig, parsed }),
        hash: "accepted-root",
      };
      const changed = {
        ...createDoctorConfigSnapshot({ config: changedConfig, parsed }),
        hash: source === "include" ? initial.hash : "changed-root",
      };
      mocks.lockedSnapshot.mockReturnValue(changed);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const options = { repair: true, nonInteractive: true };
      const cfg = { plugins: {} };
      const ctx: DoctorHealthFlowContext = {
        runtime,
        options,
        prompter: createDoctorPrompter({ runtime, options }),
        configResult: {
          cfg,
          shouldWriteConfig: true,
          pluginInstallConfigImport: {
            source: { path: initial.path, hash: initial.hash, sourceConfig: initial.sourceConfig },
            databasePath: resolveInstalledPluginIndexStorePath(),
            pluginInventoryChanged: false,
          },
        },
        cfg,
        cfgForPersistence: initialConfig,
        sourceConfigValid: false,
        configPath: initial.path,
      };

      await expect(runWriteConfigHealth(ctx)).rejects.toThrow(
        "config changed after plugin install migration",
      );
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );
});
