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
      name: "dynamic import after a regexp brace inside template interpolation",
      source: 'const message = `${/}/.test("safe") ? import("../../src/private.js") : null}`',
      kind: "dynamic-import",
    },
    {
      name: "commented dynamic import after a regexp character-class brace",
      source:
        'const message = `${/[}]/.test("safe") ? import /* gap */ ("../../src/private.js", { with: { type: "json" } }) : null}`',
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
      name: "CommonJS require inside nested template interpolation",
      source: 'const message = `outer ${`inner ${require("../../src/private.js")}`} tail`',
      kind: "commonjs-require",
    },
    {
      name: "CommonJS require with a Unicode-escaped first character inside interpolation",
      source: 'const message = `${\\u0072equire("../../src/private.js")}`',
      kind: "commonjs-require",
    },
    {
      name: "CommonJS require with a Unicode-escaped middle character inside interpolation",
      source: 'const message = `${r\\u0065quire("../../src/private.js")}`',
      kind: "commonjs-require",
    },
    {
      name: "CommonJS require with a Unicode-escaped braced character inside interpolation",
      source: 'const message = `${\\u{72}equire("../../src/private.js")}`',
      kind: "commonjs-require",
    },
    {
      name: "CommonJS require with a Unicode-escaped last character inside interpolation",
      source: 'const message = `${requir\\u0065("../../src/private.js")}`',
      kind: "commonjs-require",
    },
    {
      name: "CommonJS require after a regexp brace inside template interpolation",
      source: 'const message = `${/}/.test("safe") ? require("../../src/private.js") : null}`',
      kind: "commonjs-require",
    },
    {
      name: "CommonJS require after a regexp character-class brace inside interpolation",
      source: 'const message = `${/[}]/.test("safe") ? require("../../src/private.js") : null}`',
      kind: "commonjs-require",
    },
    {
      name: "CommonJS require after division inside template interpolation",
      source: 'const message = `${(24 / 2) ? require("../../src/private.js") : null}`',
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
      name: "import.meta URL with a template specifier",
      source: "new URL(`../../src/private.js`, import.meta.url)",
      kind: "import-meta-url",
    },
    {
      name: "import.meta URL following a completed template interpolation",
      source:
        'const message = `prefix ${"allowed"} tail`; new URL("../../src/private.js", import.meta.url)',
      kind: "import-meta-url",
    },
    {
      name: "import.meta URL after a regexp brace inside template interpolation",
      source:
        'const message = `${/}/.test("safe") ? new URL("../../src/private.js", import.meta.url) : null}`',
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
      name: "namespace re-export following nested template interpolations",
      source:
        'const message = `outer ${`inner ${1}`} tail`; export * as privateModule from "../../src/private.js"',
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

  it.each([
    'const message = `${(24 / 2) ? require("../../src/allowed.js") : null}`',
    'const message = `${/}/.test("safe") ? require("../../src/allowed.js") : null}`',
    'const message = `${\\u0072equire("../../src/allowed.js")}`',
    'const message = `${/}/.test("safe") ? import("../../src/allowed.js") : null}`',
  ])("keeps ordinary division and regexp fallback free of false positives", (source) => {
    expect(
      collectModuleReferencesFromSource(source, {
        acceptSpecifier: (specifier) => specifier === forbiddenPath,
      }),
    ).toEqual([]);
  });

  it("preserves the actual source line for multiline guarded imports", () => {
    expect(
      collectModuleReferencesFromSource('\n\nimport /* comment */ "../../src/private.js";', {
        acceptSpecifier: (specifier) => specifier === forbiddenPath,
      }),
    ).toEqual([{ kind: "import", line: 3, specifier: forbiddenPath }]);
  });

  it.each([
    {
      name: "import.meta URL",
      createSource: (comments: string) =>
        "new /*" + comments + '! URL("../../src/allowed.js", import.meta.url)',
    },
    {
      name: "embedded CommonJS require",
      createSource: (comments: string) =>
        "const message = " +
        templateQuote +
        "$" +
        "{require /*" +
        comments +
        '! ("../../src/allowed.js")}' +
        templateQuote,
    },
    {
      name: "namespace re-export",
      createSource: (comments: string) =>
        "export /*" + comments + '! * as privateModule from "../../src/allowed.js"',
    },
  ])("scans hostile repeated comments in linear time for $name", ({ createSource }) => {
    const source = createSource("*//*".repeat(8_192));
    const startedAt = performance.now();

    expect(
      collectModuleReferencesFromSource(source, {
        acceptSpecifier: (specifier) => specifier === forbiddenPath,
      }),
    ).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
