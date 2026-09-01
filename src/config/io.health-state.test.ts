import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
} from "./io.health-state.js";
import { createConfigIO } from "./io.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function createHealthDeps(warn = vi.fn()) {
  const home = tempDirs.make("openclaw-health-warning-");
  return {
    env: { HOME: home, OPENCLAW_STATE_DIR: home },
    homedir: () => home,
    logger: { warn, error: vi.fn() },
  };
}

const healthState = {
  entries: { "/config.json": { lastObservedSuspiciousSignature: "observed" } },
};

describe("config health-state warnings", () => {
  it("deduplicates write failures across fresh sync and async config reads", async () => {
    const deps = createHealthDeps();
    const configPath = path.join(deps.env.HOME, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    openOpenClawStateDatabase(deps).db.exec("PRAGMA query_only = ON");

    for (let i = 0; i < 3; i++) {
      const options = {
        ...deps,
        configPath,
        env: { ...deps.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      };
      expect(createConfigIO(options).loadConfig().gateway?.mode).toBe("local");
      expect((await createConfigIO(options).readConfigFileSnapshot()).valid).toBe(true);
    }

    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("readonly database"),
    );
  });

  it("reports a newer database schema once across failed reads and writes", () => {
    const deps = createHealthDeps();
    const databasePath = resolveOpenClawStateSqlitePath(deps.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    db.close();

    for (let i = 0; i < 3; i++) {
      expect(readConfigHealthStateFromStore(deps)).toEqual({});
      writeConfigHealthStateToStore(deps, healthState);
    }
    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`),
    );
  });

  it("reports changed failures and re-arms only after a successful health write", () => {
    const deps = createHealthDeps();
    const { db } = openOpenClawStateDatabase(deps);
    db.exec("PRAGMA query_only = ON");
    writeConfigHealthStateToStore(deps, healthState);
    readConfigHealthStateFromStore(deps);
    writeConfigHealthStateToStore(deps, {});
    writeConfigHealthStateToStore(deps, healthState);
    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("readonly database"),
    );

    db.exec(`
      PRAGMA query_only = OFF;
      CREATE TRIGGER reject_health_write BEFORE INSERT ON config_health_entries
      BEGIN SELECT RAISE(FAIL, 'health write rejected'); END;
    `);
    writeConfigHealthStateToStore(deps, healthState);
    writeConfigHealthStateToStore(deps, healthState);
    expect(deps.logger.warn).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining("health write rejected"),
    );

    db.exec("PRAGMA query_only = ON");
    writeConfigHealthStateToStore(deps, healthState);
    expect(deps.logger.warn).toHaveBeenCalledTimes(3);
    expect(deps.logger.warn).toHaveBeenLastCalledWith(expect.stringContaining("readonly database"));

    db.exec("PRAGMA query_only = OFF; DROP TRIGGER reject_health_write");
    writeConfigHealthStateToStore(deps, healthState);
    expect(readConfigHealthStateFromStore(deps)).toEqual(healthState);
    db.exec("PRAGMA query_only = ON");
    writeConfigHealthStateToStore(deps, healthState);
    writeConfigHealthStateToStore(deps, healthState);
    expect(deps.logger.warn).toHaveBeenCalledTimes(4);
    expect(deps.logger.warn).toHaveBeenLastCalledWith(expect.stringContaining("readonly database"));
  });

  it("keeps identical failures independent for different state databases", () => {
    const warn = vi.fn();
    const stores = [createHealthDeps(warn), createHealthDeps(warn)] as const;
    for (const deps of stores) {
      openOpenClawStateDatabase(deps).db.exec("PRAGMA query_only = ON");
    }
    for (let i = 0; i < 2; i++) {
      for (const deps of stores) {
        writeConfigHealthStateToStore(deps, healthState);
      }
    }
    expect(warn).toHaveBeenCalledTimes(2);
    openOpenClawStateDatabase(stores[1]).db.exec("PRAGMA query_only = OFF");
    writeConfigHealthStateToStore(stores[1], healthState);
    writeConfigHealthStateToStore(stores[0], healthState);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
