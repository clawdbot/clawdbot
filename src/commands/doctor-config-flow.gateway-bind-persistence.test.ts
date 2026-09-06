// Verifies Doctor persists legacy gateway bind repairs through the real config writer.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, readConfigFileSnapshot } from "../config/config.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import {
  planLegacyConfigForUpdateChannel,
  repairLegacyConfigForUpdateChannel,
} from "./doctor/legacy-config-repair.js";

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
        const includedBefore =
          scenario === "include" ? await fs.readFile(includePath, "utf8") : null;
        const snapshot = await readConfigFileSnapshot();
        const plan = planLegacyConfigForUpdateChannel(snapshot);
        expect(await fs.readFile(configPath, "utf8")).toBe(before);
        if (scenario === "include") {
          expect(await fs.readFile(includePath, "utf8")).toBe(includedBefore);
        }
        if (scenario === "invalid") {
          expect(plan).toBeUndefined();
        } else {
          expect(plan?.config.diagnostics?.otel).toEqual({
            enabled: false,
            endpoint: "http://collector.test:4317",
          });
        }
        const result = await repairLegacyConfigForUpdateChannel({
          configSnapshot: snapshot,
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

  it.each(["unchanged", "root edit", "include edit", "different profile"] as const)(
    "persists a prepared legacy plan only for its original source: %s",
    async (scenario) => {
      await withTempHome(async (home) => {
        await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const configPath = await writeOpenClawConfig(home, {
            gateway: { $include: "gateway.json" },
          });
          const includePath = path.join(path.dirname(configPath), "gateway.json");
          await fs.writeFile(includePath, '{"mode":"local","bind":"localhost"}\n');
          const { snapshot, writeOptions } = await createConfigIO({
            observe: false,
          }).readConfigFileSnapshotForWrite();
          const plan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
          expect(plan).toBeDefined();
          const original = await fs.readFile(configPath, "utf8");
          const originalInclude = await fs.readFile(includePath, "utf8");
          const persist = () =>
            repairLegacyConfigForUpdateChannel({
              configSnapshot: snapshot,
              plan,
              jsonMode: true,
            });
          // Planning is read-only; original authored bytes still exist at the seal boundary.
          expect(snapshot.raw).toBe(original);
          expect(await fs.readFile(includePath, "utf8")).toBe(originalInclude);
          if (scenario === "unchanged") {
            const result = await persist();
            expect(result.repaired).toBe(true);
            expect(result.snapshot.config.gateway?.bind).toBe("loopback");
            expect(await fs.readFile(configPath, "utf8")).toBe(original);
            expect(JSON.parse(await fs.readFile(includePath, "utf8")).bind).toBe("loopback");
          } else if (scenario === "different profile") {
            const otherPath = path.join(path.dirname(configPath), "other.json");
            await fs.writeFile(otherPath, original);
            await withEnvOverride({ OPENCLAW_CONFIG_PATH: otherPath }, async () => {
              await expect(persist()).rejects.toThrow(/config path changed/);
            });
            expect(await fs.readFile(otherPath, "utf8")).toBe(original);
            expect(await fs.readFile(configPath, "utf8")).toBe(original);
            expect(await fs.readFile(includePath, "utf8")).toBe(originalInclude);
          } else {
            const editedPath = scenario === "root edit" ? configPath : includePath;
            await fs.appendFile(editedPath, "\n");
            await expect(persist()).rejects.toThrow(/changed since last load/);
            expect(await fs.readFile(editedPath, "utf8")).toBe(
              (scenario === "root edit" ? original : originalInclude) + "\n",
            );
          }
        });
      });
    },
  );
});
