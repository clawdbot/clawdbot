import { describe, expect, it } from "vitest";
import {
  collectModuleExportNames,
  compareExportNameCollisionDebt,
  findExportNameCollisions,
  isExcludedExportCollisionSource,
} from "../../scripts/check-export-name-collisions.mts";

describe("export name collision guard", () => {
  it.each([
    ["src/example.test.ts", true],
    ["src/example.e2e.test.ts", true],
    ["src/example.test-support.ts", true],
    ["src/example.test-helpers.ts", true],
    ["src/example.d.ts", true],
    ["src/test/example.ts", true],
    ["src/nested/__fixtures__/example.mts", true],
    ["src/example.test-utils.ts", false],
    ["src/example.test-harness.ts", false],
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

  it("exempts exact static and lazy same-name forwarders", () => {
    const forwarders = [
      `
        import { resolveThing as resolveThingImpl } from "./thing.js";
        export function resolveThing(first: string, second?: number) {
          return resolveThingImpl(first, second);
        }
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

  it("marks collisions exposed by a Plugin SDK module", () => {
    expect(
      findExportNameCollisions([
        { path: "src/one.ts", content: "export const publicCollision = 1;" },
        { path: "src/two.ts", content: "export function publicCollision() {}" },
        {
          path: "src/plugin-sdk/public.ts",
          content: 'export * from "./public-star.js";',
        },
        {
          path: "src/plugin-sdk/public-star.ts",
          content: 'export * from "../../packages/public.js";',
        },
        {
          path: "packages/public.ts",
          content: "export const publicCollision = true;",
          includeDefinitions: false,
        },
      ]),
    ).toEqual([
      {
        name: "publicCollision",
        files: ["src/one.ts", "src/two.ts"],
        sdk: true,
      },
    ]);
  });
});

describe("export name collision debt baseline", () => {
  it("separates new debt from baseline improvements", () => {
    expect(
      compareExportNameCollisionDebt(
        [
          { name: "added", files: ["src/a.ts", "src/b.ts"] },
          { name: "expanded", files: ["src/a.ts", "src/b.ts", "src/c.ts"], sdk: true },
        ],
        [
          { name: "expanded", files: ["src/a.ts", "src/b.ts"] },
          { name: "removed", files: ["src/c.ts", "src/d.ts"] },
        ],
      ),
    ).toEqual({
      regressions: [
        { current: { name: "added", files: ["src/a.ts", "src/b.ts"] } },
        {
          baseline: { name: "expanded", files: ["src/a.ts", "src/b.ts"] },
          current: {
            name: "expanded",
            files: ["src/a.ts", "src/b.ts", "src/c.ts"],
            sdk: true,
          },
        },
      ],
      improvements: [{ baseline: { name: "removed", files: ["src/c.ts", "src/d.ts"] } }],
    });
  });
});
