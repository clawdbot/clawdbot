import { describe, expect, it } from "vitest";
import { findDynamicImportAdvisories } from "../../scripts/check-dynamic-import-warts.mjs";

describe("check-dynamic-import-warts", () => {
  it("flags runtime static plus dynamic imports of the same module", () => {
    const source = `
      import { run } from "./runtime.js";
      export async function start() {
        return await import("./runtime.js");
      }
    `;
    expect(findDynamicImportAdvisories(source)).toEqual([
      {
        line: 4,
        reason: 'runtime static + dynamic import of "./runtime.js" (static line 2)',
      },
    ]);
  });

  it("ignores type-only static imports", () => {
    const source = `
      import { type Runtime } from "./runtime.js";
      export async function start(): Promise<Runtime> {
        return (await import("./runtime.js")).createRuntime();
      }
    `;
    expect(findDynamicImportAdvisories(source)).toStrictEqual([]);
  });

  it("flags repeated direct dynamic imports", () => {
    const source = `
      export async function one() {
        return await import("./runtime.js");
      }
      export async function two() {
        return await import("./runtime.js");
      }
    `;
    expect(findDynamicImportAdvisories(source)).toEqual([
      {
        line: 3,
        reason: 'repeated direct dynamic import of "./runtime.js" (2 callsites: 3, 6)',
      },
    ]);
  });

  it("ignores cached loader patterns", () => {
    const source = `
      let runtimePromise: Promise<typeof import("./runtime.js")> | undefined;
      function loadRuntime() {
        runtimePromise ??= import("./runtime.js");
        return runtimePromise;
      }
    `;
    expect(findDynamicImportAdvisories(source)).toStrictEqual([]);
  });

  it("flags direct dynamic imports inside execute paths", () => {
    const source = `
      export function createTool() {
        return {
          execute: async () => {
            return await import("./runtime.js");
          },
        };
      }
    `;
    expect(findDynamicImportAdvisories(source)).toEqual([
      {
        line: 5,
        reason:
          'direct dynamic import of "./runtime.js" inside execute path; move it behind a cached loader',
      },
    ]);
  });

  it("allows execute paths that call cached loaders", () => {
    const source = `
      let runtimePromise: Promise<typeof import("./runtime.js")> | undefined;
      function loadRuntime() {
        runtimePromise ??= import("./runtime.js");
        return runtimePromise;
      }
      export function createTool() {
        return {
          execute: async () => await loadRuntime(),
        };
      }
    `;
    expect(findDynamicImportAdvisories(source)).toStrictEqual([]);
  });
});
