// Oxlint Config tests cover oxlint config script behavior.
import fs from "node:fs";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";

type OxlintConfig = {
  ignorePatterns?: string[];
  overrides?: Array<{
    excludeFiles?: string[];
    files?: string[];
    rules?: Record<string, unknown>;
  }>;
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
  "eslint/no-param-reassign",
  "eslint/no-implicit-coercion",
  "eslint/no-useless-rename",
  "eslint/no-useless-return",
  "eslint/no-new-wrappers",
  "eslint/no-else-return",
  "eslint/no-lonely-if",
  "eslint/no-case-declarations",
  "eslint/object-shorthand",
  "eslint/prefer-exponentiation-operator",
  "eslint/prefer-const",
  "eslint/prefer-numeric-literals",
  "eslint/prefer-object-has-own",
  "eslint/radix",
  "eslint/unicode-bom",
  "eslint/yoda",
  "import/no-absolute-path",
  "import/first",
  "import/no-empty-named-blocks",
  "import/no-duplicates",
  "import/no-self-import",
  "node/no-exports-assign",
  "promise/no-new-statics",
  "typescript/adjacent-overload-signatures",
  "typescript/ban-tslint-comment",
  "typescript/no-import-type-side-effects",
  "typescript/no-inferrable-types",
  "typescript/no-non-null-asserted-nullish-coalescing",
  "typescript/no-unnecessary-qualifier",
  "typescript/prefer-find",
  "typescript/prefer-for-of",
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
  "unicorn/no-unreadable-array-destructuring",
  "unicorn/no-useless-error-capture-stack-trace",
  "unicorn/no-zero-fractions",
  "unicorn/prefer-array-flat",
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
  "unicorn/prefer-set-has",
  "unicorn/prefer-structured-clone",
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
  return JSON5.parse(fs.readFileSync(path, "utf8"));
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

    expect(ignorePatterns).toEqual([
      "dist/",
      "dist-runtime/",
      "docs/_layouts/",
      "**/a2ui.bundle.js",
      "extensions/browser/chrome-extension/modules/copilot-runtime.js",
      "extensions/diffs/assets/viewer-runtime.js",
      "extensions/diffs-language-pack/assets/viewer-runtime.js",
      "node_modules/",
      "patches/",
      "pnpm-lock.yaml",
      "skills/**",
      "src/auto-reply/reply/export-html/template.js",
      "vendor/",
      "**/.cache/**",
      "**/.openclaw-runtime-deps-copy-*/**",
      "**/build/**",
      "**/coverage/**",
      "**/dist/**",
      "**/dist-runtime/**",
      "**/node_modules/**",
    ]);
  });

  it("preserves the indexed-access and test-file policies", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.overrides?.slice(0, 3)).toEqual([
      {
        files: ["extensions/browser/src/browser/routes/*.ts"],
        rules: {
          "oxc/no-async-endpoint-handlers": "off",
        },
      },
      {
        files: [
          "packages/markdown-core/**/*.ts",
          "packages/net-policy/**/*.ts",
          "packages/media-understanding-common/**/*.ts",
          "packages/terminal-core/**/*.ts",
          "packages/normalization-core/**/*.ts",
          "packages/model-catalog-core/**/*.ts",
          "packages/web-content-core/**/*.ts",
          "packages/agent-core/**/*.ts",
          "packages/acp-core/**/*.ts",
          "packages/ai/**/*.ts",
          "packages/gateway-client/**/*.ts",
          "packages/gateway-protocol/**/*.ts",
          "packages/llm-core/**/*.ts",
          "packages/media-core/**/*.ts",
          "packages/media-generation-core/**/*.ts",
          "packages/plugin-package-contract/**/*.ts",
          "packages/sdk/**/*.ts",
        ],
        rules: {
          "typescript/no-non-null-assertion": "error",
        },
      },
      {
        files: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.e2e.test.ts",
          "**/*.live.test.ts",
          "**/*test-harness.ts",
          "**/*test-helpers.ts",
          "**/*test-support.ts",
        ],
        rules: {
          "typescript/no-explicit-any": "off",
        },
      },
    ]);
  });

  it("enforces scoped max-lines budgets while excluding generated output", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;
    const maxLinesOverrides = (config.overrides ?? []).filter(
      (override) => override.rules?.["max-lines"],
    );

    expect(maxLinesOverrides).toHaveLength(4);
    expect(maxLinesOverrides.map((override) => override.rules?.["max-lines"])).toEqual([
      ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      ["error", { max: 800, skipBlankLines: true, skipComments: true }],
      ["error", { max: 1000, skipBlankLines: true, skipComments: true }],
    ]);
    for (const override of maxLinesOverrides) {
      expect(override.excludeFiles).toContain("**/protocol-gen/**");
      expect(override.excludeFiles).toContain("**/*.generated.*");
      expect(override.excludeFiles).toContain("ui/src/i18n/locales/**");
      expect(override.excludeFiles).toContain("src/wizard/i18n/locales/**");
    }
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
