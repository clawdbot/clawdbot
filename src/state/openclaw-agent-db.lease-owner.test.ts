import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  settleOpenClawAgentDatabaseWorkerClose,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "./openclaw-state-ownership-operations.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

function createOwner() {
  const stateDir = tempDirs.make("agent-lease-owner-");
  const nextStateDir = tempDirs.make("agent-lease-next-");
  const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
  const state = openOpenClawStateDatabase({ env });
  const leases = () => state.db.prepare("SELECT lease_id FROM agent_database_leases").all();
  return { stateDir, nextStateDir, env, leases };
}

describe("agent database lease acquisition owner", () => {
  it.each([
    { kind: "ambient environment", ambient: true, external: false, worker: false },
    { kind: "mutated explicit environment", ambient: false, external: false, worker: false },
    { kind: "removed external supervision marker", ambient: false, external: true, worker: false },
    {
      kind: "Worker settlement after environment mutation",
      ambient: false,
      external: false,
      worker: true,
    },
  ])("releases the original lease with $kind", ({ ambient, external, worker }) => {
    const owner = createOwner();
    if (external) {
      owner.env.OPENCLAW_SUPERVISOR_MODE = "external";
      claimOpenClawStateOwnership("fixture-supervisor", { env: owner.env });
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", owner.stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      ...(ambient ? {} : { env: owner.env }),
    });
    expect(owner.leases()).toHaveLength(1);
    try {
      if (external) {
        delete owner.env.OPENCLAW_SUPERVISOR_MODE;
      } else {
        owner.env.OPENCLAW_STATE_DIR = owner.nextStateDir;
        vi.stubEnv("OPENCLAW_STATE_DIR", owner.nextStateDir);
      }
      expect(fs.readdirSync(owner.nextStateDir)).toEqual([]);
      if (worker) {
        expect(settleOpenClawAgentDatabaseWorkerClose(database.path)).toEqual({
          errors: [],
          settled: true,
        });
      } else if (ambient) {
        closeOpenClawAgentDatabasesForTest();
      } else {
        expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
      }
      expect(database.db.isOpen).toBe(false);
      expect(owner.leases()).toEqual([]);
      expect(fs.readdirSync(owner.nextStateDir)).toEqual([]);
    } finally {
      owner.env.OPENCLAW_STATE_DIR = owner.stateDir;
      if (external) {
        owner.env.OPENCLAW_SUPERVISOR_MODE = "external";
      }
      vi.stubEnv("OPENCLAW_STATE_DIR", owner.stateDir);
    }
  });

  it.each([false, true])(
    "releases a failed open in its original store (retained handle: %s)",
    (retainHandle) => {
      const owner = createOwner();
      const database = openOpenClawAgentDatabase({ agentId: "main", env: owner.env });
      expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
      const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
      const open = vi
        .spyOn(nodeSqlite, "openNodeSqliteDatabase")
        .mockImplementation((location, options) => {
          const connection = nativeOpen(location, options);
          if (location === database.path) {
            open.mockRestore();
            const close = connection.close.bind(connection);
            vi.spyOn(connection, "close").mockImplementationOnce(() => {
              // Change the caller's environment after claim, during failed-open cleanup.
              owner.env.OPENCLAW_STATE_DIR = owner.nextStateDir;
              if (retainHandle) {
                throw new Error("fixture close failure");
              }
              close();
            });
          }
          return connection;
        });
      try {
        expect(() =>
          openOpenClawAgentDatabase({ agentId: "other", env: owner.env, path: database.path }),
        ).toThrow(retainHandle ? "fixture close failure" : "belongs to agent main");
        open.mockRestore();
        if (retainHandle) {
          expect(owner.leases()).toHaveLength(1);
          expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        }
        expect(owner.leases()).toEqual([]);
        expect(fs.readdirSync(owner.nextStateDir)).toEqual([]);
      } finally {
        open.mockRestore();
        owner.env.OPENCLAW_STATE_DIR = owner.stateDir;
      }
    },
  );
});
