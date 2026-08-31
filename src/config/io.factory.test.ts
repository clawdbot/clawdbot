import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";

describe("config factory writer boundary", () => {
  const roots = createSuiteTempRootTracker({ prefix: "openclaw-config-factory-" });
  beforeAll(() => roots.setup());
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    vi.doUnmock("./io.write.js");
    const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
    closeOpenClawStateDatabaseForTest();
  });
  afterAll(() => roots.cleanup());

  async function fixture() {
    const home = await roots.make();
    const configPath = path.join(home, "openclaw.json");
    const raw = JSON.stringify({ gateway: { mode: "local", port: 18789 } });
    await fs.writeFile(configPath, raw);
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      NODE_ENV: "test",
      OPENCLAW_CONFIG_PATH: configPath,
    };
    const { createConfigIO } = await import("./io.factory.js");
    const io = createConfigIO({
      env,
      homedir: () => home,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    return { io, env, home, configPath, raw };
  }

  it("reads and records normal observation without importing the writer", async () => {
    const loadWriter = vi.fn(() => {
      throw new Error("read imported the config writer");
    });
    vi.doMock("./io.write.js", loadWriter);
    const { io, env, configPath, raw } = await fixture();

    expect(io.loadConfig().gateway?.port).toBe(18789);
    const snapshot = await io.readBestEffortConfigSnapshot();
    expect(snapshot.configDiagnostics).toBeNull();
    expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
    expect(snapshot.sourceConfig.agents?.defaults?.compaction).toBeUndefined();
    const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
    const { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } =
      await import("../infra/kysely-sync.js");
    const { db } = openOpenClawStateDatabase({ env });
    const query = getNodeSqliteKysely<Pick<DB, "config_health_entries">>(db)
      .selectFrom("config_health_entries")
      .select(["config_path", "last_known_good_json"])
      .where("config_path", "=", configPath);
    expect(executeSqliteQueryTakeFirstSync(db, query)).toMatchObject({
      config_path: configPath,
      last_known_good_json: expect.any(String),
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    expect(loadWriter).not.toHaveBeenCalled();
  });

  it("loads the real writer on first use and reads back the persisted config", async () => {
    const loadWriter = vi.fn(() =>
      vi.importActual<typeof import("./io.write.js")>("./io.write.js"),
    );
    vi.doMock("./io.write.js", loadWriter);
    const { io, configPath } = await fixture();
    const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
    expect(loadWriter).not.toHaveBeenCalled();

    await io.writeConfigFile(
      { gateway: { mode: "local", port: 19001 } },
      { ...writeOptions, baseSnapshot: snapshot },
    );

    expect(loadWriter).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).gateway.port).toBe(19001);
    expect((await io.readConfigFileSnapshot()).config.gateway?.port).toBe(19001);
  });

  it.each(["path", "snapshot"] as const)(
    "rejects %s changes while the writer import is pending",
    async (change) => {
      const entered = createDeferred();
      const release = createDeferred();
      vi.doMock("./io.write.js", async () => {
        entered.resolve();
        await release.promise;
        return vi.importActual<typeof import("./io.write.js")>("./io.write.js");
      });
      const { io, env, home, configPath, raw } = await fixture();
      const secondPath = path.join(home, "second.json");
      await fs.writeFile(secondPath, raw);
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      const write = io.writeConfigFile(
        { gateway: { mode: "local", port: 19002 } },
        { ...writeOptions, baseSnapshot: snapshot },
      );
      const rejected = expect(write).rejects.toThrow(
        change === "path"
          ? "config path changed since last load"
          : "config changed since last load",
      );
      let expectedRaw = raw;
      try {
        await entered.promise;
        if (change === "path") {
          env.OPENCLAW_CONFIG_PATH = secondPath;
        } else {
          expectedRaw = JSON.stringify({ gateway: { mode: "local", port: 19003 } });
          await fs.writeFile(configPath, expectedRaw);
        }
      } finally {
        release.resolve();
      }
      await rejected;
      expect(await fs.readFile(configPath, "utf8")).toBe(expectedRaw);
      expect(await fs.readFile(secondPath, "utf8")).toBe(raw);
    },
  );
});
