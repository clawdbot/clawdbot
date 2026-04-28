import { describe, expect, it } from "vitest";
import {
  collectTsdownEntrySources,
  findRuntimeSidecarLoaderViolations,
} from "../../scripts/check-runtime-sidecar-loaders.mjs";

describe("check-runtime-sidecar-loaders", () => {
  it("flags hidden createRequire runtime sidecars that are not build entries", () => {
    const source = `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      export function loadRuntime() {
        return require("./missing.runtime.js");
      }
    `;

    expect(
      findRuntimeSidecarLoaderViolations(source, "src/tasks/task-registry.ts", new Set()),
    ).toEqual([
      {
        line: 5,
        specifier: "./missing.runtime.js",
        sourcePath: "src/tasks/missing.runtime.ts",
        reason:
          'hidden local runtime loader "./missing.runtime.js" resolves to src/tasks/missing.runtime.ts, but that source is not an explicit tsdown entry',
      },
    ]);
  });

  it("allows hidden createRequire runtime sidecars when the source is an explicit build entry", () => {
    const source = `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      export function loadRuntime() {
        return require("./task-registry-control.runtime.js");
      }
    `;

    expect(
      findRuntimeSidecarLoaderViolations(
        source,
        "src/tasks/task-registry.ts",
        new Set(["src/tasks/task-registry-control.runtime.ts"]),
      ),
    ).toEqual([]);
  });

  it("resolves candidate arrays used by source/build fallback loops", () => {
    const source = `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const CANDIDATES = ["./control.runtime.js", "./control.runtime.ts"] as const;
      export function loadRuntime() {
        for (const candidate of CANDIDATES) {
          return require(candidate);
        }
      }
    `;

    expect(
      findRuntimeSidecarLoaderViolations(source, "src/tasks/task-registry.ts", new Set()),
    ).toEqual([
      {
        line: 7,
        specifier: "./control.runtime.js",
        sourcePath: "src/tasks/control.runtime.ts",
        reason:
          'hidden local runtime loader "./control.runtime.js" resolves to src/tasks/control.runtime.ts, but that source is not an explicit tsdown entry',
      },
    ]);
  });

  it("ignores bundler-visible dynamic imports", () => {
    const source = `
      let runtimePromise: Promise<typeof import("./control.runtime.js")> | undefined;
      export function loadRuntime() {
        runtimePromise ??= import("./control.runtime.js");
        return runtimePromise;
      }
    `;

    expect(
      findRuntimeSidecarLoaderViolations(source, "src/tasks/task-registry.ts", new Set()),
    ).toEqual([]);
  });

  it("collects explicit tsdown entry sources", () => {
    expect(
      collectTsdownEntrySources([
        {
          entry: {
            index: "src/index.ts",
            "task-registry-control.runtime": "src/tasks/task-registry-control.runtime.ts",
          },
        },
      ]),
    ).toEqual(new Set(["src/index.ts", "src/tasks/task-registry-control.runtime.ts"]));
  });
});
