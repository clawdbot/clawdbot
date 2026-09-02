// Check Dynamic Import Warts tests cover check dynamic import warts script behavior.
import { describe, expect, it } from "vitest";
import { findDynamicImportAdvisories } from "../../scripts/check-dynamic-import-warts.mts";

describe("check-dynamic-import-warts", () => {
  it.each([
    {
      title: "flags runtime static plus dynamic imports of the same module",
      source: `
      import { run } from "./runtime.js";
      export async function start() {
        return await import("./runtime.js");
      }
    `,
      expectedLine: 4,
      expectedMessage: 'runtime static + dynamic import of "./runtime.js" (static line 2)',
    },
    {
      title: "flags runtime static re-exports plus dynamic imports of the same module",
      source: `
      let runtimePromise: Promise<typeof import("./runtime.js")> | undefined;
      function loadRuntime() {
        runtimePromise ??= import("./runtime.js");
        return runtimePromise;
      }
      export { run } from "./runtime.js";
    `,
      expectedLine: 4,
      expectedMessage: 'runtime static + dynamic import of "./runtime.js" (static line 7)',
    },
    {
      title: "flags mixed runtime and inline type-only static re-exports",
      source: `
      let runtimePromise: Promise<typeof import("./runtime.js")> | undefined;
      function loadRuntime() {
        runtimePromise ??= import("./runtime.js");
        return runtimePromise;
      }
      export { type Runtime, createRuntime } from "./runtime.js";
    `,
      expectedLine: 4,
      expectedMessage: 'runtime static + dynamic import of "./runtime.js" (static line 7)',
    },
    {
      title: "flags repeated direct dynamic imports",
      source: `
      export async function one() {
        return await import("./runtime.js");
      }
      export async function two() {
        return await import("./runtime.js");
      }
    `,
      expectedLine: 3,
      expectedMessage: 'repeated direct dynamic import of "./runtime.js" (2 callsites: 3, 6)',
    },
  ])("$title", ({ source, expectedLine, expectedMessage }) => {
    expect(findDynamicImportAdvisories(source)).toEqual([
      {
        line: expectedLine,
        reason: expectedMessage,
      },
    ]);
  });

  it.each([
    {
      title: "ignores type-only static imports",
      source: `
      import { type Runtime } from "./runtime.js";
      export async function start(): Promise<Runtime> {
        return (await import("./runtime.js")).createRuntime();
      }
    `,
    },
    {
      title: "ignores type-only static re-exports",
      source: `
      export type { Runtime } from "./runtime.js";
      export async function start() {
        return (await import("./runtime.js")).createRuntime();
      }
    `,
    },
    {
      title: "ignores inline type-only static re-exports",
      source: `
      export { type Runtime, type RuntimeOptions } from "./runtime.js";
      export async function start() {
        return (await import("./runtime.js")).createRuntime();
      }
    `,
    },
    {
      title: "ignores local export declarations without module specifiers",
      source: `
      const run = true;
      export { run };
      export async function start() {
        return await import("./runtime.js");
      }
    `,
    },
    {
      title: "ignores cached loader patterns",
      source: `
      let runtimePromise: Promise<typeof import("./runtime.js")> | undefined;
      function loadRuntime() {
        runtimePromise ??= import("./runtime.js");
        return runtimePromise;
      }
    `,
    },
    {
      title: "allows execute paths that call cached loaders",
      source: `
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
    `,
    },
  ])("$title", ({ source }) => {
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
});
