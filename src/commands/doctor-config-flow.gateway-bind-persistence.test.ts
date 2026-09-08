// Verifies Doctor persists legacy gateway bind repairs through the real config writer.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../config/config.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { repairLegacyConfigForUpdateChannel } from "./doctor/legacy-config-repair.js";

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
        expect((await readConfigFileSnapshot()).sourceConfig.commands).toBeUndefined();
        const ctx = await prepareDoctorContext(configPath);

        await runInitialConfigWriteHealth(ctx);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.gateway?.bind).toBe(canonicalBind);
        const saved = await fs.readFile(configPath, "utf-8");
        expect(saved).not.toContain(`"bind": "${legacyBind}"`);
        expect(JSON.parse(saved)).not.toHaveProperty("commands");
      });
    });
  });

  it.each(["ordinary", "include", "invalid", "doctor"] as const)(
    "preserves authored plugin scope during %s config repair",
    async (scenario) => {
      await withTempHome(async (home) => {
        const diagnostics = {
          otel: { enabled: true, endpoint: "http://collector.test:4317", protocol: "grpc" },
        };
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local", ...(scenario === "invalid" ? { port: "invalid" } : {}) },
          diagnostics: scenario === "include" ? { $include: "diagnostics.json" } : diagnostics,
          plugins: { entries: { canvas: { enabled: true, config: { host: { enabled: false } } } } },
          ...(scenario === "doctor" ? { agents: { defaults: { models: { bare: {} } } } } : {}),
        });
        const includePath = path.join(path.dirname(configPath), "diagnostics.json");
        if (scenario === "include") {
          await fs.writeFile(includePath, JSON.stringify(diagnostics));
        }
        const before = await fs.readFile(configPath, "utf8");
        const prepared = await readConfigFileSnapshotForWrite();
        expect(prepared.snapshot.sourceConfig.commands).toBeUndefined();
        let result: Awaited<ReturnType<typeof repairLegacyConfigForUpdateChannel>>;
        if (scenario === "doctor") {
          const ctx = await prepareDoctorContext(configPath);
          // Deferred model advice leaves the actual migration to Doctor's config flow.
          expect(await fs.readFile(configPath, "utf8")).toBe(before);
          expect(ctx.configResult.shouldWriteConfig).toBe(true);
          await runInitialConfigWriteHealth(ctx);
          result = {
            snapshot: await readConfigFileSnapshot(),
            repaired: ctx.configResultWriteCommitted === true,
          };
        } else {
          result = await repairLegacyConfigForUpdateChannel({
            configSnapshot: prepared.snapshot,
            configWriteOptions: prepared.writeOptions,
            jsonMode: true,
          });
        }
        if (scenario === "invalid") {
          expect(result.repaired).toBe(false);
          expect(await fs.readFile(configPath, "utf8")).toBe(before);
          return;
        }
        expect(result.repaired).toBe(true);
        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(Object.keys(saved.plugins.entries)).toEqual(["canvas"]);
        if (scenario === "doctor") {
          expect(saved.agents.defaults.models).toStrictEqual({ bare: {} });
        }
        expect(saved).not.toHaveProperty("commands");
        expect(result.snapshot.config.diagnostics?.otel).toEqual({
          enabled: false,
          endpoint: "http://collector.test:4317",
        });
        if (scenario === "include") {
          expect(saved.diagnostics).toEqual({ $include: "diagnostics.json" });
          expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({
            otel: { enabled: false, endpoint: "http://collector.test:4317" },
          });
        }
      });
    },
  );
});
