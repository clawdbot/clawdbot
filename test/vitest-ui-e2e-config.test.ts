// Protect complete, deterministic UI E2E partitions and timing fallback precedence.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestSpecification } from "vitest/node";

const repoRoot = path.resolve(import.meta.dirname, "..");
const timingPath = path.join(repoRoot, "config/ci-test-timings.json");
const tempDirs: string[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function useTimings(contents: string | null) {
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if ((file instanceof URL ? fileURLToPath(file) : file) === timingPath) {
      if (contents === null) {
        throw new Error("ENOENT");
      }
      return contents;
    }
    return readFileSync(file, options);
  });
  syncBuiltinESMExports();
}

function timingFile(fileSeconds: Record<string, number>, perFileOverheadSeconds = 0.6) {
  return JSON.stringify({
    version: 1,
    updatedAt: "2026-08-27",
    source: "fixture measurements",
    uiE2e: { fileSeconds, perFileOverheadSeconds },
    compactGroupSeconds: { blacksmith: {}, github: {} },
  });
}

function specifications(paths: string[]): TestSpecification[] {
  return paths.map((moduleId) => ({ moduleId }) as TestSpecification);
}

function temporaryFiles(sizes: number[]): TestSpecification[] {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-e2e-shards-"));
  tempDirs.push(tempDir);
  return specifications(
    sizes.map((bytes, index) => {
      const moduleId = path.join(tempDir, `suite-${index}.e2e.test.ts`);
      fs.writeFileSync(moduleId, "x".repeat(bytes));
      return moduleId;
    }),
  );
}

async function partition(files: TestSpecification[], count = 11) {
  const { UiE2eSequencer } = await import("./vitest/vitest.ui-e2e.sequencer.ts");
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const sequencer = new UiE2eSequencer({
        config: { shard: { count, index: index + 1 } },
      } as never);
      return (await sequencer.shard(files)).map((file) => file.moduleId);
    }),
  );
}

describe("Control UI E2E Vitest sharding", () => {
  it("uses the duration weighted sequencer", async () => {
    const [{ default: config }, { UiE2eSequencer }] = await Promise.all([
      import("./vitest/vitest.ui-e2e.config.ts"),
      import("./vitest/vitest.ui-e2e.sequencer.ts"),
    ]);
    expect(config.test?.sequence?.sequencer).toBe(UiE2eSequencer);
  });

  it("balances unmeasured files by source bytes", async () => {
    useTimings(null);
    const shards = await partition(temporaryFiles([600, 500, 400, 300, 200, 100]), 3);
    expect(
      shards.map((shard) => shard.reduce((sum, file) => sum + fs.statSync(file).size, 0)),
    ).toEqual([700, 700, 700]);
  });

  it("uses repo-relative measurements before basename hints, then the byte proxy", async () => {
    const measured = "ui/src/pages/chat/chat-flow.clipboard.e2e.test.ts";
    const hinted = "ui/src/e2e/chat-flow.clipboard.e2e.test.ts";
    useTimings(timingFile({ [measured]: 1 }));
    const [large, small] = temporaryFiles([40 * 1024, 1024]);
    const files = [
      ...specifications([measured, hinted].map((file) => path.join(repoRoot, file))),
      large!,
      small!,
    ];
    const shards = await partition(files, 4);
    expect(shards).toEqual([
      [files[1]!.moduleId],
      [large!.moduleId],
      [files[0]!.moduleId],
      [small!.moduleId],
    ]);
  });

  it("charges per-file overhead so many small suites do not look free", async () => {
    useTimings(timingFile({}, 5));
    const files = temporaryFiles([10_000, 3_000, 3_000, 3_000]);
    const shards = await partition(files, 2);
    expect(shards).toEqual([
      [files[0]!.moduleId, files[3]!.moduleId],
      [files[1]!.moduleId, files[2]!.moduleId],
    ]);
  });

  it("assigns every discovered file once with committed timings, ignoring stale keys", async () => {
    const committed = fs.readFileSync(timingPath, "utf8");
    const files = specifications(
      fs
        .globSync("ui/src/**/*.e2e.test.ts", { cwd: repoRoot })
        .map((file) => path.join(repoRoot, file)),
    );
    expect(files.length).toBeGreaterThan(0);
    useTimings(committed);
    const original = await partition(files);
    // Validate via the production loader before adding a stale but valid weight.
    const { readUiE2eFileTimings } = await import("../scripts/lib/ci-test-timings.mts");
    const timings = readUiE2eFileTimings();
    expect(Object.keys(timings.fileSeconds).length).toBeGreaterThan(0);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.resetModules();
    useTimings(
      timingFile(
        { ...timings.fileSeconds, "ui/src/e2e/deleted.e2e.test.ts": 9999 },
        timings.perFileOverheadSeconds,
      ),
    );
    expect(await partition(files.toReversed())).toEqual(original);
    expect(original.flat().toSorted()).toEqual(files.map((file) => file.moduleId).toSorted());
    expect(new Set(original.flat()).size).toBe(files.length);
  });

  it.each([
    ["truncated JSON", '{"version":1'],
    ["wrong version", timingFile({}).replace('"version":1', '"version":2')],
    ["negative seconds", timingFile({ "ui/src/e2e/chat-flow.clipboard.e2e.test.ts": -1 })],
  ])("preserves the no-file partition with %s", async (_name, contents) => {
    const files = specifications(
      fs
        .globSync("ui/src/**/*.e2e.test.ts", { cwd: repoRoot })
        .map((file) => path.join(repoRoot, file)),
    );
    useTimings(null);
    const baseline = await partition(files);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.resetModules();
    useTimings(contents);
    const actual = await partition(files);
    expect(actual).toEqual(baseline);
    expect(actual.flat().toSorted()).toEqual(files.map((file) => file.moduleId).toSorted());
    expect(new Set(actual.flat()).size).toBe(files.length);
  });
});
