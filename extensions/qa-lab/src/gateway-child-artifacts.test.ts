import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  openOpenClawAgentDatabase,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupQaGatewayTempRoots } from "./gateway-child-artifacts.js";
import { readQaAuthProfiles, writeQaAuthProfiles } from "./providers/shared/auth-store.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
import { runQaScenarioCommandLifecycle } from "./test-file-scenario-command-lifecycle.js";

const dirs = createTempDirHarness();
const runtimeRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const tempRoot of runtimeRoots.splice(0)) {
    await cleanupQaGatewayTempRoots({ tempRoot });
  }
  await dirs.cleanup();
});

describe("cleanupQaGatewayTempRoots", () => {
  it("does not recreate disposed state at natural parent exit or close sibling stores", async () => {
    const root = await fs.realpath(await dirs.makeTempDir("qa-cleanup-parent-stores-"));
    const tempRoot = path.join(root, "runtime");
    const stagedBundledPluginsRoot = path.join(root, "plugins");
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    await Promise.all([home, tmp, stagedBundledPluginsRoot].map((dir) => fs.mkdir(dir)));
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const source = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { openOpenClawAgentDatabase, openOpenClawStateDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
      import { stageQaLiveApiKeyProfiles } from ${JSON.stringify(new URL("./providers/live-frontier/auth.ts", import.meta.url).href)};
      import { readQaAuthProfiles } from ${JSON.stringify(new URL("./providers/shared/auth-store.ts", import.meta.url).href)};
      import { cleanupQaGatewayTempRoots } from ${JSON.stringify(new URL("./gateway-child-artifacts.ts", import.meta.url).href)};
      const tempRoot = ${JSON.stringify(tempRoot)};
      const roots = [tempRoot, tempRoot + "-sibling"];
      await Promise.all(roots.map(root => stageQaLiveApiKeyProfiles({
        cfg: {}, stateDir: path.join(root, "state"), providerIds: ["openai"],
        env: { OPENAI_API_KEY: "qa-fake-not-a-real-key" },
      })));
      const stores = roots.map(root => {
        const stateDir = path.join(root, "state");
        const agentDir = path.join(stateDir, "agents", "qa", "agent");
        const env = { OPENCLAW_STATE_DIR: stateDir };
        return {
          agentDir,
          agent: openOpenClawAgentDatabase({ agentId: "qa", env, path: path.join(agentDir, "openclaw-agent.sqlite") }),
          shared: openOpenClawStateDatabase({ env }),
          profiles: readQaAuthProfiles(agentDir),
        };
      });
      const sibling = stores[1];
      const leases = () => sibling.shared.db.prepare("SELECT * FROM agent_database_leases ORDER BY lease_id").all();
      const beforeLeases = leases();
      await cleanupQaGatewayTempRoots({ tempRoot, stagedBundledPluginsRoot: ${JSON.stringify(stagedBundledPluginsRoot)} });
      assert.equal(fs.existsSync(tempRoot), false);
      assert.equal(sibling.agent.db.isOpen, true);
      assert.equal(sibling.shared.db.isOpen, true);
      assert.deepEqual(readQaAuthProfiles(sibling.agentDir), sibling.profiles);
      assert.deepEqual(leases(), beforeLeases);
      process.stdout.write(JSON.stringify({
        targetClosed: !stores[0].agent.db.isOpen && !stores[0].shared.db.isOpen,
        siblingUsable: true,
      }));
    `;
    const result = await runQaScenarioCommandLifecycle({
      command: process.execPath,
      args: ["--import", "tsx", "--input-type=module", "--eval", source],
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "xdg-state"),
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        TSX_DISABLE_CACHE: "1",
        TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
      },
      timeoutMs: 90_000,
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.failureMessage).toBeUndefined();
    // Check from outside the process: SQLite exit hooks run after cleanup returns.
    await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(stagedBundledPluginsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(result.stdout)).toEqual({ targetClosed: true, siblingUsable: true });
  }, 120_000);

  it.each(["agent", "shared"] as const)(
    "retains runtime on %s close failure, removes staging, and permits cleanup retry",
    async (failedStore) => {
      const tempRoot = await dirs.makeTempDir("qa-cleanup-store-failure-");
      runtimeRoots.push(tempRoot);
      const stagedBundledPluginsRoot = await dirs.makeTempDir("qa-cleanup-store-plugins-");
      const stateDir = path.join(tempRoot, "state");
      const agentDir = path.join(stateDir, "agents", "qa", "agent");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      await writeQaAuthProfiles({
        agentId: "qa",
        stateDir,
        profiles: { fake: { type: "api_key", provider: "openai", key: "qa-synthetic" } },
      });
      readQaAuthProfiles(agentDir);
      const agent = openOpenClawAgentDatabase({
        agentId: "qa",
        env,
        path: path.join(agentDir, "openclaw-agent.sqlite"),
      });
      const shared = openOpenClawStateDatabase({ env });
      const failed = failedStore === "agent" ? agent : shared;
      const close = vi.spyOn(failed.db, "close").mockImplementationOnce(() => {
        throw new Error("close failed apiKey=synthetic-close-secret", {
          cause: new Error("synthetic-close-cause"),
        });
      });

      const outcome = await cleanupQaGatewayTempRoots({
        tempRoot,
        stagedBundledPluginsRoot,
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(inspect(outcome, { depth: null })).toContain("tempRoot: close failed");
      expect(inspect(outcome, { depth: null })).not.toMatch(
        /synthetic-close-secret|synthetic-close-cause/,
      );
      expect(failed.db.isOpen).toBe(true);
      expect(shared.db.isOpen).toBe(true);
      await expect(fs.stat(tempRoot)).resolves.toBeDefined();
      await expect(fs.stat(stagedBundledPluginsRoot)).rejects.toMatchObject({ code: "ENOENT" });

      close.mockRestore();
      await cleanupQaGatewayTempRoots({ tempRoot, stagedBundledPluginsRoot });
      expect(agent.db.isOpen).toBe(false);
      expect(shared.db.isOpen).toBe(false);
      await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // Short messages expose cause leaks that padding could hide behind truncation.
  it.each([
    { failedRoots: ["tempRoot"], padding: "" },
    { failedRoots: ["stagedBundledPluginsRoot"], padding: "" },
    { failedRoots: ["tempRoot", "stagedBundledPluginsRoot"], padding: "diagnostic ".repeat(400) },
  ])(
    "reports $failedRoots failures after attempting both roots",
    async ({ failedRoots, padding }) => {
      const roots = {
        tempRoot: await dirs.makeTempDir("qa-cleanup-runtime-"),
        stagedBundledPluginsRoot: await dirs.makeTempDir("qa-cleanup-plugins-"),
      };
      const originalRm = fs.rm;
      const attempts: string[] = [];
      vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        const entry = Object.entries(roots).find(([, root]) => root === target);
        if (entry) {
          attempts.push(entry[0]);
          if (failedRoots.includes(entry[0])) {
            throw Object.assign(
              new Error(`EACCES: denied apiKey=synthetic-cleanup-secret\n${padding}`),
              { code: "EACCES", path: target, cause: new Error("synthetic-raw-cause") },
            );
          }
        }
        return originalRm(target, options);
      });

      const outcome = await cleanupQaGatewayTempRoots(roots).catch((error: unknown) => error);
      expect(attempts).toEqual(Object.keys(roots));
      for (const [label, root] of Object.entries(roots)) {
        if (failedRoots.includes(label)) {
          await expect(fs.stat(root)).resolves.toBeDefined();
        } else {
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(outcome).toBeInstanceOf(AggregateError);
      if (!(outcome instanceof AggregateError)) {
        throw new Error("expected cleanup failure");
      }
      expect(outcome.errors).toHaveLength(failedRoots.length);
      for (const label of failedRoots) {
        expect(outcome.message).toContain(label);
      }
      expect(outcome.message).toContain("EACCES");
      expect(outcome.message.length).toBeLessThan(4_500);
      expect(inspect(outcome, { depth: null })).not.toMatch(
        /synthetic-cleanup-secret|synthetic-raw-cause/,
      );
    },
  );

  it.each([undefined, null, "missing"])(
    "accepts an already removed runtime with staged root %s",
    async (staging) => {
      const parent = await dirs.makeTempDir("qa-cleanup-absent-");
      await expect(
        cleanupQaGatewayTempRoots({
          tempRoot: path.join(parent, "runtime"),
          stagedBundledPluginsRoot: staging ? path.join(parent, staging) : staging,
        }),
      ).resolves.toBeUndefined();
    },
  );
});
