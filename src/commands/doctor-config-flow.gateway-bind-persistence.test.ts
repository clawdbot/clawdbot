// Verifies Doctor persists legacy gateway bind repairs through the real config writer.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";

describe("Doctor gateway bind persistence", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    ["localhost", "loopback"],
    ["0.0.0.0", "lan"],
  ] as const)("persists gateway bind %s as %s", async (legacyBind, canonicalBind) => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        // This core writer regression needs the authoritative empty bundled-plugin inventory.
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local", bind: legacyBind },
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

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.gateway?.bind).toBe(canonicalBind);
        expect(await fs.readFile(configPath, "utf-8")).not.toContain(`"bind": "${legacyBind}"`);
      });
    });
  });
});
