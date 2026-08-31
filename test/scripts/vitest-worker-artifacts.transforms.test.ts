import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createWorkerArtifactFixtures,
  workerProbe,
} from "./vitest-worker-artifacts.test-support.js";

const root = process.cwd();
const { fixtureLifetime, fixtureDirectory, createFixtureCommands } = createWorkerArtifactFixtures();

describe("fresh compiled subprocess invocation", () => {
  it.for(
    (["single", "projects"] as const).flatMap((layout) =>
      (["fresh generations", "source mode", "source and config edits"] as const).map(
        (invariant) => ({ layout, invariant }),
      ),
    ),
  )("preserves filesystem transforms for $invariant ($layout)", ({ layout, invariant }, context) =>
    fixtureLifetime.run(async () => {
      const { node } = createFixtureCommands(context);
      const directory = fixtureDirectory();
      const { config, value, configuredValue, parent, cacheDirectory } = workerProbe(
        directory,
        false,
        "auto",
        layout,
      );
      const readLines = (name: string) =>
        fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n");
      const counts = () => {
        const transformed = readLines("transforms.jsonl").map((line) =>
          path.normalize(JSON.parse(line)),
        );
        return [[value, configuredValue], [parent]].map(
          (ids) => transformed.filter((actual) => ids.includes(actual)).length,
        );
      };
      const generations: string[] = [];
      const launch = async (
        mode: "compiled" | "source",
        expectedValue = "first",
        configValue = "first",
      ) => {
        const result = await node([
          mode === "compiled" ? "scripts/run-vitest.mjs" : "node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          config,
          "--project",
          "first",
        ]);
        expect(result.code, result.stderr + result.stdout).toBe(0);
        const generation: string = JSON.parse(readLines("generations.jsonl").at(-1)!);
        const observed = JSON.parse(readLines("observations.jsonl").at(-1)!);
        expect(observed.value).toBe(expectedValue);
        expect(observed.configValue).toBe(configValue);
        if (mode === "compiled") {
          const generationDirectory = fileURLToPath(new URL("../../", generation));
          expect(result.stderr.match(/\[vitest-workers\] prepared/g)).toHaveLength(1);
          expect(generations).not.toContain(generation);
          generations.push(generation);
          expect(path.dirname(generationDirectory)).toBe(
            path.join(root, ".artifacts", "vitest-workers"),
          );
          expect(fileURLToPath(generation)).toBe(
            path.join(generationDirectory, "dist/infra/runtime-process-entrypoints.js"),
          );
          expect(observed.args[0]).toBe(
            path.join(generationDirectory, "dist/infra/sqlite-readonly-location.worker.js"),
          );
          expect(fileURLToPath(observed.knn)).toBe(
            path.join(
              generationDirectory,
              "dist/extensions/memory-core/manager-search-knn-entrypoint.js",
            ),
          );
          // Each completed repository invocation must dispose before the next starts.
          expect(fs.existsSync(generationDirectory)).toBe(false);
        } else {
          expect(result.stderr).not.toContain("[vitest-workers] prepared");
          expect(fileURLToPath(generation)).toBe(
            path.join(root, "src/infra/runtime-process-entrypoints.ts"),
          );
          expect(observed.args.slice(0, 2)).toEqual(["--import", "tsx"]);
          expect(fileURLToPath(observed.knn)).toBe(
            path.join(root, "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts"),
          );
        }
        console.log(
          "cache transport",
          JSON.stringify({ mode, ...observed, generation, transforms: counts() }),
        );
      };
      await launch("compiled");
      expect(counts()).toEqual([1, 1]);
      expect(
        JSON.parse(fs.readFileSync(path.join(cacheDirectory, "_metadata.json"), "utf8")),
      ).toEqual({ lockfileHash: expect.stringMatching(/^[a-f\d]{8}$/u) });
      if (invariant === "fresh generations") {
        await launch("compiled");
        expect(counts(), "unchanged parents must reuse filesystem transforms").toEqual([1, 1]);
      } else if (invariant === "source mode") {
        await launch("source");
        expect(counts()).toEqual([2, 2]);
        await launch("compiled");
        expect(counts()).toEqual([2, 2]);
      } else {
        fs.writeFileSync(value, 'export const value: string = "second";');
        await launch("compiled", "second");
        expect(counts()).toEqual([2, 1]);
        fs.writeFileSync(
          config,
          fs
            .readFileSync(config, "utf8")
            .replace(
              `replacement:${JSON.stringify(value)}`,
              `replacement:${JSON.stringify(configuredValue)}`,
            ),
        );
        await launch("compiled", "configured");
        expect(counts()).toEqual([3, 2]);
      }
    }),
  );
});
