import fs from "node:fs";
import { describe, expect, it } from "vitest";

type OxlintConfig = {
  ignorePatterns?: string[];
  rules?: Record<string, unknown>;
};

type OxlintTsconfig = {
  include?: string[];
  exclude?: string[];
};

const ZERO_BASELINE_RULES = [
  "eslint/no-div-regex",
  "eslint/no-constructor-return",
  "eslint/no-extra-label",
  "eslint/no-lone-blocks",
  "eslint/no-multi-str",
  "eslint/no-proto",
  "eslint/no-regex-spaces",
  "eslint/no-sequences",
  "eslint/no-self-compare",
  "eslint/no-var",
  "eslint/no-new-wrappers",
  "eslint/no-else-return",
  "eslint/no-case-declarations",
  "eslint/prefer-exponentiation-operator",
  "eslint/prefer-numeric-literals",
  "eslint/radix",
  "eslint/unicode-bom",
  "eslint/yoda",
  "import/no-absolute-path",
  "import/no-empty-named-blocks",
  "import/no-self-import",
  "node/no-exports-assign",
  "promise/no-new-statics",
  "typescript/adjacent-overload-signatures",
  "typescript/ban-tslint-comment",
  "typescript/no-non-null-asserted-nullish-coalescing",
  "typescript/no-unnecessary-qualifier",
  "typescript/prefer-find",
  "typescript/prefer-function-type",
  "typescript/prefer-includes",
  "typescript/prefer-reduce-type-parameter",
  "typescript/prefer-return-this-type",
  "unicorn/consistent-date-clone",
  "unicorn/consistent-empty-array-spread",
  "unicorn/no-console-spaces",
  "unicorn/no-length-as-slice-end",
  "unicorn/no-instanceof-array",
  "unicorn/no-negation-in-equality-check",
  "unicorn/no-new-buffer",
  "unicorn/no-typeof-undefined",
  "unicorn/no-useless-error-capture-stack-trace",
  "unicorn/prefer-array-some",
  "unicorn/prefer-dom-node-text-content",
  "unicorn/prefer-keyboard-event-key",
  "unicorn/prefer-math-min-max",
  "unicorn/prefer-negative-index",
  "unicorn/prefer-node-protocol",
  "unicorn/prefer-number-properties",
  "unicorn/prefer-optional-catch-binding",
  "unicorn/prefer-prototype-methods",
  "unicorn/prefer-regexp-test",
  "unicorn/prefer-string-slice",
  "unicorn/require-array-join-separator",
  "unicorn/require-number-to-fixed-digits-argument",
  "unicorn/throw-new-error",
  "vitest/no-import-node-test",
  "vitest/consistent-vitest-vi",
  "vitest/prefer-called-once",
  "vitest/prefer-called-times",
  "vitest/prefer-expect-type-of",
];

function readJson(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
}

describe("oxlint config", () => {
  it("includes bundled extensions in type-aware lint coverage", () => {
    const tsconfig = readJson("config/tsconfig/oxlint.json") as OxlintTsconfig;

    expect(tsconfig.include).toContain("../../extensions/**/*");
    expect(tsconfig.exclude ?? []).not.toContain("../../extensions");
  });

  it("includes scripts in root type-aware lint coverage", () => {
    const tsconfig = readJson("config/tsconfig/oxlint.json") as OxlintTsconfig;

    expect(tsconfig.include).toContain("../../scripts/**/*");
  });

  it("has a discoverable scripts tsconfig for type-aware linting", () => {
    const tsconfig = readJson("scripts/tsconfig.json") as OxlintTsconfig;

    expect(tsconfig.include).toContain("**/*.ts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.ts");
  });

  it("has a discoverable test tsconfig for type-aware linting", () => {
    const tsconfig = readJson("test/tsconfig.json") as OxlintTsconfig;

    expect(tsconfig.include).toContain("**/*.ts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.ts");
  });

  it("does not ignore the bundled extensions tree", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.ignorePatterns ?? []).not.toContain("extensions/");
  });

  it("keeps generated and vendored extension outputs ignored", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;
    const ignorePatterns = config.ignorePatterns ?? [];

    expect(ignorePatterns).toContain("**/node_modules/**");
    expect(ignorePatterns).toContain("**/dist/**");
    expect(ignorePatterns).toContain("**/build/**");
    expect(ignorePatterns).toContain("**/coverage/**");
    expect(ignorePatterns).toContain("**/.cache/**");
    expect(ignorePatterns).toContain("**/.openclaw-runtime-deps-copy-*/**");
    expect(ignorePatterns).toContain("extensions/diffs/assets/viewer-runtime.js");
  });

  it("enables strict empty object type lint with named single-extends interfaces allowed", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.rules?.["typescript/no-empty-object-type"]).toEqual([
      "error",
      { allowInterfaces: "with-single-extends" },
    ]);
  });

  it("enables exhaustive switch linting", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.rules?.["typescript/switch-exhaustiveness-check"]).toEqual([
      "error",
      { considerDefaultExhaustiveForUnions: true },
    ]);
  });

  it("enables clean zero-baseline lint rules", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    for (const rule of ZERO_BASELINE_RULES) {
      expect(config.rules?.[rule]).toBe("error");
    }
  });
});
