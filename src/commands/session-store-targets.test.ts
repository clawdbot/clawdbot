// Session store target tests cover session-store path resolution for command surfaces.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";

const resolveSessionStoreTargetsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", () => ({
  resolveSessionStoreTargets: resolveSessionStoreTargetsMock,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

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

describe("resolveSessionStoreTargetsOrExit", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns targets from the shared config helper", () => {
    resolveSessionStoreTargetsMock.mockReturnValue([
      { agentId: "main", storePath: "/tmp/main-sessions.json" },
    ]);
    const runtime = createRuntime();

    const targets = resolveSessionStoreTargetsOrExit({
      cfg: {},
      opts: {},
      runtime,
    });

    expect(targets).toEqual([{ agentId: "main", storePath: "/tmp/main-sessions.json" }]);
    expect(resolveSessionStoreTargetsMock).toHaveBeenCalledWith({}, {});
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports resolution errors and exits the command", () => {
    resolveSessionStoreTargetsMock.mockImplementation(() => {
      throw new Error("Unknown agent id: ghost");
    });
    const runtime = createRuntime();

    const targets = resolveSessionStoreTargetsOrExit({
      cfg: {},
      opts: { agent: "ghost" },
      runtime,
    });

    expect(targets).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith("Unknown agent id: ghost");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ["missing", "human"],
    ["missing", "json"],
    ["suffixless", "human"],
    ["suffixless", "json"],
    ["non-database", "human"],
    ["non-database", "json"],
    ["foreign-database", "human"],
    ["foreign-database", "json"],
  ] as const)("rejects a %s explicit store in %s mode", (storeKind, mode) => {
    const dir = tempDirs.make("openclaw-explicit-session-store-");
    const storePath =
      storeKind === "missing"
        ? path.join(dir, "missing.sqlite")
        : storeKind === "suffixless"
          ? path.join(dir, "requested-store")
          : storeKind === "foreign-database"
            ? path.join(dir, "foreign.sqlite")
            : path.join(dir, "not-a-database.sqlite");
    const resolvedPath = storeKind === "suffixless" ? `${storePath}.sqlite` : storePath;
    if (storeKind === "suffixless") {
      fs.mkdirSync(storePath);
    } else if (storeKind === "non-database") {
      fs.writeFileSync(storePath, "not a db");
    } else if (storeKind === "foreign-database") {
      const database = new DatabaseSync(storePath);
      database.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
      database.close();
    }
    resolveSessionStoreTargetsMock.mockReturnValue([{ agentId: "main", storePath }]);
    const runtime = createRuntime();

    const targets = resolveSessionStoreTargetsOrExit({
      cfg: {},
      opts: { store: storePath },
      runtime,
      json: mode === "json",
    });

    expect(targets).toBeNull();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    const output = [...vi.mocked(runtime.log).mock.calls, ...vi.mocked(runtime.error).mock.calls]
      .flat()
      .join("\n");
    expect(output).toContain(resolvedPath);
    expect(output).toMatch(/session store/iu);
    expect(output).toMatch(/resolved SQLite target exists|not a session store/iu);
    if (storeKind === "suffixless") {
      expect(output).toContain(storePath);
    }
    if (mode === "json") {
      expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual({
        error: expect.stringContaining(resolvedPath),
      });
      expect(runtime.error).not.toHaveBeenCalled();
    } else {
      expect(runtime.error).toHaveBeenCalledOnce();
      expect(runtime.log).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["legacy JSON locator", "sessions.json", "openclaw-agent.sqlite"],
    ["suffixless locator", "offline-store", "offline-store.sqlite"],
  ])("accepts an existing SQLite target resolved from a %s", (_name, locator, target) => {
    const dir = tempDirs.make("openclaw-explicit-session-store-");
    const storePath = path.join(dir, locator);
    createRepairableSessionDatabase(path.join(dir, target));
    resolveSessionStoreTargetsMock.mockReturnValue([{ agentId: "main", storePath }]);
    const runtime = createRuntime();

    const targets = resolveSessionStoreTargetsOrExit({
      cfg: {},
      opts: { store: storePath },
      runtime,
    });

    expect(targets).toEqual([{ agentId: "main", storePath }]);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
