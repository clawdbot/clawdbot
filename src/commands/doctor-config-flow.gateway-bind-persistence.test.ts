// Verifies Doctor persists legacy gateway bind repairs through the real config writer.
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";
import { migrateLegacyConfig } from "./doctor/shared/legacy-config-migrate.js";

describe("Doctor gateway bind persistence", () => {
  it.each([
    ["localhost", "loopback"],
    ["0.0.0.0", "lan"],
  ] as const)("persists gateway bind %s as %s", async (legacyBind, canonicalBind) => {
    await withTempHome(async (home) => {
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
      const migration = migrateLegacyConfig({ gateway: { mode: "local", bind: legacyBind } });
      expect(migration.config).not.toBeNull();
      const cfg = migration.config!;
      const configResult = { cfg, shouldWriteConfig: true };
      const ctx: DoctorHealthFlowContext = {
        runtime,
        options,
        prompter,
        configResult,
        cfg,
        cfgForPersistence: structuredClone(cfg),
        sourceConfigValid: true,
        configPath,
        stateDirExistedAtStart: true,
      };

      await runInitialConfigWriteHealth(ctx);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(persisted.gateway?.bind).toBe(canonicalBind);
      expect(persisted.gateway?.bind).not.toBe(legacyBind);
    });
  });
});
