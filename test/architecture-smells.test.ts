// Architecture boundary tests cover hostile module-specifier syntax in the canonical scanner.
import { describe, expect, it } from "vitest";
import { collectModuleReferencesFromSource } from "../scripts/lib/guard-inventory-utils.mjs";

const forbiddenPath = "../../src/private.js";
const templateQuote = String.fromCharCode(96);

describe("architecture boundary module reference scanner", () => {
  it.each([
    {
      name: "commented side-effect import",
      source: 'import /* gap */ "../../src/private.js"',
      kind: "import",
    },
    {
      name: "commented dynamic import with attributes",
      source: 'await import /* gap */ ("../../src/private.js", { with: { type: "json" } })',
      kind: "dynamic-import",
    },
    {
      name: "dynamic import inside template interpolation",
      source:
        "const message = " +
        templateQuote +
        "$" +
        '{await import("../../src/private.js")}' +
        templateQuote,
      kind: "dynamic-import",
    },
    {
      name: "CommonJS require",
      source: 'require("../../src/private.js")',
      kind: "commonjs-require",
    },
    {
      name: "CommonJS require inside template interpolation",
      source:
        "const message = " +
        templateQuote +
        "$" +
        '{require("../../src/private.js")}' +
        templateQuote,
      kind: "commonjs-require",
    },
    {
      name: "TypeScript import-equals require",
      source: 'import privateModule = require("../../src/private.js")',
      kind: "commonjs-require",
    },
    {
      name: "import.meta URL with comments",
      source: 'new URL("../../src/private.js", import /* gap */ . meta . url)',
      kind: "import-meta-url",
    },
    {
      name: "import.meta URL with escaped constructor",
      source: 'new \\u0055RL("../../src/private.js", import.meta.url)',
      kind: "import-meta-url",
    },
    {
      name: "runtime namespace re-export",
      source: 'export /* gap */ * /* gap */ as privateModule from "../../src/private.js"',
      kind: "export",
    },
    {
      name: "type namespace re-export",
      source: 'export type * as privateModule from "../../src/private.js"',
      kind: "export",
    },
    {
      name: "TypeScript import type",
      source: 'type PrivateModule = typeof import("../../src/private.js")',
      kind: "dynamic-import",
    },
    {
      name: "escaped module specifier",
      source: 'import "../../src/priv\\u0061te.js"',
      kind: "import",
    },
  ])("detects $name", ({ source, kind }) => {
    expect(
      collectModuleReferencesFromSource(source, {
        acceptSpecifier: (specifier) => specifier === forbiddenPath,
      }),
    ).toEqual([{ kind, line: 1, specifier: forbiddenPath }]);
  });

  it("ignores comments, string contents, and allowed module specifiers", () => {
    expect(
      collectModuleReferencesFromSource(
        [
          '// import "../../src/private.js"',
          'const text = "require(\\\"../../src/private.js\\\")";',
          'import "../../src/allowed.js";',
        ].join("\n"),
        { acceptSpecifier: (specifier) => specifier === forbiddenPath },
      ),
    ).toEqual([]);
  });

  it("preserves the actual source line for multiline guarded imports", () => {
    expect(
      collectModuleReferencesFromSource('\n\nimport /* comment */ "../../src/private.js";', {
        acceptSpecifier: (specifier) => specifier === forbiddenPath,
      }),
    ).toEqual([{ kind: "import", line: 3, specifier: forbiddenPath }]);
  });
});
