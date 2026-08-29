import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findTsgoCoreTestShardViolations,
  selectTsgoCoreTestShards,
  selectTsgoCoreTestStripe,
  TSGO_CORE_TEST_SHARDS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";

describe("tsgo core test shards", () => {
  it("stripes partition the full shard list exactly once", () => {
    for (const stripeCount of [1, 2, 3, 5]) {
      const striped = Array.from(
        { length: stripeCount },
        (_, index) => selectTsgoCoreTestStripe(`${index + 1}/${stripeCount}`) ?? [],
      );
      expect(
        striped
          .flat()
          .map((shard) => shard.name)
          .toSorted(),
      ).toEqual(TSGO_CORE_TEST_SHARDS.map((shard) => shard.name).toSorted());
      // Round-robin keeps stripe sizes within one shard of each other.
      const sizes = striped.map((shards) => shards.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
    expect(selectTsgoCoreTestStripe("0/2")).toBeUndefined();
    expect(selectTsgoCoreTestStripe("3/2")).toBeUndefined();
    expect(selectTsgoCoreTestStripe("src")).toBeUndefined();
  });

  it("accepts an exact once-only partition within the root budget", () => {
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts"],
        maxRoots: 1,
        shards: [
          { name: "a", roots: ["src/a.test.ts"] },
          { name: "b", roots: ["src/b.test.ts"] },
        ],
      }),
    ).toEqual([]);
  });

  it("reports missing, duplicate, extra, and oversized shard roots", () => {
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts", "src/missing.test.ts"],
        maxRoots: 1,
        shards: [
          { name: "first", roots: ["src/a.test.ts", "src/b.test.ts"] },
          { name: "second", roots: ["src/b.test.ts", "src/extra.test.ts"] },
        ],
      }),
    ).toEqual([
      "first: 2 test roots exceeds the 1 limit",
      "second: 2 test roots exceeds the 1 limit",
      "assigned 2 times (first, second): src/b.test.ts",
      "unassigned: src/missing.test.ts",
      "not in the canonical core-test graph (second): src/extra.test.ts",
    ]);
  });

  it.each(["src", "ui", "packages"])(
    "retains shared extension declarations for the %s alias",
    (group) => {
      const shards = selectTsgoCoreTestShards(group);

      expect(shards?.at(-1)).toEqual({
        name: "extension-declarations",
        config: "test/tsconfig/tsconfig.test.extension-declarations.json",
        sparseRoots: ["extensions", "src", "ui/src"],
      });
    },
  );

  it("keeps the full core-test run scoped to its canonical shards", () => {
    expect(selectTsgoCoreTestShards()).not.toContainEqual(
      expect.objectContaining({ name: "extension-declarations" }),
    );
  });

  it("routes aggregate package aliases through bounded processes", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["tsgo:core:all"]).toContain("pnpm tsgo:core:test");
    expect(packageJson.scripts["tsgo:core:all"]).not.toContain("run-tsgo.mjs -b");
    expect(packageJson.scripts["tsgo:all"]).toContain("pnpm tsgo:core:all");
    expect(packageJson.scripts["tsgo:all"]).not.toContain("run-tsgo.mjs -b");
  });
});
