// Session store target resolution for bounded retired/manual lookups.
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { resolveExistingAgentSessionStoreTargetsSync } from "./targets.js";
import { countMatching, createAgentSessionStores } from "./targets.test-support.js";

describe("resolveExistingAgentSessionStoreTargetsSync", () => {
  it("validates a configured canonical SQLite target once", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["main"]);
      const agentsRoot = path.join(stateDir, "agents");
      const sqlitePath = path.join(agentsRoot, "main", "agent", "openclaw-agent.sqlite");
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      const lstat = vi.spyOn(nodeFs, "lstatSync");
      const realpath = vi.spyOn(nodeFs.realpathSync, "native");
      syncBuiltinESMExports();
      try {
        expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "main")).toEqual([
          { agentId: "main", storePath: storePaths.main },
        ]);

        expect({
          sqliteLstat: countMatching(lstat.mock.calls, ([candidate]) => candidate === sqlitePath),
          sqliteRealpath: countMatching(
            realpath.mock.calls,
            ([candidate]) => candidate === sqlitePath,
          ),
          rootRealpath: countMatching(
            realpath.mock.calls,
            ([candidate]) => candidate === agentsRoot,
          ),
        }).toEqual({ sqliteLstat: 1, sqliteRealpath: 1, rootRealpath: 1 });
      } finally {
        lstat.mockRestore();
        realpath.mockRestore();
        syncBuiltinESMExports();
      }
    });
  });

  it("does not resolve unrelated registered store identities", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const unrelatedAgentIds = Array.from({ length: 12 }, (_, index) => `extra-${index}`);
      const storePaths = await createAgentSessionStores(stateDir, [
        "retired",
        ...unrelatedAgentIds,
      ]);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      const lstat = vi.spyOn(nodeFs, "lstatSync");
      const stat = vi.spyOn(nodeFs, "statSync");
      const realpath = vi.spyOn(nodeFs.realpathSync, "native");
      syncBuiltinESMExports();
      try {
        expect(
          resolveExistingAgentSessionStoreTargetsSync(cfg, "retired", { env: process.env }),
        ).toEqual([{ agentId: "retired", storePath: storePaths.retired }]);

        const isUnrelatedAgentPath = ([candidate]: readonly unknown[]) =>
          typeof candidate === "string" && candidate.includes(`${path.sep}agents${path.sep}extra-`);
        expect({
          lstat: countMatching(lstat.mock.calls, isUnrelatedAgentPath),
          stat: countMatching(stat.mock.calls, isUnrelatedAgentPath),
          realpath: countMatching(realpath.mock.calls, isUnrelatedAgentPath),
        }).toEqual({ lstat: 0, stat: 0, realpath: 0 });
      } finally {
        lstat.mockRestore();
        stat.mockRestore();
        realpath.mockRestore();
        syncBuiltinESMExports();
      }
    });
  });

  it("finds a store under another configured agent's template root", async () => {
    await withTempHome(async (home) => {
      const storesRoot = path.join(home, "stores");
      const storePaths = await createAgentSessionStores(path.join(storesRoot, "work"), ["old"]);
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(
            storesRoot,
            "{agentId}",
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          ),
        },
        agents: { list: [{ id: "ops", default: true }, { id: "work" }] },
      };

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "old", { env: process.env })).toEqual(
        [{ agentId: "old", storePath: storePaths.old }],
      );
    });
  });
});
