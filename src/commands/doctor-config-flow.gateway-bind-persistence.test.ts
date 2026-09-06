// Verifies Doctor persists legacy gateway bind repairs through the real config writer.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
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
        const ctx = await prepareDoctorContext(configPath);

        await runInitialConfigWriteHealth(ctx);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.gateway?.bind).toBe(canonicalBind);
        expect(await fs.readFile(configPath, "utf-8")).not.toContain(`"bind": "${legacyBind}"`);
      });
    });
  });

  it.each(["ordinary", "include", "invalid"] as const)(
    "preserves authored plugin scope during %s update-channel repair",
    async (scenario) => {
      await withTempHome(async (home) => {
        const diagnostics = {
          otel: { enabled: true, endpoint: "http://collector.test:4317", protocol: "grpc" },
        };
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local", ...(scenario === "invalid" ? { port: "invalid" } : {}) },
          diagnostics: scenario === "include" ? { $include: "diagnostics.json" } : diagnostics,
          plugins: { entries: { canvas: { enabled: true, config: { host: { enabled: false } } } } },
        });
        const includePath = path.join(path.dirname(configPath), "diagnostics.json");
        if (scenario === "include") {
          await fs.writeFile(includePath, JSON.stringify(diagnostics));
        }
        const before = await fs.readFile(configPath, "utf8");
        const result = await repairLegacyConfigForUpdateChannel({
          configSnapshot: await readConfigFileSnapshot(),
          jsonMode: true,
        });
        if (scenario === "invalid") {
          expect(result.repaired).toBe(false);
          expect(await fs.readFile(configPath, "utf8")).toBe(before);
          return;
        }
        expect(result.repaired).toBe(true);
        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(Object.keys(saved.plugins.entries)).toEqual(["canvas"]);
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
