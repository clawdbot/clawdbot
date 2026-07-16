// Covers the CI node test shard runner: plan resolution from job env and
// bounded-concurrency execution with per-child Vitest cache isolation.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildChildEnv,
  resolveShardChildCommand,
  resolveShardPlans,
  runShardPlans,
} from "../../scripts/ci-run-node-test-shard.mjs";

const scratchDirs: string[] = [];

function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-shard-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("scripts/ci-run-node-test-shard.mjs", () => {
  it("launches the child runner directly with Node", () => {
    expect(resolveShardChildCommand(["one.config.ts"], "/runtime/node")).toEqual({
      command: "/runtime/node",
      args: ["scripts/test-projects.mjs", "one.config.ts"],
    });
  });

  it("prefers explicit targets and keeps one target per child", () => {
    const plans = resolveShardPlans({
      OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(["a.test.ts", "b.test.ts"]),
      OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([{ configs: ["c.config.ts"] }]),
    });
    expect(plans).toEqual([
      { kind: "target", name: "a.test.ts", target: "a.test.ts" },
      { kind: "target", name: "b.test.ts", target: "b.test.ts" },
    ]);
  });

  it("falls back from groups to the single-shard matrix envelope", () => {
    const groupPlans = resolveShardPlans({
      OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
        { configs: ["one.config.ts"], shard_name: "one" },
        { configs: ["two.config.ts"], shard_name: "two" },
      ]),
    });
    expect(groupPlans.map((plan) => plan.name)).toEqual(["one", "two"]);

    const singlePlans = resolveShardPlans({
      OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(["solo.config.ts"]),
      OPENCLAW_VITEST_SHARD_NAME: "solo",
    });
    expect(singlePlans).toHaveLength(1);
    expect(singlePlans[0]).toMatchObject({ kind: "group", name: "solo" });
  });

  it("builds child env with per-plan cache isolation, includes, and env overlays", () => {
    const scratchDir = makeScratchDir();
    const entry = {
      kind: "group" as const,
      name: "g",
      plan: {
        configs: ["cfg.ts"],
        env: { EXTRA: "yes", IGNORED: 42 },
        includePatterns: ["src/a.test.ts"],
        shard_name: "g",
      },
    };
    const childEnv = buildChildEnv(
      entry,
      { BASE: "1", OPENCLAW_VITEST_INCLUDE_FILE: "stale.json" },
      scratchDir,
      3,
    );
    expect(childEnv.BASE).toBe("1");
    expect(childEnv.EXTRA).toBe("yes");
    expect(childEnv.IGNORED).toBeUndefined();
    expect(childEnv.OPENCLAW_VITEST_SHARD_NAME).toBe("g");
    expect(childEnv.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe("1");
    expect(childEnv.OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD).toBe("1");
    expect(childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBe(
      path.join(scratchDir, "vitest-cache-3"),
    );
    expect(childEnv.OPENCLAW_VITEST_INCLUDE_FILE).toBe(
      path.join(scratchDir, "node-test-include-3.json"),
    );
    expect(JSON.parse(readFileSync(childEnv.OPENCLAW_VITEST_INCLUDE_FILE ?? "", "utf8"))).toEqual([
      "src/a.test.ts",
    ]);

    const bare = buildChildEnv(
      { kind: "group" as const, name: "bare", plan: { configs: ["cfg.ts"] } },
      { OPENCLAW_VITEST_INCLUDE_FILE: "stale.json" },
      scratchDir,
      0,
    );
    expect(bare.OPENCLAW_VITEST_INCLUDE_FILE).toBeUndefined();
  });

  it("runs plans with bounded concurrency and distinct cache paths", async () => {
    const scratchDir = makeScratchDir();
    const seen: Array<{ args: string[]; cache: string | undefined; label: string }> = [];
    let active = 0;
    let peakActive = 0;
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
          { configs: ["a.config.ts"], shard_name: "a" },
          { configs: ["b.config.ts"], shard_name: "b" },
          { configs: ["c.config.ts"], shard_name: "c" },
        ]),
      }),
      {
        concurrency: 2,
        env: {},
        runChild: async (
          args: string[],
          childEnv: Record<string, string | undefined>,
          label: string,
        ) => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
          seen.push({ args, cache: childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH, label });
          active -= 1;
          return 0;
        },
        scratchDir,
      },
    );
    expect(exitCode).toBe(0);
    expect(peakActive).toBeLessThanOrEqual(2);
    expect(seen.map((run) => run.label).toSorted()).toEqual(["a", "b", "c"]);
    expect(new Set(seen.map((run) => run.cache)).size).toBe(3);
  });

  it("stops scheduling new plans after a failure and reports the first failing code", async () => {
    const scratchDir = makeScratchDir();
    const started: string[] = [];
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
          { configs: ["a.config.ts"], shard_name: "a" },
          { configs: ["b.config.ts"], shard_name: "b" },
          { configs: ["c.config.ts"], shard_name: "c" },
          { configs: ["d.config.ts"], shard_name: "d" },
        ]),
      }),
      {
        concurrency: 1,
        env: {},
        runChild: async (
          _args: string[],
          _env: Record<string, string | undefined>,
          label: string,
        ) => {
          started.push(label);
          return label === "b" ? 7 : 0;
        },
        scratchDir,
      },
    );
    expect(exitCode).toBe(7);
    expect(started).toEqual(["a", "b"]);
  });

  it("fails plans that carry no configs", async () => {
    const scratchDir = makeScratchDir();
    const exitCode = await runShardPlans(
      [{ kind: "group" as const, name: "broken", plan: { configs: [] } }],
      { concurrency: 1, env: {}, runChild: async () => 0, scratchDir },
    );
    expect(exitCode).toBe(1);
  });
});
