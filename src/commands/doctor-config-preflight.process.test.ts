// Process regression for typed gateway startup-migration refusal and lease cleanup.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import {
  loadVoiceWakeRoutingConfig,
  setVoiceWakeRoutingConfig,
} from "../infra/voicewake-routing.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "../infra/voicewake.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const STARTUP_REFUSAL =
  "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.";

const instances: OpenClawTestInstance[] = [];

type GatewayReadiness = {
  ready: boolean;
  failing: string[];
};

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
});

function seedPluginStateConflict(stateDir: string): void {
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  const sidecarPath = path.join(stateDir, "plugin-state", "state.sqlite");
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

  const shared = new DatabaseSync(sharedPath);
  try {
    shared.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
    `);
    shared
      .prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run("discord", "components", "interaction:1", '{"ok":false}', 2_000, null);
  } finally {
    shared.close();
  }

  const sidecar = new DatabaseSync(sidecarPath);
  try {
    sidecar.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
    `);
    sidecar
      .prepare(`
        INSERT INTO plugin_state_entries (
          plugin_id, namespace, entry_key, value_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      // Older or equal sidecar rows can be archived; a newer divergent row must stay unresolved.
      .run("discord", "components", "interaction:1", '{"ok":true}', 3_000, null);
  } finally {
    sidecar.close();
  }
}

function closeCachedStateDatabase(instance: OpenClawTestInstance): void {
  closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(instance.env));
}

async function expectGatewayReady(instance: OpenClawTestInstance): Promise<void> {
  const url = `http://127.0.0.1:${instance.port}/readyz`;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const readiness = (await response.json()) as GatewayReadiness;
        expect(readiness).toMatchObject({ ready: true, failing: [] });
        return;
      }
    } catch {
      // The listener can open before startup readiness settles.
    }
    await delay(10);
  }
  throw new Error(`gateway did not become ready: ${instance.logs()}`);
}

async function expectMigratedVoiceWakeState(
  instance: OpenClawTestInstance,
  canonicalTriggers: string[],
  canonicalRouting: {
    defaultTarget: { mode: "current" };
    routes: Array<{ trigger: string; target: { agentId: string } }>;
  },
): Promise<void> {
  await expect(loadVoiceWakeConfig(instance.stateDir)).resolves.toMatchObject({
    triggers: canonicalTriggers,
  });
  await expect(loadVoiceWakeRoutingConfig(instance.stateDir)).resolves.toMatchObject(
    canonicalRouting,
  );

  const triggersPath = instance.state.statePath("settings", "voicewake.json");
  const routingPath = instance.state.statePath("settings", "voicewake-routing.json");
  await expect(fs.promises.access(triggersPath)).rejects.toThrow();
  await expect(fs.promises.access(routingPath)).rejects.toThrow();
  await expect(fs.promises.readFile(`${triggersPath}.migrated`, "utf8")).resolves.toContain(
    "legacy wake",
  );
  await expect(fs.promises.readFile(`${routingPath}.migrated`, "utf8")).resolves.toContain(
    "legacy route",
  );
  await expect(fs.promises.stat(`${triggersPath}.migrated`)).resolves.toSatisfy(
    (stat) => (stat.mode & 0o777) === 0o600,
  );
  await expect(fs.promises.stat(`${routingPath}.migrated`)).resolves.toSatisfy(
    (stat) => (stat.mode & 0o777) === 0o600,
  );
}

describe("gateway startup-migration refusal", () => {
  it("recovers Gateway readiness when SQLite state supersedes conflicting Voice Wake JSON", async () => {
    const instance = await createOpenClawTestInstance({
      name: "voicewake-migration-recovery",
      env: { OPENCLAW_TEST_FAST: "1" },
    });
    instances.push(instance);

    const canonicalTriggers = ["sqlite wake"];
    const canonicalRouting = {
      defaultTarget: { mode: "current" as const },
      routes: [{ trigger: "sqlite route", target: { agentId: "sqlite-agent" } }],
    };
    await setVoiceWakeTriggers(canonicalTriggers, instance.stateDir);
    await setVoiceWakeRoutingConfig(canonicalRouting, instance.stateDir);
    await instance.state.writeJson("settings/voicewake.json", { triggers: ["legacy wake"] });
    await instance.state.writeJson("settings/voicewake-routing.json", {
      defaultTarget: { agentId: "legacy-agent" },
      routes: [{ trigger: "legacy route", target: { agentId: "legacy-route-agent" } }],
    });
    closeCachedStateDatabase(instance);

    await instance.startGateway();
    await expectGatewayReady(instance);
    await expectMigratedVoiceWakeState(instance, canonicalTriggers, canonicalRouting);

    await instance.stopGateway();
    closeCachedStateDatabase(instance);

    await instance.startGateway();
    await expectGatewayReady(instance);
    await expectMigratedVoiceWakeState(instance, canonicalTriggers, canonicalRouting);
  }, 120_000);

  it("exits cleanly after reporting the refusal once and releasing its lease", async () => {
    const temporaryRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openclaw-startup-migration-exit-"),
    );
    const root = await fs.promises.realpath(temporaryRoot);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ gateway: { mode: "local", auth: { mode: "none" } } }),
      );
      seedPluginStateConflict(stateDir);

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", path.resolve("src/entry.ts"), "gateway", "run", "--allow-unconfigured"],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env,
          timeout: 30_000,
        },
      );
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      expect(result.signal, output).toBeNull();
      expect(result.stderr).toContain(STARTUP_REFUSAL);
      expect(result.stderr.split(STARTUP_REFUSAL)).toHaveLength(2);
      expect(result.stderr).not.toContain("[openclaw] Could not start the CLI.");
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
