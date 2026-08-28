import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refitTestTimings, type CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import {
  ciTestTimingsSchema,
  type CiTestTimings,
} from "../../scripts/lib/ci-test-timings-schema.mts";

function uiLog(files: Record<string, number>, overhead = 0.6) {
  const body = Object.values(files).reduce((sum, value) => sum + value, 0);
  return [
    ...Object.entries(files).map(
      ([name, value]) =>
        `2026-08-27T23:00:00Z ✓ \u001b[32mui-e2e\u001b[0m ${name} (1 test) ${value * 1000}ms`,
    ),
    `Duration ${body + Object.keys(files).length * overhead}s (transform 1s, setup 2ms, import 3s, tests ${body}s, environment 1ms)`,
  ].join("\n");
}

function timingRun(id: number, logs: CiTimingRun["logs"]): CiTimingRun {
  return { id, createdAt: `2026-08-${String(20 + id).padStart(2, "0")}T23:00:00Z`, logs };
}

function compactLog(seconds: number, key = "core-unit-src-security-2") {
  const end = new Date(Date.parse("2026-08-27T23:00:00Z") + seconds * 1000).toISOString();
  return [
    `2026-08-27T23:00:00.0000000Z [shard:${key}] begin`,
    `${end} [shard:${key}] end (exit 0)`,
    "2026-08-27T23:00:00Z [shard:failed] begin",
    `${end} [shard:failed] end (exit 1)`,
    "2026-08-27T23:00:00Z [shard:unfinished] begin",
    `${end} [shard:orphan] end (exit 0)`,
  ].join("\n");
}

const measuredFile = "ui/src/e2e/measured.e2e.test.ts";
const baseline: CiTestTimings = {
  compactGroupSeconds: { blacksmith: {}, github: {} },
  source: "median of 2 successful main CI runs: 1, 2",
  uiE2e: { fileSeconds: { [measuredFile]: 100 }, perFileOverheadSeconds: 0.6 },
  updatedAt: "2026-08-22",
  version: 1,
};

it("rejects non-plain timing objects even when their fields are valid", () => {
  expect(() =>
    ciTestTimingsSchema.parse(
      Object.create({ inherited: true }, Object.getOwnPropertyDescriptors(baseline)),
    ),
  ).toThrow();
  expect(() =>
    ciTestTimingsSchema.parse({
      ...baseline,
      uiE2e: {
        ...baseline.uiE2e,
        fileSeconds: Object.create(
          { inherited: 1 },
          { measured: { value: 100, enumerable: true } },
        ),
      },
    }),
  ).toThrow();
});

describe("CI test timing refit", () => {
  it("records per-file medians without outliers or one-run weights and measures excluded overhead", () => {
    const pageFile = "ui/src/pages/settings/measured.e2e.test.ts";
    const singleFile = "ui/src/e2e/single.e2e.test.ts";
    const runs = [32, 34, 60, 33, 900].map((value, index) =>
      timingRun(index + 1, [
        { kind: "uiE2e", text: uiLog({ [measuredFile]: value, [pageFile]: 2 }, 0.64) },
      ]),
    );
    runs[0]!.logs.push({
      kind: "uiE2e",
      text: `ui-e2e ${singleFile} (20 tests) 3s\nui-e2e ${singleFile} (20 tests) 3s`,
    });

    const { timings } = refitTestTimings(runs);

    expect(timings.uiE2e).toEqual({
      fileSeconds: { [measuredFile]: 34, [pageFile]: 2 },
      perFileOverheadSeconds: 0.6,
    });
    expect(ciTestTimingsSchema.parse(timings)).toEqual(timings);
  });

  it("buckets successful compact spans by their job runner and excludes failed or incomplete spans", () => {
    const runs = [10, 20, 100].map((value, index) =>
      timingRun(index + 1, [
        {
          kind: "compact",
          labels: ["self-hosted", `blacksmith-${index === 0 ? 4 : 8}vcpu-ubuntu-2404`],
          text: compactLog(value),
        },
        {
          kind: "compact",
          labels: ["ubuntu-24.04"],
          text: `${compactLog(40 + index * 10)}\nBLACKSMITH_RUN_ID: misleading-log-text`,
        },
      ]),
    );

    expect(refitTestTimings(runs).timings.compactGroupSeconds).toEqual({
      blacksmith: { "core-unit-src-security-2": 15 },
      github: { "core-unit-src-security-2": 50 },
    });
  });

  it.each([0, 1, 2, 3])(
    "prunes absent keys only after at least three contributing runs per profile (%s)",
    (count) => {
      const previous: CiTestTimings = {
        ...baseline,
        compactGroupSeconds: {
          blacksmith: { observed: 20, deleted: 30 },
          github: { observed: 20, deleted: 40 },
        },
        uiE2e: {
          ...baseline.uiE2e,
          fileSeconds: { ...baseline.uiE2e.fileSeconds, "deleted.e2e.test.ts": 50 },
        },
      };
      const runs = [1, 2, 3].map((id) => {
        const logs: CiTimingRun["logs"] = [
          {
            kind: "compact",
            labels: ["blacksmith-4vcpu-ubuntu-2404"],
            text: compactLog(20, "observed"),
          },
        ];
        if (id <= count) {
          logs.push(
            { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(20, "observed") },
            { kind: "uiE2e", text: uiLog({ [measuredFile]: 100 }) },
          );
        }
        return timingRun(id, logs);
      });
      const { timings, changes } = refitTestTimings(runs, previous);
      expect(timings.compactGroupSeconds.blacksmith).toEqual({ observed: 20 });
      expect(timings.compactGroupSeconds.github).toEqual(
        count >= 3 ? { observed: 20 } : previous.compactGroupSeconds.github,
      );
      expect(timings.uiE2e.fileSeconds).toEqual(
        count >= 3 ? { [measuredFile]: 100 } : previous.uiE2e.fileSeconds,
      );
      expect(changes).toEqual(
        count >= 3
          ? [
              { key: "compactGroupSeconds.blacksmith.deleted", old: 30, next: undefined },
              { key: "compactGroupSeconds.github.deleted", old: 40, next: undefined },
              { key: "uiE2e.fileSeconds.deleted.e2e.test.ts", old: 50, next: undefined },
            ]
          : [{ key: "compactGroupSeconds.blacksmith.deleted", old: 30, next: undefined }],
      );
    },
  );

  it.each(["missing", "unparseable"])(
    "preserves all profiles when three sampled runs have %s logs",
    (logs) => {
      const previous: CiTestTimings = {
        ...baseline,
        compactGroupSeconds: { blacksmith: { group: 50 }, github: { g1: 181, g2: 90 } },
      };
      const runs = [1, 2, 3].map((id) =>
        timingRun(
          id,
          logs === "missing" ? [] : [{ kind: "uiE2e", text: "No test results available" }],
        ),
      );
      expect(refitTestTimings(runs, previous)).toMatchObject({ timings: previous, changes: [] });
    },
  );

  it.each([1, 2])("keeps keys observed in %s of three runs", (observedRuns) => {
    const otherFile = "ui/src/e2e/other.e2e.test.ts";
    const previous: CiTestTimings = {
      ...baseline,
      uiE2e: { ...baseline.uiE2e, fileSeconds: { [measuredFile]: 100, [otherFile]: 100 } },
      compactGroupSeconds: {
        blacksmith: { "core-unit-src-security-2": 30, other: 30 },
        github: { "core-unit-src-security-2": 30, other: 30 },
      },
    };
    const runs = [1, 2, 3].map((id) =>
      timingRun(
        id,
        id > observedRuns
          ? [
              { kind: "uiE2e", text: uiLog({ [otherFile]: 100 }) },
              {
                kind: "compact",
                labels: ["blacksmith-4vcpu-ubuntu-2404"],
                text: compactLog(30, "other"),
              },
              { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(30, "other") },
            ]
          : [
              { kind: "uiE2e", text: uiLog({ [measuredFile]: 100 }) },
              { kind: "compact", labels: ["blacksmith-4vcpu-ubuntu-2404"], text: compactLog(30) },
              { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(30) },
            ],
      ),
    );
    expect(refitTestTimings(runs, previous)).toMatchObject({ timings: previous, changes: [] });
  });

  it.each([
    [85, 100],
    [115, 100],
    [84, 84],
    [116, 116],
  ])("only writes medians outside the inclusive 15%% band: %s becomes %s", (measured, expected) => {
    const previous = {
      ...baseline,
      uiE2e: {
        ...baseline.uiE2e,
        fileSeconds: { ...baseline.uiE2e.fileSeconds, "ui/src/e2e/absent.e2e.test.ts": 20 },
      },
    };
    const runs = [1, 2].map((id) =>
      timingRun(id, [{ kind: "uiE2e", text: uiLog({ [measuredFile]: measured }) }]),
    );
    const { timings, changes } = refitTestTimings(runs, previous);

    expect(timings.uiE2e.fileSeconds).toEqual({
      [measuredFile]: expected,
      "ui/src/e2e/absent.e2e.test.ts": 20,
    });
    expect(changes).toHaveLength(expected === 100 ? 0 : 1);
    if (expected === 100) {
      expect(timings.source).toBe(previous.source);
      expect(timings.updatedAt).toBe(previous.updatedAt);
    }
  });

  it("applies the overhead write threshold before rounding to a tenth", () => {
    const runs = [1, 2].map((id) =>
      timingRun(id, [{ kind: "uiE2e", text: uiLog({ [measuredFile]: 100 }, 0.69) }]),
    );
    const { timings, changes } = refitTestTimings(runs, baseline);
    expect(timings.uiE2e.perFileOverheadSeconds).toBe(0.6);
    expect(changes).toEqual([]);
  });

  it.each([
    [-2, 0],
    [8, 5],
  ])("clamps measured overhead %s to %s seconds", (measured, expected) => {
    const runs = [1, 2].map((id) =>
      timingRun(id, [{ kind: "uiE2e", text: uiLog({ [measuredFile]: 10 }, measured) }]),
    );
    expect(refitTestTimings(runs).timings.uiE2e.perFileOverheadSeconds).toBe(expected);
  });

  it("generates identical sorted data when equivalent runs, logs, and file rows arrive in different orders", () => {
    const files = { "ui/src/e2e/z.e2e.test.ts": 5, "ui/src/e2e/a.e2e.test.ts": 4 };
    const runs = [2, 1].map((id) =>
      timingRun(id, [
        { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(20) },
        { kind: "uiE2e", text: uiLog(files) },
      ]),
    );
    const first = refitTestTimings(runs);
    const reordered = runs.toReversed().map((run) => ({
      ...run,
      logs: [
        {
          kind: "uiE2e" as const,
          text: uiLog(Object.fromEntries(Object.entries(files).toReversed())),
        },
        { kind: "compact" as const, labels: ["ubuntu-24.04"], text: compactLog(20) },
      ],
    }));

    expect(JSON.stringify(refitTestTimings(reordered))).toBe(JSON.stringify(first));
    expect(Object.keys(first.timings)).toEqual(Object.keys(first.timings).toSorted());
    expect(Object.keys(first.timings.uiE2e.fileSeconds)).toEqual([
      "ui/src/e2e/a.e2e.test.ts",
      "ui/src/e2e/z.e2e.test.ts",
    ]);
    expect(
      refitTestTimings(
        runs.map((run) => ({ ...run, id: run.id + 2 })),
        first.timings,
      ).timings,
    ).toEqual(first.timings);
  });

  it.each([
    { label: "main push retries", metadata: {}, invalidField: undefined },
    {
      label: "manual dispatch from main",
      metadata: { event: "workflow_dispatch" },
      invalidField: "event",
    },
    {
      label: "push to another branch",
      metadata: { head_branch: "feature" },
      invalidField: "head_branch",
    },
    { label: "missing head commit", metadata: { head_sha: null }, invalidField: "head_sha" },
  ])(
    "validates $label before fetching samples and preserves dry-run/unchanged bytes",
    ({ metadata, invalidField }) => {
      const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-ci-refit-")));
      const fakeGh = path.join(directory, "gh");
      const output = path.join(directory, "timings.json");
      const requests = path.join(directory, "requests.json");
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const log = uiLog({ [measuredFile]: 130 });
      writeFileSync(
        fakeGh,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = args[1];
if (args[0] === "api" && args[1] === "--help") {
  console.log("--allow-escape-sequences");
} else if (endpoint.replace("&event=push", "") === "repos/fixture/repo/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=3&page=1") {
  if (!args.includes("--jq")) process.exit(2);
  require("node:fs").writeFileSync(${JSON.stringify(requests)}, JSON.stringify(args));
  console.log(JSON.stringify([1, 2, 3].map(id => ({id, created_at: "2026-08-27T23:00:00Z", status: "completed", conclusion: "success", event: "push", head_branch: "main", head_sha: "a".repeat(40), run_attempt: 2, ...${JSON.stringify(metadata)}}))));
} else if (endpoint.includes("actions/runs/") && endpoint.includes("/jobs?filter=all&")) {
  if (!args.at(-1).includes("labels")) process.exit(2);
  const jobs = endpoint.endsWith("page=1")
    ? [{id: 1, name: "unrelated", conclusion: "success"}, {id: 2, name: "checks-ui-e2e (2/11)", conclusion: "failure"}]
    : [{id: 3, name: "checks-ui-e2e (1/11)", conclusion: "success"},
       {id: 4, name: "checks-node-compact-small (1)", conclusion: "success", labels: ["blacksmith-4vcpu-ubuntu-2404"]},
       {id: 5, name: "checks-node-compact-small (1)", conclusion: "success", labels: ["ubuntu-24.04"]},
       {id: 6, name: "checks-node-compact-small (1)", conclusion: "success", labels: ["ubuntu-24.04"]}];
  console.log(JSON.stringify({ total_count: 6, jobs: jobs.map(job => ({labels: ["ubuntu-24.04"], ...job})) }));
} else if (endpoint.endsWith("actions/jobs/3/logs")) {
  if (!args.includes("--allow-escape-sequences")) process.exit(2);
  console.log(${JSON.stringify(log)});
} else if (endpoint.endsWith("actions/jobs/4/logs")) {
  console.log(${JSON.stringify(compactLog(20))});
} else if (endpoint.endsWith("actions/jobs/5/logs")) {
  console.log(${JSON.stringify(compactLog(40))});
} else if (endpoint.endsWith("actions/jobs/6/logs")) {
  console.log(${JSON.stringify(compactLog(60))});
} else {
  console.error("Unexpected gh request", args);
  process.exit(2);
}
`,
      );
      chmodSync(fakeGh, 0o755);
      const original = `${JSON.stringify(
        {
          ...baseline,
          compactGroupSeconds: { blacksmith: { deleted: 30 }, github: {} },
        },
        null,
        2,
      )}\n`;
      writeFileSync(output, original);
      const invoke = (dryRun: boolean) =>
        spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/ci-refit-test-timings.mts",
            "--runs",
            "3",
            "--repo",
            "fixture/repo",
            "--out",
            output,
            ...(dryRun ? ["--dry-run"] : []),
          ],
          {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, OPENCLAW_GH_BIN: fakeGh, GH_TOKEN: "fixture-token" },
          },
        );
      try {
        const dryRun = invoke(true);
        if (invalidField) {
          expect(dryRun.status, dryRun.stderr).toBe(1);
          expect(dryRun.stderr).toContain(invalidField);
          expect(dryRun.stdout).not.toContain("Sampled successful main CI runs");
          expect(readFileSync(output, "utf8")).toBe(original);
          return;
        }
        expect(dryRun.status, dryRun.stderr).toBe(0);
        expect(JSON.parse(readFileSync(requests, "utf8"))).toEqual([
          "api",
          "repos/fixture/repo/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=3&page=1",
          "--jq",
          "[.workflow_runs[] | {id, created_at, status, conclusion, event, head_branch, head_sha}]",
        ]);
        expect(dryRun.stdout).toContain(
          `| uiE2e.fileSeconds.${measuredFile} | 100 | 130 | 30.0% |`,
        );
        expect(dryRun.stdout).toContain(
          "| compactGroupSeconds.blacksmith.deleted | 30 | — | removed |",
        );
        expect(dryRun.stdout).toContain("Sampled successful main CI runs: 1, 2, 3");
        expect(readFileSync(output, "utf8")).toBe(original);
        const write = invoke(false);
        expect(write.status, write.stderr).toBe(0);
        const updated = readFileSync(output, "utf8");
        const timings = ciTestTimingsSchema.parse(JSON.parse(updated));
        expect(timings.uiE2e.fileSeconds[measuredFile]).toBe(130);
        expect(timings.compactGroupSeconds).toEqual({
          blacksmith: { "core-unit-src-security-2": 20 },
          github: { "core-unit-src-security-2": 50 },
        });
        expect(updated.endsWith("\n")).toBe(true);
        const unchanged = invoke(false);
        expect(unchanged.status, unchanged.stderr).toBe(0);
        expect(unchanged.stdout).toContain("No timing changes");
        expect(readFileSync(output, "utf8")).toBe(updated);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("committed CI timing loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function readTimings(contents: string | Error) {
    vi.resetModules();
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
    const original = fs.readFileSync;
    const timingPath = fileURLToPath(new URL("../../config/ci-test-timings.json", import.meta.url));
    const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if ((file instanceof URL ? fileURLToPath(file) : file) === timingPath) {
        if (contents instanceof Error) {
          throw contents;
        }
        return contents;
      }
      return original(file, options);
    });
    syncBuiltinESMExports();
    const loader = await import("../../scripts/lib/ci-test-timings.mts");
    return { loader, read, timingPath };
  }

  const invalidFiles: Array<[string, string | Error]> = [
    ["missing", new Error("ENOENT")],
    ["unreadable", new Error("EACCES")],
    ["truncated", '{"version":1'],
    ["non-object root", "null"],
    ["wrong version", JSON.stringify({ ...baseline, version: 2 })],
    ["unknown root key", JSON.stringify({ ...baseline, extra: 1 })],
    ["empty source", JSON.stringify({ ...baseline, source: "" })],
    ...["2026-02-29", "1900-02-29", "2026-04-31", "2026-8-22", "2026-08-22T00:00:00Z"].map(
      (updatedAt): [string, string] => [
        `invalid date ${updatedAt}`,
        JSON.stringify({ ...baseline, updatedAt }),
      ],
    ),
    ["unknown UI key", JSON.stringify({ ...baseline, uiE2e: { ...baseline.uiE2e, extra: 1 } })],
    [
      "unknown compact profile",
      JSON.stringify({
        ...baseline,
        compactGroupSeconds: { ...baseline.compactGroupSeconds, extra: {} },
      }),
    ],
    ["missing profile", JSON.stringify({ ...baseline, compactGroupSeconds: { blacksmith: {} } })],
    ...["ui", "blacksmith", "github"].flatMap((profile) =>
      [
        null,
        [],
        { "": 1 },
        ...[0, -1, "2", null, 1.2, Number.MAX_SAFE_INTEGER + 1].map((seconds) => ({
          valid: 100,
          invalid: seconds,
        })),
      ].map((seconds): [string, string] => [
        `invalid ${profile} map ${JSON.stringify(seconds)}`,
        JSON.stringify(
          profile === "ui"
            ? { ...baseline, uiE2e: { ...baseline.uiE2e, fileSeconds: seconds } }
            : {
                ...baseline,
                compactGroupSeconds: {
                  blacksmith: { valid: 100 },
                  github: { valid: 100 },
                  [profile]: seconds,
                },
              },
        ),
      ]),
    ),
    ["non-finite seconds", JSON.stringify(baseline).replace(":100", ":1e999")],
    ...[-1, 5.1, null, "1"].map((overhead): [string, string] => [
      `invalid overhead ${String(overhead)}`,
      JSON.stringify({
        ...baseline,
        uiE2e: { ...baseline.uiE2e, perFileOverheadSeconds: overhead },
      }),
    ]),
    ["non-finite overhead", JSON.stringify(baseline).replace(":0.6", ":1e999")],
  ];

  it.each(invalidFiles)("ignores the entire %s file without throwing", async (_name, contents) => {
    const { loader } = await readTimings(contents);
    expect(loader.readUiE2eFileTimings()).toEqual({ fileSeconds: {}, perFileOverheadSeconds: 0 });
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({});
    expect(loader.readCompactGroupTimings("github")).toEqual({});
  });

  it.each([0, 5])(
    "accepts overhead boundary %s, safe integers and leap dates",
    async (overhead) => {
      const data = {
        ...baseline,
        updatedAt: "2000-02-29",
        uiE2e: {
          fileSeconds: { [measuredFile]: Number.MAX_SAFE_INTEGER },
          perFileOverheadSeconds: overhead,
        },
      };
      const { loader } = await readTimings(JSON.stringify(data));
      expect(loader.readUiE2eFileTimings()).toEqual(data.uiE2e);
    },
  );

  it("reads the repo-relative file once and honors the disable switch even after caching", async () => {
    const data = {
      ...baseline,
      compactGroupSeconds: { blacksmith: { group: 110 }, github: { group: 181 } },
    };
    const { loader, read, timingPath } = await readTimings(JSON.stringify(data));
    expect(loader.readUiE2eFileTimings()).toEqual(data.uiE2e);
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({ group: 110 });
    expect(loader.readCompactGroupTimings("github")).toEqual({ group: 181 });
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "0");
    expect(loader.readUiE2eFileTimings()).toEqual({ fileSeconds: {}, perFileOverheadSeconds: 0 });
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({});
    expect(loader.readCompactGroupTimings("github")).toEqual({});
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
    expect(loader.readCompactGroupTimings("github")).toEqual({ group: 181 });
    expect(
      read.mock.calls.filter(([file]) => file instanceof URL && fileURLToPath(file) === timingPath),
    ).toHaveLength(1);
  });
});
