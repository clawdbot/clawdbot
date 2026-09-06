import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  shards: [] as Array<{ name: string; config: string; projects: string[] }>,
  timings: {} as Record<string, number>,
}));
vi.mock("../../test/vitest/vitest.test-shards.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../test/vitest/vitest.test-shards.mjs")>()),
  fullSuiteVitestShards: fixture.shards,
}));
vi.mock("../../scripts/lib/ci-test-timings.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/ci-test-timings.mts")>()),
  readCompactGroupTimings: () => fixture.timings,
}));
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";

type Mode = "runtime" | "private-qa" | undefined;
function setGroups(groups: Array<[string, Mode, number]>) {
  const config = (mode: Mode) =>
    mode === "private-qa"
      ? "test/vitest/vitest.extension-qa.config.ts"
      : mode === "runtime"
        ? "test/vitest/vitest.gateway-core.config.ts"
        : "test/vitest/vitest.unit-support.config.ts";
  fixture.shards.splice(
    0,
    fixture.shards.length,
    ...groups.map(([name, mode]) => ({
      name,
      config: `test/vitest/fixture-${name}.config.ts`,
      projects: [config(mode)],
    })),
  );
  fixture.timings = Object.fromEntries(groups.map(([name, , seconds]) => [name, seconds]));
}
function plan(runnerBackend = "blacksmith") {
  return createNodeTestShardBundles({
    compactMode: "pull-request",
    runnerBackend,
    includeReleaseOnlyPluginShards: false,
  });
}

describe("compact node prerequisite admission", () => {
  it.each([
    { name: "agentic-agents-core-models", measured: 123, blacksmith: [41, 123], hybrid: [81, 107] },
    { name: "core-unit-fast-1", measured: 100, blacksmith: [68, 100], hybrid: [59, 87] },
    { name: "core-runtime-hooks", measured: 80, blacksmith: [19, 80], hybrid: [17, 70] },
    {
      name: "core-runtime-infra-process",
      measured: undefined,
      blacksmith: [13, 13],
      hybrid: [35, 35],
    },
  ])("keeps $name estimates owned by its direct measurement or unmeasured hint", (owner) => {
    // Whole-config fixtures separate estimator precedence from file-count-dependent
    // ceiling rounding in the repository's hosted child stripes.
    for (const profile of ["blacksmith", "hybrid"] as const) {
      setGroups([[owner.name, undefined, 0]]);
      fixture.timings = {};
      const [fallback, measured] = owner[profile];
      expect(plan(profile).map((job) => job.predictedSeconds)).toEqual([fallback]);
      fixture.timings =
        owner.measured === undefined ? { unrelated: 999 } : { [owner.name]: owner.measured };
      const jobs = plan(profile);
      expect(jobs.map((job) => job.predictedSeconds)).toEqual([measured]);
      expect(jobs[0]?.groups.map((group) => group.shard_name)).toEqual([owner.name]);
    }
  });

  it("charges a shared runtime build once for two groups in one job", () => {
    setGroups([
      ["runtime-a", "runtime", 100],
      ["runtime-b", "runtime", 76],
    ]);
    const jobs = plan();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ predictedSeconds: 276, pretestBuildMode: "runtime" });
    expect(jobs[0]?.groups.map((group) => group.shard_name).toSorted()).toEqual([
      "runtime-a",
      "runtime-b",
    ]);
  });

  it("rejects an upgrade whose stronger prerequisite would exceed the bin cap", () => {
    setGroups([
      ["runtime", "runtime", 100],
      ["private", "private-qa", 76],
    ]);
    const jobs = plan();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => [job.pretestBuildMode, job.predictedSeconds])).toEqual(
      expect.arrayContaining([
        ["private-qa", 180],
        ["runtime", 200],
      ]),
    );
  });

  it("upgrades one shared build to private QA when it still fits", () => {
    setGroups([
      ["runtime", "runtime", 100],
      ["private", "private-qa", 72],
    ]);
    const jobs = plan();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ predictedSeconds: 276, pretestBuildMode: "private-qa" });
  });

  it("retains prerequisite sharing when admitting regular groups", () => {
    setGroups([
      ["runtime-a", "runtime", 100],
      ["runtime-b", "runtime", 20],
      ["plain-a", undefined, 150],
      ["plain-b", undefined, 80],
      ["plain-c", undefined, 40],
    ]);
    const jobs = plan();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.predictedSeconds).toSorted((a, b) => a! - b!)).toEqual([220, 270]);
    const runtime = jobs.find((job) => job.pretestBuildMode === "runtime");
    expect(runtime?.groups.map((group) => group.shard_name).toSorted()).toEqual([
      "runtime-a",
      "runtime-b",
    ]);
    expect(jobs.flatMap((job) => job.groups.map((group) => group.shard_name)).toSorted()).toEqual([
      "plain-a",
      "plain-b",
      "plain-c",
      "runtime-a",
      "runtime-b",
    ]);
  });

  it.each([
    { seconds: [180, 100, 20], parallelJobs: 1 },
    { seconds: [280, 20], parallelJobs: 2 },
  ])("shares ordinary job setup without adding work to oversized groups: $seconds", (sample) => {
    for (const profile of ["blacksmith", "github", "hybrid"]) {
      setGroups(sample.seconds.map((seconds, index) => [`plain-${index}`, undefined, seconds]));
      const jobs = plan(profile);
      expect(jobs).toHaveLength(profile === "github" ? 2 : sample.parallelJobs);
      if (jobs.length === 1) {
        expect(jobs[0]).toMatchObject({
          planConcurrency: 2,
          predictedSeconds: profile === "hybrid" ? 261 : 300,
          runner: "blacksmith-32vcpu-ubuntu-2404",
        });
        expect(jobs[0]?.pretestBuildMode).toBeUndefined();
      }
    }
  });

  it.each([
    { profile: "blacksmith", expected: 110, changed: 114 },
    { profile: "hybrid", expected: 109, changed: 112 },
    { profile: "github", expected: 170, changed: 174 },
  ])(
    "preserves direct $profile test measurements while adding the prerequisite",
    ({ profile, expected, changed }) => {
      setGroups([["runtime", "runtime", 10]]);
      expect(plan(profile)[0]?.predictedSeconds).toBe(expected);
      fixture.timings.runtime = 14;
      expect(plan(profile)[0]?.predictedSeconds).toBe(changed);
    },
  );
});

it("keeps admitted caps when runtime sharing competes with test balancing", () => {
  setGroups([
    ["runtime-a", "runtime", 160],
    ["runtime-b", "runtime", 10],
    ["plain-a", undefined, 150],
    ["plain-b", undefined, 20],
  ]);
  const jobs = plan();
  expect(jobs).toHaveLength(2);
  expect(jobs.every((job) => job.predictedSeconds! <= 276)).toBe(true);
  expect(jobs.flatMap((job) => job.groups.map((group) => group.shard_name)).toSorted()).toEqual([
    "plain-a",
    "plain-b",
    "runtime-a",
    "runtime-b",
  ]);
});
