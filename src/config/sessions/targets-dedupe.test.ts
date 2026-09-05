import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { dedupeSessionStoreTargetsBySqliteTarget } from "./targets.js";

describe("session store target dedupe", () => {
  it.runIf(process.platform !== "win32")(
    "refreshes aliased SQLite locators between dedupe calls",
    async () => {
      await withTempHome(async (home) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
        const realDir = path.join(home, "real-stores");
        const aliasDir = path.join(home, "alias-stores");
        await fs.mkdir(realDir, { recursive: true });
        await fs.symlink(realDir, aliasDir, "dir");
        const targets = [
          { agentId: "main", storePath: path.join(realDir, "shared.sqlite") },
          { agentId: "ops", storePath: path.join(aliasDir, "shared.sqlite") },
        ];
        const diagnostics: string[] = [];

        expect(
          dedupeSessionStoreTargetsBySqliteTarget(targets, {
            defaultAgentId: "main",
            env,
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
          }),
        ).toEqual([targets[0]]);
        expect(diagnostics).toContainEqual(expect.stringContaining('ignored owner(s): "ops"'));

        const otherDir = path.join(home, "other-stores");
        await fs.mkdir(otherDir);
        await fs.unlink(aliasDir);
        await fs.symlink(otherDir, aliasDir, "dir");
        expect(
          dedupeSessionStoreTargetsBySqliteTarget(targets, { defaultAgentId: "main", env }),
        ).toHaveLength(2);
      });
    },
  );

  it("prepares each SQLite identity once during one dedupe pass", async () => {
    await withTempHome(async (home) => {
      const realHome = realpathSync(home);
      const targets = Array.from({ length: 29 }, (_, index) => ({
        agentId: `agent-${index}`,
        storePath: path.join(
          realHome,
          ".openclaw",
          "agents",
          `agent-${index}`,
          "sessions",
          "sessions.json",
        ),
      }));
      const databaseDirs = new Set(
        targets.map((target) => path.join(path.dirname(path.dirname(target.storePath)), "agent")),
      );
      await Promise.all(
        [...databaseDirs].map((databaseDir) => fs.mkdir(databaseDir, { recursive: true })),
      );
      const realpathNative = vi.spyOn(realpathSync, "native");
      try {
        expect(
          dedupeSessionStoreTargetsBySqliteTarget([...targets, ...targets], {
            defaultAgentId: targets[0]!.agentId,
          }),
        ).toEqual(targets);
        const preparedPaths = realpathNative.mock.calls.flatMap(([pathname]) =>
          typeof pathname === "string" && databaseDirs.has(pathname) ? [pathname] : [],
        );
        expect(preparedPaths).toHaveLength(targets.length);
        expect(new Set(preparedPaths).size).toBe(preparedPaths.length);
      } finally {
        realpathNative.mockRestore();
      }
    });
  });
});
