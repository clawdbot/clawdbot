import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectModuleExportNames,
  collectRepositoryCollisions,
  findAliasingReExports,
  findExportNameCollisions,
  isExcludedExportCollisionSource,
} from "../../scripts/check-export-name-collisions.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

const guardScriptPath = fileURLToPath(
  new URL("../../scripts/check-export-name-collisions.mts", import.meta.url),
);

describe("export name collision guard", () => {
  it.each([
    ["src/example.test.ts", true],
    ["src/example.e2e.test.ts", true],
    ["src/example.test-support.ts", true],
    ["src/example.test-helpers.ts", true],
    ["src/example.test-utils.ts", true],
    ["src/example.test-harness.ts", true],
    ["src/example.e2e-harness.ts", true],
    ["src/example.d.ts", true],
    ["src/test/example.ts", true],
    ["src/nested/__fixtures__/example.mts", true],
    ["src/example.ts", false],
    ["src/example.mts", false],
  ])("classifies source exclusion %s", (filePath, expected) => {
    expect(isExcludedExportCollisionSource(filePath)).toBe(expected);
  });

  it("finds exported function and const definitions across modules", () => {
    expect(
      findExportNameCollisions([
        { path: "src/alpha.ts", content: "export function sharedBehavior() {}" },
        { path: "src/beta.ts", content: "export const sharedBehavior = () => {};" },
        {
          path: "src/gamma.ts",
          content: "async function listedBehavior() {}\nexport { listedBehavior };",
        },
        {
          path: "src/delta.mts",
          content: "export async function listedBehavior() {}",
        },
      ]),
    ).toEqual([
      { name: "listedBehavior", files: ["src/delta.mts", "src/gamma.ts"] },
      { name: "sharedBehavior", files: ["src/alpha.ts", "src/beta.ts"] },
    ]);
  });

  it("ignores types, pure re-exports, imports exported locally, and renamed exports", () => {
    const result = collectModuleExportNames(`
      import { importedValue } from "./other.js";
      interface LocalShape {}
      type LocalType = string;
      export { importedValue };
      export { remoteValue } from "./remote.js";
      export { remoteValue as renamedValue } from "./remote.js";
      export * from "./barrel.js";
      export interface ExportedShape {}
      export type ExportedType = string;
    `);
    expect([...result.definitions]).toEqual([]);
    expect([...result.exportedNames]).toEqual(["importedValue", "remoteValue"]);
  });

  it("reports direct aliasing re-exports only outside the Plugin SDK", () => {
    expect(
      findAliasingReExports([
        {
          path: "src/alias.ts",
          content: `
            export { original } from "./source.js";
            export type { OriginalType as RenamedType } from "./source.js";
            export { original as renamed } from "./source.js";
          `,
        },
        {
          path: "src/local-alias.ts",
          content: `
            import { original } from "./source.js";
            export { original as locallyRenamed };
          `,
        },
        {
          path: "src/plugin-sdk/alias.ts",
          content: 'export { original as sanctioned } from "../source.js";',
        },
        {
          path: "packages/support.ts",
          content: 'export { original as packageAlias } from "./source.js";',
          includeDefinitions: false,
        },
      ]),
    ).toEqual([
      {
        exportedName: "renamed",
        importedName: "original",
        line: 4,
        moduleSpecifier: "./source.js",
        path: "src/alias.ts",
      },
    ]);
  });

  it("exempts exact function and const same-name forwarders", () => {
    const forwarders = [
      `
        import { resolveThing as resolveThingImpl } from "./thing.js";
        export function resolveThing(first: string, second?: number) {
          return resolveThingImpl(first, second);
        }
      `,
      `
        import { resolveThing as resolveThingImpl } from "./thing.js";
        export const resolveThing = resolveThingImpl;
      `,
      `
        import { resolveThing as resolveThingImpl } from "./thing.js";
        export const resolveThing = (first: string, second?: number) =>
          resolveThingImpl(first, second);
      `,
      `
        export const runThing = async (...args: unknown[]) => {
          const runtime = await loadRuntime();
          return runtime.runThing(...args);
        };
      `,
      `
        export async function runThing(...args: unknown[]) {
          return (await loadRuntime()).runThing(...args);
        }
      `,
      `
        export async function runThing(...args: unknown[]) {
          const runtime = await loadRuntime();
          return runtime.runThing(...args);
        }
      `,
    ];
    for (const content of forwarders) {
      expect([...collectModuleExportNames(content).definitions]).toEqual([]);
    }
  });

  it.each([
    {
      name: "extra call",
      body: `
        prepare();
        return resolveThingImpl(...args);
      `,
    },
    {
      name: "added argument",
      body: "return resolveThingImpl(...args, fallback);",
    },
    {
      name: "changed argument order",
      params: "first: string, second: string",
      body: "return resolveThingImpl(second, first);",
    },
    {
      name: "layered argument",
      params: "params: Record<string, unknown>",
      body: "return resolveThingImpl({ ...params, enabled: true });",
    },
    {
      name: "conditional",
      body: "return ready ? resolveThingImpl(...args) : fallback;",
    },
  ])("keeps $name wrappers as real definitions", ({ params = "...args: unknown[]", body }) => {
    const result = collectModuleExportNames(`
      import { resolveThing as resolveThingImpl } from "./thing.js";
      export function resolveThing(${params}) {
        ${body}
      }
    `);
    expect([...result.definitions]).toEqual(["resolveThing"]);
  });

  it("keeps const arrows that add arguments as real definitions", () => {
    const result = collectModuleExportNames(`
      import { resolveThing as resolveThingImpl } from "./thing.js";
      export const resolveThing = (...args: unknown[]) => resolveThingImpl(...args, fallback);
    `);
    expect([...result.definitions]).toEqual(["resolveThing"]);
  });

  it("discovers JavaScript source collisions", async () => {
    await withTempDir("openclaw-export-collisions-", async (repoRoot) => {
      const sourceRoot = path.join(repoRoot, "src");
      await fs.mkdir(sourceRoot);
      await Promise.all([
        fs.writeFile(path.join(sourceRoot, "alpha.js"), "export const sharedValue = 1;\n"),
        fs.writeFile(path.join(sourceRoot, "beta.mjs"), "export const sharedValue = 2;\n"),
      ]);
      expect(await collectRepositoryCollisions(repoRoot)).toEqual([
        { name: "sharedValue", files: ["src/alpha.js", "src/beta.mjs"] },
      ]);
    });
  });

  it("deduplicates overloads inside one module", () => {
    expect(
      findExportNameCollisions([
        {
          path: "src/overloads.ts",
          content: `
            export function convert(value: string): string;
            export function convert(value: number): number;
            export function convert(value: string | number) { return value; }
          `,
        },
      ]),
    ).toEqual([]);
  });

  it("marks repository collisions exposed through a package-backed Plugin SDK module", async () => {
    await withTempDir("openclaw-export-collisions-sdk-", async (repoRoot) => {
      await Promise.all([
        fs.mkdir(path.join(repoRoot, "src/plugin-sdk"), { recursive: true }),
        fs.mkdir(path.join(repoRoot, "packages"), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(path.join(repoRoot, "src/one.ts"), "export const publicCollision = 1;\n"),
        fs.writeFile(path.join(repoRoot, "src/two.ts"), "export function publicCollision() {}\n"),
        fs.writeFile(
          path.join(repoRoot, "src/plugin-sdk/public.ts"),
          'export * from "./public-star.js";\n',
        ),
        fs.writeFile(
          path.join(repoRoot, "src/plugin-sdk/public-star.ts"),
          'export * from "../../packages/public.js";\n',
        ),
        fs.writeFile(
          path.join(repoRoot, "packages/public.ts"),
          "export const publicCollision = true;\n",
        ),
      ]);

      expect(await collectRepositoryCollisions(repoRoot)).toEqual([
        {
          name: "publicCollision",
          files: ["src/one.ts", "src/two.ts"],
          sdk: true,
        },
      ]);
    });
  });

  it("rejects debt-baseline updates with the collision trailer", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", guardScriptPath, "--update-debt-baseline"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr.trimEnd().split("\n").at(-1)).toBe(
      "[check-export-name-collisions] FAILED (exit 2)",
    );
  });
});
