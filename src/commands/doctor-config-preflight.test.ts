// Doctor config preflight tests cover last-known-good snapshots and config snapshot promotion.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCliProfileEnv } from "../cli/profile.js";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  runDoctorConfigPreflight,
  shouldSkipPluginValidationForDoctorConfigPreflight,
} from "./doctor-config-preflight.js";

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

function readConfigHealthRow(env: NodeJS.ProcessEnv, configPath: string) {
  const { db } = openOpenClawStateDatabase({ env });
  const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    healthDb
      .selectFrom("config_health_entries")
      .select("config_path")
      .where("config_path", "=", configPath),
  );
}

async function writeLegacyConfig(home: string): Promise<string> {
  const legacyPath = path.join(home, ".clawdbot", "clawdbot.json");
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, '{"gateway":{"mode":"local"}}\n', "utf-8");
  return legacyPath;
}

describe("runDoctorConfigPreflight", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("supports non-observing config reads", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, { gateway: { mode: "local" } });

      await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
      });

      expect(readConfigHealthRow({ ...process.env, HOME: home }, configPath)).toBeUndefined();
    });
  });

  it("migrates legacy config into the active state directory", async () => {
    await withTempHome(async (home) => {
      await writeLegacyConfig(home);
      const stateDir = await fs.realpath(await fs.mkdtemp(path.join(home, "custom-state-")));
      const configPath = path.join(stateDir, "openclaw.json");
      const defaultConfigPath = path.join(home, ".openclaw", "openclaw.json");

      await withEnvOverride(
        {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const preflight = await runDoctorConfigPreflight({
            migrateState: false,
            invalidConfigNote: false,
          });

          expect(preflight.snapshot.path).toBe(configPath);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
          await expect(fs.access(defaultConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    });
  });

  it("migrates legacy config into an explicit config path", async () => {
    await withTempHome(async (home) => {
      await writeLegacyConfig(home);
      const configRoot = await fs.realpath(await fs.mkdtemp(path.join(home, "custom-config-")));
      const configPath = path.join(configRoot, "nested", "custom-openclaw.json");

      await withEnvOverride(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          const preflight = await runDoctorConfigPreflight({
            migrateState: false,
            invalidConfigNote: false,
          });

          expect(preflight.snapshot.path).toBe(configPath);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
        },
      );
    });
  });

  it("migrates legacy config into the selected profile", async () => {
    await withTempHome(async (home) => {
      await writeLegacyConfig(home);
      const profileStateDir = path.join(home, ".openclaw-work");
      const configPath = path.join(profileStateDir, "openclaw.json");

      await withEnvOverride(
        {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          applyCliProfileEnv({ profile: "work", homedir: () => home });
          const preflight = await runDoctorConfigPreflight({
            migrateState: false,
            invalidConfigNote: false,
          });

          expect(preflight.snapshot.path).toBe(configPath);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
        },
      );
    });
  });

  it("skips plugin schema validation while doctor is running inside update", () => {
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("collects legacy config issues outside the normal config read path", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        memorySearch: {
          provider: "local",
          fallback: "none",
        },
      });

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.valid).toBe(false);
      expect(preflight.snapshot.legacyIssues.map((issue) => issue.path)).toContain("memorySearch");
      const memorySearch = (
        preflight.baseConfig as {
          memorySearch?: { provider?: unknown; fallback?: unknown };
        }
      ).memorySearch;
      expect(memorySearch?.provider).toBe("local");
      expect(memorySearch?.fallback).toBe("none");
    });
  });

  it("restores invalid config from last-known-good only during repair preflight", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(configPath, "{ invalid json", "utf-8");

      const inspectOnly = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
      expect(inspectOnly.snapshot.valid).toBe(false);

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.mode).toBe("local");
      expect(await fs.readFile(configPath, "utf-8")).toBe(lastGoodRaw);
    });
  });

  it("preserves and rejects unparseable config without last-known-good during repair preflight", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const brokenRaw = '{ "gateway": { "mode": "local" }, "models": {';
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, brokenRaw, "utf-8");

      const failure = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Config could not be parsed or recovered.");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(brokenRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      const clobbered = entries.filter((entry) => entry.startsWith("openclaw.json.clobbered."));
      expect(clobbered).toHaveLength(1);
      const clobberedPath = path.join(path.dirname(configPath), clobbered[0] ?? "missing");
      expect((failure as Error).message).toContain(`Original preserved at ${clobberedPath}.`);
      await expect(fs.readFile(clobberedPath, "utf-8")).resolves.toBe(brokenRaw);
    });
  });

  it("does not restore last-known-good for stale plugins.deny entries", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const currentConfig = {
        gateway: { mode: "local", port: 19092 },
        plugins: { deny: ["missing-deny"] },
      };
      await fs.writeFile(configPath, `${JSON.stringify(currentConfig, null, 2)}\n`, "utf-8");

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config.plugins?.deny).toEqual(["missing-deny"]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"missing-deny"');
    });
  });

  it("restores last-known-good for malformed plugin policy values", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19092 }, plugins: { deny: "bad" } }, null, 2)}\n`,
        "utf-8",
      );

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19091);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(lastGoodRaw);
    });
  });
});
