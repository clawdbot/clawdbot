// Covers best-effort config IO reads and warning behavior.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  readBestEffortConfig,
  readBestEffortConfigSnapshot,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
} from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

function readConfigHealthRow(env: NodeJS.ProcessEnv, configPath: string) {
  const { db } = openOpenClawStateDatabase({ env });
  const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    healthDb
      .selectFrom("config_health_entries")
      .select(["config_path", "last_known_good_json"])
      .where("config_path", "=", configPath),
  );
}

describe("readBestEffortConfig", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("can read snapshots without updating config observation state", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
      });

      await readConfigFileSnapshot({ observe: false });

      const healthPath = `${home}/.openclaw/logs/config-health.json`;
      await expect(fs.stat(healthPath)).rejects.toMatchObject({ code: "ENOENT" });

      await readConfigFileSnapshot();

      await expect(fs.stat(healthPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(readConfigHealthRow({ ...process.env, HOME: home }, configPath)).toMatchObject({
        config_path: configPath,
        last_known_good_json: expect.any(String),
      });
    });
  });

  it("can read snapshots without applying config env vars to the process", async () => {
    await withTempHome(async (home) => {
      const key = "OPENCLAW_ISOLATED_CONFIG_READ_TEST";
      await withEnvAsync({ [key]: undefined }, async () => {
        await writeOpenClawConfig(home, {
          env: { vars: { [key]: "from-config" } },
          gateway: { mode: "local" },
        });

        await readConfigFileSnapshot({ isolateEnv: true, observe: false });

        expect(process.env[key]).toBeUndefined();
      });
    });
  });

  it("resolves config env above exact lower-precedence values in isolated snapshots", async () => {
    await withTempHome(async (home) => {
      const key = "OPENCLAW_GATEWAY_TOKEN";
      await withEnvAsync({ [key]: "shell-token" }, async () => {
        await writeOpenClawConfig(home, {
          env: { vars: { [key]: "config-token" } },
          gateway: { auth: { mode: "token", token: `\${${key}}` }, mode: "local" },
        });

        const snapshot = await readConfigFileSnapshot({
          isolateEnv: true,
          lowerPrecedenceEnv: { [key]: "shell-token" },
          observe: false,
        });

        expect(snapshot.config.gateway?.auth?.token).toBe("config-token");
        expect(process.env[key]).toBe("shell-token");
      });
    });
  });

  it("resolves config env above normalized lower-precedence aliases in isolated snapshots", async () => {
    await withTempHome(async (home) => {
      await withEnvAsync({ ZAI_API_KEY: "shell-token", Z_AI_API_KEY: undefined }, async () => {
        await writeOpenClawConfig(home, {
          env: { vars: { Z_AI_API_KEY: "config-token" } },
          gateway: { auth: { mode: "token", token: "${ZAI_API_KEY}" }, mode: "local" },
        });

        const snapshot = await readConfigFileSnapshot({
          isolateEnv: true,
          lowerPrecedenceEnv: { ZAI_API_KEY: "shell-token" },
          observe: false,
        });

        expect(snapshot.config.gateway?.auth?.token).toBe("config-token");
        expect(process.env.ZAI_API_KEY).toBe("shell-token");
        expect(process.env.Z_AI_API_KEY).toBeUndefined();
      });
    });
  });

  it("resolves config aliases from a higher-precedence canonical value in isolated snapshots", async () => {
    await withTempHome(async (home) => {
      await withEnvAsync({ ZAI_API_KEY: "invocation-token", Z_AI_API_KEY: undefined }, async () => {
        await writeOpenClawConfig(home, {
          env: { vars: { Z_AI_API_KEY: "config-token" } },
          gateway: { auth: { mode: "token", token: "${Z_AI_API_KEY}" }, mode: "local" },
        });

        const snapshot = await readConfigFileSnapshot({
          isolateEnv: true,
          observe: false,
        });

        expect(snapshot.config.gateway?.auth?.token).toBe("invocation-token");
        expect(process.env.ZAI_API_KEY).toBe("invocation-token");
        expect(process.env.Z_AI_API_KEY).toBeUndefined();
      });
    });
  });

  it("can read best-effort config without applying env vars or recording observation", async () => {
    await withTempHome(async (home) => {
      const key = "OPENCLAW_ISOLATED_BEST_EFFORT_CONFIG_TEST";
      await withEnvAsync({ [key]: undefined }, async () => {
        await writeOpenClawConfig(home, {
          env: { vars: { [key]: "from-config" } },
          gateway: { mode: "local" },
        });

        const config = await readBestEffortConfig({ isolateEnv: true, observe: false });

        expect(config.gateway?.mode).toBe("local");
        expect(process.env[key]).toBeUndefined();
        await expect(fs.stat(`${home}/.openclaw/logs/config-health.json`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    });
  });

  it("preserves Windows case-insensitive env lookup in isolated reads", async () => {
    await withTempHome(async (home) => {
      const mixedCaseKey = "OpenClaw_Config_Path";
      const customConfigPath = `${home}/custom-openclaw.json`;
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: undefined }, async () => {
        await withEnvAsync({ [mixedCaseKey]: customConfigPath }, async () => {
          const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
          try {
            await fs.writeFile(
              customConfigPath,
              `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`,
              "utf-8",
            );

            const snapshot = await readConfigFileSnapshot({ isolateEnv: true, observe: false });

            expect(snapshot.exists).toBe(true);
            expect(snapshot.path).toBe(customConfigPath);
          } finally {
            platformSpy.mockRestore();
          }
        });
      });
    });
  });

  it("does not restore suspicious direct edits from .bak during ordinary reads", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        meta: { lastTouchedAt: "2026-04-22T00:00:00.000Z" },
        update: { channel: "beta" },
        gateway: { mode: "local" },
      });
      await fs.copyFile(configPath, `${configPath}.bak`);
      const directEditRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fs.writeFile(configPath, directEditRaw, "utf-8");

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig).toEqual({ update: { channel: "beta" } });
      expect(await fs.readFile(configPath, "utf-8")).toBe(directEditRaw);
      const entries = await fs.readdir(`${home}/.openclaw`);
      expect(entries.some((entry) => entry.startsWith("openclaw.json.clobbered."))).toBe(false);
    });
  });

  it("reuses valid snapshots while preserving load-time defaults", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      });

      const snapshot = await readConfigFileSnapshot();
      const bestEffort = await readBestEffortConfig();

      expect(snapshot.config.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBeUndefined();

      expect(bestEffort.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
      expect(bestEffort.agents?.defaults?.contextPruning?.ttl).toBe("1h");
      expect(bestEffort.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(
        bestEffort.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
      ).toBe("short");
    });
  });

  it("controls observation while returning source and materialized config", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      });
      const configRaw = await fs.readFile(configPath, "utf-8");

      const snapshot = await readBestEffortConfigSnapshot({ observe: false });

      expect(snapshot.sourceConfig.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      expect(snapshot.config.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
      expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(configRaw);
      expect(readConfigHealthRow({ ...process.env, HOME: home }, configPath)).toBeUndefined();

      await readBestEffortConfigSnapshot();

      expect(readConfigHealthRow({ ...process.env, HOME: home }, configPath)).toMatchObject({
        config_path: configPath,
        last_known_good_json: expect.any(String),
      });
    });
  });
});

describe("readSourceConfigBestEffort", () => {
  it("preserves the authored source config without load-time defaults", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
      });

      const snapshot = await readConfigFileSnapshot();
      const sourceBestEffort = await readSourceConfigBestEffort();

      expect(sourceBestEffort).toEqual(snapshot.resolved);
      expect(sourceBestEffort.agents?.defaults?.contextPruning?.mode).toBeUndefined();
      expect(sourceBestEffort.agents?.defaults?.compaction?.mode).toBeUndefined();
    });
  });
});
