import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { TestSpecification } from "vitest/node";
import { RepoE2eSequencer } from "../vitest/vitest.e2e.sequencer.ts";
import { selectWeightedShard } from "../vitest/vitest.weighted-sharding.ts";

const { timings } = vi.hoisted(() => ({ timings: {} as Record<string, number> }));
vi.mock("../../scripts/lib/ci-test-timings.mts", () => ({
  readRepoE2eFileTimings: () => timings,
}));

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const key of Object.keys(timings)) {
    delete timings[key];
  }
});

function testFiles(sizes: number[]): TestSpecification[] {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-sharding-")));
  directories.push(directory);
  return sizes.map((bytes, index) => {
    const moduleId = path.join(directory, `${index}.e2e.test.ts`);
    writeFileSync(moduleId, "x".repeat(bytes));
    return { moduleId } as TestSpecification;
  });
}

async function gatewayShards(files: TestSpecification[], count: number) {
  return Promise.all(
    Array.from({ length: count }, (_, offset) => {
      const context = { config: { shard: { count, index: offset + 1 } } };
      return new RepoE2eSequencer(
        context as unknown as ConstructorParameters<typeof RepoE2eSequencer>[0],
      ).shard(files);
    }),
  );
}

it("balances the measured tail while retaining every discovered file exactly once", async () => {
  const files = testFiles([100, 100, 100]);
  for (const [index, seconds] of [
    [0, 100],
    [1, 20],
  ] as const) {
    timings[path.relative(repoRoot, files[index]!.moduleId).replaceAll("\\", "/")] = seconds!;
  }
  timings["test/deleted.e2e.test.ts"] = 900;
  const shards = await gatewayShards(files, 2);
  // The unmeasured file inherits 60 seconds from the discovered 120s/200-byte
  // sample. Equal file-count hashing cannot enforce this 100s/80s split.
  expect(shards).toEqual([[files[0]], [files[2], files[1]]]);
  expect(shards.flat()).toHaveLength(files.length);
  expect(new Set(shards.flat())).toEqual(new Set(files));
  expect(await gatewayShards(files.toReversed(), 2)).toEqual(shards);
});

it("uses source bytes for every file when timing data is absent", async () => {
  const files = testFiles([100, 80, 20]);
  expect(await gatewayShards(files, 2)).toEqual([[files[0]], [files[1], files[2]]]);
  const added = testFiles([120])[0]!;
  const shards = await gatewayShards([...files, added], 2);
  expect(shards.flat()).toHaveLength(4);
  expect(new Set(shards.flat())).toEqual(new Set([...files, added]));
});

it("keeps shared UI/Gateway partition ties deterministic without collapsing specifications", () => {
  const files = testFiles([1, 1, 1]);
  const secondProject = { ...files[0] } as TestSpecification;
  const discovered = [...files, secondProject];
  const shards = [1, 2].map((index) =>
    selectWeightedShard(discovered, { index, count: 2 }, () => 1),
  );
  expect(shards.map((files) => files.length)).toEqual([2, 2]);
  expect(shards.flat()).toHaveLength(discovered.length);
  expect(new Set(shards.flat())).toEqual(new Set(discovered));
});
