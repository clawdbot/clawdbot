// Check Runtime Sidecar Loaders tests cover check runtime sidecar loaders script behavior.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  collectTsdownEntryOutputs,
  collectTsdownEntrySources,
  findRuntimeSidecarLoaderViolations,
} from "../../scripts/check-runtime-sidecar-loaders.mts";

function listRuntimeStaticSpecifiers(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  return sourceFile.statements.flatMap((statement) => {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.importClause?.isTypeOnly
    ) {
      return [statement.moduleSpecifier.text];
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.isTypeOnly &&
      !(
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.every((element) => element.isTypeOnly)
      )
    ) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

function resolveLocalSource(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const resolved = resolve(dirname(importerPath), specifier);
  const candidates = [resolved, resolved.replace(/\.js$/, ".ts"), resolve(resolved, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function collectRuntimeStaticGraph(entryPath: string): Set<string> {
  const pending = [entryPath];
  const visited = new Set<string>();
  for (const sourcePath of pending) {
    if (visited.has(sourcePath)) {
      continue;
    }
    visited.add(sourcePath);
    for (const specifier of listRuntimeStaticSpecifiers(sourcePath)) {
      const resolved = resolveLocalSource(sourcePath, specifier);
      if (resolved && !visited.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return visited;
}

describe("check-runtime-sidecar-loaders", () => {
  it("keeps the memory runtime facade out of the manager sidecar graph", () => {
    const sourcePath = new URL("../../extensions/memory-core/runtime-api.ts", import.meta.url);
    const runtimeGraph = [...collectRuntimeStaticGraph(sourcePath.pathname)].map((filePath) =>
      relative(resolve(dirname(sourcePath.pathname), "../.."), filePath),
    );

    expect(runtimeGraph.filter((filePath) => /(^|\/)manager(?:-|\.)/.test(filePath))).toEqual([]);
  });

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
    ).toStrictEqual([]);
  });

  it.each([
    {
      name: "matching output alias",
      outputPath: "plugins/model-normalizer.runtime.js",
      entrySource: "src/plugins/model-normalizer.runtime.ts",
      violations: 0,
    },
    {
      name: "different output alias",
      outputPath: "plugins/renamed-normalizer.runtime.js",
      entrySource: "src/plugins/model-normalizer.runtime.ts",
      violations: 1,
    },
    {
      name: "undeclared source",
      outputPath: "plugins/model-normalizer.runtime.js",
      entrySource: "src/plugins/undeclared.runtime.ts",
      violations: 1,
    },
    {
      name: "different package output directory",
      outputPath: "../packages/example/dist/plugins/model-normalizer.runtime.js",
      entrySource: "src/plugins/model-normalizer.runtime.ts",
      violations: 1,
    },
  ])(
    "requires an exact declared built output: $name",
    ({ outputPath, entrySource, violations }) => {
      const source = `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      export function loadRuntime() {
        return require("./plugins/model-normalizer.runtime.js");
      }
    `;
      const entrySources = collectTsdownEntrySources({
        entry: { "plugins/model-normalizer.runtime": "src/plugins/model-normalizer.runtime.ts" },
      });

      expect(
        findRuntimeSidecarLoaderViolations(
          source,
          "src/agents/model-normalization.runtime.ts",
          entrySources,
          new Map([[outputPath, entrySource]]),
        ),
      ).toHaveLength(violations);
    },
  );

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
    ).toStrictEqual([]);
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

  it("collects declared JavaScript outputs without flattening package directories or inventing suffixes", () => {
    const outputs = collectTsdownEntryOutputs([
      {
        entry: { "plugins/model-normalizer.runtime": "src/plugins/model-normalizer.runtime.ts" },
        outExtensions: () => ({ js: ".js" }),
      },
      {
        entry: { "plugins/model-normalizer.runtime": "packages/example/src/normalizer.runtime.ts" },
        outDir: "packages/example/dist",
        outExtensions: () => ({ js: ".js" }),
      },
      {
        entry: { "worker/worker.runtime": "src/worker/worker.runtime.ts" },
        outDir: "dist",
        outExtensions: () => ({ js: ".mjs" }),
      },
      { entry: { "implicit.runtime": "src/implicit.runtime.ts" } },
      {
        entry: { "contextual.runtime": "src/contextual.runtime.ts" },
        outExtensions: (context: { format: string }) => ({
          js: context.format === "es" ? ".js" : ".cjs",
        }),
      },
    ]);

    expect(outputs).toEqual(
      new Map([
        ["plugins/model-normalizer.runtime.js", "src/plugins/model-normalizer.runtime.ts"],
        [
          "../packages/example/dist/plugins/model-normalizer.runtime.js",
          "packages/example/src/normalizer.runtime.ts",
        ],
      ]),
    );
  });
});
