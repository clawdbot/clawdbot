import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";

describe("Doctor workspace persistence", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("keeps the legacy owner on the shared workspace across later health writes", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const workspace = path.join(home, "shared-workspace");
        const configPath = await writeOpenClawConfig(home, {
          agents: {
            defaults: { workspace },
            entries: {
              main: { default: true },
              cursor: { workspace },
            },
          },
          gateway: { mode: "local" },
        });
        const runtime: RuntimeEnv = {
          error: vi.fn(),
          exit: vi.fn(),
          log: vi.fn(),
        };
        const options: DoctorOptions = { nonInteractive: true, repair: true };
        const prompter = createDoctorPrompter({ runtime, options });
        const configResult = await loadAndMaybeMigrateDoctorConfig({
          options,
          confirm: (params) => prompter.confirm(params),
          runtime,
          prompter,
        });
        const ctx: DoctorHealthFlowContext = {
          runtime,
          options,
          prompter,
          configResult,
          cfg: configResult.cfg,
          cfgForPersistence: structuredClone(configResult.cfg),
          sourceConfigValid: configResult.sourceConfigValid ?? true,
          configPath,
          stateDirExistedAtStart: true,
          ...(configResult.runWithPluginMetadataSnapshot
            ? { runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot }
            : {}),
          ...(configResult.invalidatePluginMetadataSnapshot
            ? { invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot }
            : {}),
        };

        await runInitialConfigWriteHealth(ctx);
        expect((await readConfigFileSnapshot()).config.agents?.entries?.main?.workspace).toBe(
          workspace,
        );

        ctx.cfg = {
          ...ctx.cfg,
          gateway: { ...ctx.cfg.gateway, bind: "lan" },
        };
        await runWriteConfigHealth(ctx);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.agents?.ownership).toBe("explicit");
        expect(snapshot.config.agents?.entries?.main?.workspace).toBe(workspace);
      });
    });
  });
});
