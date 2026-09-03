// Covers the CI node test shard runner: plan resolution from job env and
// bounded-concurrency execution with per-child Vitest cache isolation.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChildEnv,
  clonePersistentCacheSlots,
  pruneFsModuleCache,
  resolveShardChildCommand,
  resolveShardPlans,
  resolveTestProjectsEntrypoint,
  runShardPlans,
} from "../../scripts/ci-run-node-test-shard.mts";
import { refitTestTimings } from "../../scripts/lib/ci-test-timings-refit.mts";
import { createDeferred } from "../helpers/promise.js";

const scratchDirs: string[] = [];

function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-shard-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("scripts/ci-run-node-test-shard.mts", () => {
  it("launches the current TypeScript child runner directly with Node", () => {
    expect(resolveShardChildCommand(["one.config.ts"], "/runtime/node")).toEqual({
      command: "/runtime/node",
      args: ["--import", "tsx", "scripts/test-projects.mts", "one.config.ts"],
    });
  });

  it("uses the compiled child runner from a frozen candidate", () => {
    const entrypoint = resolveTestProjectsEntrypoint((candidate) => candidate.endsWith(".mjs"));
    expect(entrypoint).toBe("scripts/test-projects.mjs");
    expect(resolveShardChildCommand(["one.config.ts"], "/runtime/node", entrypoint)).toEqual({
      command: "/runtime/node",
      args: ["scripts/test-projects.mjs", "one.config.ts"],
    });
  });

  it("fails clearly when the candidate has no test-projects entrypoint", () => {
    expect(() => resolveTestProjectsEntrypoint(() => false)).toThrow(
      "CI target does not provide scripts/test-projects.mts or .mjs",
    );
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
        { configs: ["one.config.ts"], shard_name: "one", timing_key: "one#include-aaaa" },
        { configs: ["two.config.ts"], shard_name: "two" },
      ]),
    });
    expect(groupPlans.map((plan) => plan.name)).toEqual(["one", "two"]);
    expect(groupPlans.map((plan) => (plan.kind === "group" ? plan.timingKey : null))).toEqual([
      "one#include-aaaa",
      "two",
    ]);

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

  it.each([
    {
      name: "local explicit concurrency",
      cpus: 2,
      gib: 16,
      ci: undefined,
      actions: undefined,
      requested: 3,
      expected: 3,
    },
    {
      name: "CI capacity boundary",
      cpus: 8,
      gib: 24,
      ci: "true",
      actions: undefined,
      requested: 2,
      expected: 2,
    },
    {
      name: "CPU-constrained CI",
      cpus: 4,
      gib: 32,
      ci: "true",
      actions: undefined,
      requested: 2,
      expected: 1,
    },
    {
      name: "memory-constrained CI",
      cpus: 8,
      gib: 16,
      ci: "true",
      actions: undefined,
      requested: 2,
      expected: 1,
    },
    {
      name: "unknown CI CPUs",
      cpus: Number.NaN,
      gib: 32,
      ci: "true",
      actions: undefined,
      requested: 2,
      expected: 1,
    },
    {
      name: "unknown CI memory",
      cpus: 8,
      gib: Number.NaN,
      ci: "true",
      actions: undefined,
      requested: 2,
      expected: 1,
    },
    {
      name: "CI two-plan ceiling",
      cpus: 16,
      gib: 64,
      ci: "true",
      actions: undefined,
      requested: 3,
      expected: 2,
    },
    {
      name: "GitHub Actions capacity",
      cpus: 4,
      gib: 32,
      ci: undefined,
      actions: "true",
      requested: 2,
      expected: 1,
    },
  ])(
    "runs plans with bounded concurrency and cache isolation for $name",
    async ({ cpus, gib, ci, actions, requested, expected }) => {
      vi.spyOn(os, "availableParallelism").mockReturnValue(cpus);
      vi.spyOn(os, "totalmem").mockReturnValue(gib * 1024 ** 3);
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
          concurrency: ci || actions ? undefined : requested,
          env: {
            CI: ci,
            GITHUB_ACTIONS: actions,
            OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: String(requested),
          },
          runChild: async (
            args: string[],
            childEnv: Record<string, string | undefined>,
            label: string,
          ) => {
            active += 1;
            peakActive = Math.max(peakActive, active);
            await Promise.resolve();
            seen.push({ args, cache: childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH, label });
            active -= 1;
            return 0;
          },
          scratchDir,
        },
      );
      expect(exitCode).toBe(0);
      expect(peakActive).toBe(expected);
      expect(seen.map((run) => run.label).toSorted()).toEqual(["a", "b", "c"]);
      expect(new Set(seen.map((run) => run.cache)).size).toBe(expected === 1 ? 1 : 3);
    },
  );

  it("keeps readable child output separate from membership timing spans", async () => {
    const timingKey =
      "agentic-agents-support#selector-2-aaaa#generation-bbbb#part-1-of-2#include-1-cccc";
    const lines: string[] = [];
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
          {
            configs: ["one.config.ts"],
            shard_name: "agentic-agents-support-hosted-1",
            timing_key: timingKey,
          },
        ]),
      }),
      {
        concurrency: 1,
        env: {},
        runChild: async (_args, _childEnv, label, spanKey) => {
          lines.push(`2026-08-27T23:00:00Z [shard:${spanKey}] begin`);
          lines.push(`2026-08-27T23:00:01Z [shard:${label}] child output`);
          lines.push(`2026-08-27T23:00:10Z [shard:${spanKey}] end (exit 0)`);
          return 0;
        },
        scratchDir: makeScratchDir(),
      },
    );

    expect(exitCode).toBe(0);
    expect(lines[1]).toContain("[shard:agentic-agents-support-hosted-1] child output");
    const runs = [1, 2].map((id) => ({
      id,
      createdAt: `2026-08-${26 + id}T23:00:00Z`,
      logs: [{ kind: "compact" as const, labels: ["blacksmith-16vcpu"], text: lines.join("\n") }],
    }));
    expect(refitTestTimings(runs).timings.compactGroupSeconds.blacksmith[timingKey]).toBe(10);
  });

  it.each([
    { source: "option", concurrency: 3, env: {} },
    {
      source: "environment",
      concurrency: undefined,
      env: { OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "3" },
    },
    { source: "default", concurrency: undefined, env: {} },
  ])(
    "bounds $source workers and restored cache slots to actual plans",
    async ({ env, concurrency }) => {
      const persistentRoot = makeScratchDir();
      const seed = path.join(persistentRoot, "vitest-cache-0");
      mkdirSync(seed);
      writeFileSync(path.join(seed, "transform"), "cached", "utf8");
      const seen: string[] = [];
      const exitCode = await runShardPlans(
        [{ kind: "group", name: "one", plan: { configs: ["one.config.ts"] } }],
        {
          concurrency,
          env: { ...env, OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: persistentRoot },
          scratchDir: makeScratchDir(),
          runChild: async (_args, childEnv) => {
            seen.push(childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH ?? "");
            return 0;
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(seen).toEqual([seed]);
      expect(readdirSync(persistentRoot)).toEqual(["vitest-cache-0"]);
    },
  );

  it.each([Number.NaN, 0, 1.5])(
    "rejects invalid concurrency %s before scheduling plans",
    async (concurrency) => {
      let runs = 0;
      await expect(
        runShardPlans([{ kind: "group", name: "one", plan: { configs: ["one.config.ts"] } }], {
          concurrency,
          env: {},
          scratchDir: makeScratchDir(),
          runChild: async () => {
            runs += 1;
            return 0;
          },
        }),
      ).rejects.toThrow("Shard plan concurrency must be a positive integer");
      expect(runs).toBe(0);
    },
  );

  it("runs per-config groups serially through one persistent cache slot", async () => {
    const scratchDir = makeScratchDir();
    const persistentRoot = path.join(makeScratchDir(), "persistent");
    mkdirSync(persistentRoot, { recursive: true });
    const seen: Array<{ args: string[]; cache: string | undefined; label: string }> = [];
    let active = 0;
    let peakActive = 0;

    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
          ["a", "b", "c"].map((name) => ({
            configs: [`${name}.config.ts`],
            shard_name: `cache-warm:${name}`,
          })),
        ),
      }),
      {
        concurrency: 1,
        env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: persistentRoot },
        runChild: async (
          args: string[],
          childEnv: Record<string, string | undefined>,
          label: string,
        ) => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          seen.push({
            args,
            cache: childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH,
            label,
          });
          active -= 1;
          return 0;
        },
        scratchDir,
      },
    );

    expect(exitCode).toBe(0);
    expect(peakActive).toBe(1);
    expect(seen.map((run) => run.args)).toEqual([
      ["a.config.ts"],
      ["b.config.ts"],
      ["c.config.ts"],
    ]);
    expect(seen.map((run) => run.label)).toEqual(["cache-warm:a", "cache-warm:b", "cache-warm:c"]);
    expect(new Set(seen.map((run) => run.cache))).toEqual(
      new Set([path.join(persistentRoot, "vitest-cache-0")]),
    );
  });

  it("forwards job and group Vitest arguments without leaking them to sibling plans", async () => {
    const scratchDir = makeScratchDir();
    const seen: string[][] = [];
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify([
          {
            configs: ["test/vitest/vitest.extensions.config.ts"],
            env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--shard=1/6"]) },
          },
          { configs: ["test/vitest/vitest.unit.config.ts"] },
        ]),
      }),
      {
        concurrency: 1,
        env: {
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(["--hookTimeout=300000"]),
        },
        runChild: async (args: string[]) => {
          seen.push(args);
          return 0;
        },
        scratchDir,
      },
    );

    expect(exitCode).toBe(0);
    expect(seen).toEqual([
      ["test/vitest/vitest.extensions.config.ts", "--", "--hookTimeout=300000", "--shard=1/6"],
      ["test/vitest/vitest.unit.config.ts", "--", "--hookTimeout=300000"],
    ]);
  });

  it("reuses isolated persistent cache slots across serial work", async () => {
    const scratchDir = makeScratchDir();
    const persistentRoot = path.join(makeScratchDir(), "persistent");
    mkdirSync(persistentRoot, { recursive: true });
    const seenCaches = new Set<string>();
    const activeCaches = new Set<string>();
    let sharedWriter = false;
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
          ["a", "b", "c", "d"].map((name) => ({
            configs: [`${name}.config.ts`],
            shard_name: name,
          })),
        ),
      }),
      {
        concurrency: 2,
        env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: persistentRoot },
        runChild: async (_args: string[], childEnv: Record<string, string | undefined>) => {
          const cache = childEnv.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH ?? "";
          if (activeCaches.has(cache)) {
            sharedWriter = true;
          }
          activeCaches.add(cache);
          seenCaches.add(cache);
          await Promise.resolve();
          activeCaches.delete(cache);
          return 0;
        },
        scratchDir,
      },
    );

    expect(exitCode).toBe(0);
    expect(sharedWriter).toBe(false);
    expect([...seenCaches].toSorted()).toEqual([
      path.join(persistentRoot, "vitest-cache-0"),
      path.join(persistentRoot, "vitest-cache-1"),
    ]);
  });

  it("clones a restored persistent seed into every concurrent cache slot", () => {
    const persistentRoot = makeScratchDir();
    const seed = path.join(persistentRoot, "vitest-cache-0");
    mkdirSync(seed, { recursive: true });
    writeFileSync(path.join(seed, "transform"), "cached", "utf8");
    const staleSlot = path.join(persistentRoot, "vitest-cache-1");
    mkdirSync(staleSlot, { recursive: true });
    writeFileSync(path.join(staleSlot, "stale"), "old", "utf8");

    expect(clonePersistentCacheSlots(persistentRoot, 3)).toBe(2);
    for (const cacheSlot of [1, 2]) {
      expect(
        readFileSync(path.join(persistentRoot, `vitest-cache-${cacheSlot}`, "transform"), "utf8"),
      ).toBe("cached");
    }
    expect(existsSync(path.join(staleSlot, "stale"))).toBe(false);
  });

  it("prunes oldest transform entries while preserving Vitest metadata", () => {
    const persistentRoot = makeScratchDir();
    const slot = path.join(persistentRoot, "vitest-cache-0");
    mkdirSync(slot, { recursive: true });
    const metadata = path.join(slot, "_metadata.json");
    const generation = path.join(persistentRoot, ".openclaw-transform-generation");
    const oldest = path.join(slot, "oldest");
    const newest = path.join(slot, "newest");
    writeFileSync(metadata, "{}", "utf8");
    writeFileSync(generation, "g", "utf8");
    writeFileSync(oldest, "aaaaaaaa", "utf8");
    writeFileSync(newest, "bbbbbbbb", "utf8");
    utimesSync(oldest, new Date(1_000), new Date(1_000));
    utimesSync(newest, new Date(2_000), new Date(2_000));

    expect(pruneFsModuleCache(persistentRoot, 16)).toEqual({
      beforeBytes: 19,
      afterBytes: 11,
      removedFiles: 1,
    });
    expect(existsSync(metadata)).toBe(true);
    expect(existsSync(generation)).toBe(true);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it("prunes persistent caches only in the designated writer job", async () => {
    const persistentRoot = makeScratchDir();
    const transform = path.join(persistentRoot, "vitest-cache-0", "entry");
    mkdirSync(path.dirname(transform), { recursive: true });
    writeFileSync(transform, "cached", "utf8");
    const plans = resolveShardPlans({
      OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(["test/vitest/vitest.unit.config.ts"]),
    });
    const run = (writer: string) =>
      runShardPlans(plans, {
        concurrency: 1,
        env: {
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: persistentRoot,
          OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER: writer,
        },
        fsModuleCacheMaxBytes: 0,
        runChild: async () => 0,
        scratchDir: makeScratchDir(),
      });

    await run("0");
    expect(existsSync(transform)).toBe(true);
    await run("1");
    expect(existsSync(transform)).toBe(false);
  });

  it.each(["exit", "rejection"] as const)(
    "joins admitted plans and stops scheduling after a %s failure",
    async (failure) => {
      const started: string[] = [];
      const held = createDeferred();
      const failed = createDeferred();
      const children: Promise<number>[] = [];
      const error = new Error("second child rejected");
      let settled = false;
      const pending = runShardPlans(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
            ["a", "b", "c", "d"].map((name) => ({
              configs: [`${name}.config.ts`],
              shard_name: name,
            })),
          ),
        }),
        {
          concurrency: 2,
          env: {},
          scratchDir: makeScratchDir(),
          runChild: (_args, _env, label) => {
            const child = (async () => {
              started.push(label);
              if (label === "a") {
                await held.promise;
              }
              if (label === "b") {
                failed.resolve();
                if (failure === "rejection") {
                  throw error;
                }
                return 7;
              }
              return 0;
            })();
            children.push(child);
            return child;
          },
        },
      )
        .then(
          (exitCode) => ({ exitCode, error: undefined }),
          (cause: unknown) => ({ exitCode: undefined, error: cause }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await failed.promise;
        await nextTurn();
        expect(settled).toBe(false);
        expect(started).toEqual(["a", "b"]);
      } finally {
        held.resolve();
        await nextTurn();
        await Promise.allSettled(children);
        await pending;
      }
      const outcome = await pending;
      if (failure === "rejection") {
        expect(outcome.error).toBe(error);
      } else {
        expect(outcome.exitCode).toBe(7);
      }
      expect(started).toEqual(["a", "b"]);
    },
  );

  it("continues through failed plans only when explicitly requested", async () => {
    const started: string[] = [];
    const exitCode = await runShardPlans(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(
          ["a", "b", "c", "d"].map((name) => ({
            configs: [`${name}.config.ts`],
            shard_name: name,
          })),
        ),
      }),
      {
        concurrency: 1,
        continueOnFailure: true,
        env: {},
        runChild: async (_args, _env, label) => {
          started.push(label);
          return label === "b" ? 7 : label === "d" ? 9 : 0;
        },
        scratchDir: makeScratchDir(),
      },
    );

    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(exitCode).toBe(7);
  });

  it.each([
    { continueOnFailure: false, expectedStarted: [] },
    { continueOnFailure: true, expectedStarted: ["next"] },
  ])(
    "fails a malformed plan with continuation=$continueOnFailure",
    async ({ continueOnFailure, expectedStarted }) => {
      const started: string[] = [];
      const exitCode = await runShardPlans(
        [
          { kind: "group" as const, name: "broken", plan: { configs: [] } },
          { kind: "group" as const, name: "next", plan: { configs: ["next.config.ts"] } },
        ],
        {
          concurrency: 1,
          continueOnFailure,
          env: {},
          runChild: async (_args, _env, label) => {
            started.push(label);
            return 0;
          },
          scratchDir: makeScratchDir(),
        },
      );

      expect(exitCode).toBe(1);
      expect(started).toEqual(expectedStarted);
    },
  );
});
