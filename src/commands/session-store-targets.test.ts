// Session store target tests cover session-store path resolution for command surfaces.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { resolveCommandSessionStoreTargets } from "./session-store-targets.js";

const resolveSessionStoreTargetsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", () => ({
  resolveSessionStoreTargets: resolveSessionStoreTargetsMock,
}));

function createRepairableSessionDatabase(pathname: string): void {
  const database = new DatabaseSync(pathname);
  database.exec(`
    CREATE TABLE schema_meta (
      meta_key TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      agent_id TEXT
    );
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
    VALUES ('primary', 'agent', 0, 'main');
  `);
  database.close();
}

describe("resolveCommandSessionStoreTargets", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns targets from the shared config helper", () => {
    resolveSessionStoreTargetsMock.mockReturnValue([
      { agentId: "main", storePath: "/tmp/main-sessions.json" },
    ]);
    const targets = resolveCommandSessionStoreTargets({
      cfg: {},
      opts: {},
    });

    expect(targets).toEqual([{ agentId: "main", storePath: "/tmp/main-sessions.json" }]);
    expect(resolveSessionStoreTargetsMock).toHaveBeenCalledWith({}, {});
  });

  it("hands resolution errors to the CLI failure owner", () => {
    resolveSessionStoreTargetsMock.mockImplementation(() => {
      throw new Error("Unknown agent id: ghost");
    });
    expect(() => resolveCommandSessionStoreTargets({ cfg: {}, opts: { agent: "ghost" } })).toThrow(
      ExpectedCliError,
    );
  });

  it.each(["missing", "suffixless", "directory", "non-database", "foreign-database"] as const)(
    "rejects a %s explicit store through the CLI failure owner",
    (storeKind) => {
      const dir = tempDirs.make("openclaw-explicit-session-store-");
      const storePath = path.join(
        dir,
        storeKind === "suffixless" ? "requested-store" : `${storeKind}.sqlite`,
      );
      const resolvedPath = storeKind === "suffixless" ? `${storePath}.sqlite` : storePath;
      if (storeKind === "suffixless" || storeKind === "directory") {
        fs.mkdirSync(storePath);
      } else if (storeKind === "non-database") {
        fs.writeFileSync(storePath, "not a db");
      } else if (storeKind === "foreign-database") {
        const database = new DatabaseSync(storePath);
        database.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
        database.close();
      }
      resolveSessionStoreTargetsMock.mockReturnValue([{ agentId: "main", storePath }]);
      expect(() =>
        resolveCommandSessionStoreTargets({ cfg: {}, opts: { store: storePath } }),
      ).toThrow(
        expect.objectContaining({
          name: "ExpectedCliError",
          message: expect.stringMatching(
            /resolved SQLite target exists|not a session store|not a regular file/iu,
          ),
          humanOutput: expect.stringContaining(resolvedPath),
          machineOutput: expect.stringContaining(resolvedPath),
        }),
      );
    },
  );

  it.each([
    ["legacy JSON locator", "sessions.json", "openclaw-agent.sqlite"],
    ["suffixless locator", "offline-store", "offline-store.sqlite"],
  ])("accepts an existing SQLite target resolved from a %s", (_name, locator, target) => {
    const dir = tempDirs.make("openclaw-explicit-session-store-");
    const storePath = path.join(dir, locator);
    createRepairableSessionDatabase(path.join(dir, target));
    resolveSessionStoreTargetsMock.mockReturnValue([{ agentId: "main", storePath }]);
    const targets = resolveCommandSessionStoreTargets({
      cfg: {},
      opts: { store: storePath },
    });

    expect(targets).toEqual([{ agentId: "main", storePath }]);
  });
});
