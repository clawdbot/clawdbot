// Oxlint Config tests cover oxlint config script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

type OxlintConfig = {
  ignorePatterns?: string[];
  overrides?: Array<{
    excludeFiles?: string[];
    files?: string[];
    rules?: Record<string, unknown>;
  }>;
  plugins?: string[];
  rules?: Record<string, unknown>;
};

type OxlintTsconfig = {
  compilerOptions?: {
    allowJs?: boolean;
  };
  include?: string[];
  exclude?: string[];
};

const ZERO_BASELINE_RULES = [
  "eslint/array-callback-return",
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
  "eslint/no-label-var",
  "eslint/no-prototype-builtins",
  "eslint/no-redeclare",
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
  "eslint/prefer-promise-reject-errors",
  "eslint/radix",
  "eslint/symbol-description",
  "eslint/unicode-bom",
  "eslint/yoda",
  "import/no-absolute-path",
  "import/first",
  "import/no-duplicates",
  "import/no-empty-named-blocks",
  "import/no-self-import",
  "node/no-exports-assign",
  "promise/no-new-statics",
  "typescript/adjacent-overload-signatures",
  "typescript/ban-tslint-comment",
  "typescript/no-import-type-side-effects",
  "typescript/no-inferrable-types",
  "typescript/no-non-null-asserted-nullish-coalescing",
  "typescript/no-unnecessary-qualifier",
  "typescript/prefer-enum-initializers",
  "typescript/prefer-find",
  "typescript/prefer-for-of",
  "typescript/prefer-function-type",
  "typescript/prefer-includes",
  "typescript/prefer-reduce-type-parameter",
  "typescript/prefer-return-this-type",
  "unicorn/consistent-date-clone",
  "unicorn/consistent-empty-array-spread",
  "unicorn/explicit-timer-delay",
  "unicorn/no-console-spaces",
  "unicorn/no-length-as-slice-end",
  "unicorn/no-instanceof-array",
  "unicorn/no-negation-in-equality-check",
  "unicorn/no-new-buffer",
  "unicorn/no-this-assignment",
  "unicorn/no-typeof-undefined",
  "unicorn/no-unreadable-array-destructuring",
  "unicorn/no-useless-error-capture-stack-trace",
  "unicorn/no-zero-fractions",
  "unicorn/prefer-array-flat",
  "unicorn/prefer-array-some",
  "unicorn/prefer-blob-reading-methods",
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
  "unicorn/prefer-string-trim-start-end",
  "unicorn/require-array-join-separator",
  "unicorn/require-module-attributes",
  "unicorn/require-number-to-fixed-digits-argument",
  "unicorn/throw-new-error",
  "vitest/no-import-node-test",
  "vitest/consistent-vitest-vi",
  "vitest/prefer-called-once",
  "vitest/prefer-called-times",
  "vitest/prefer-expect-type-of",
];

const DEFERRED_IMPORT_RULES = [
  "import/default",
  "import/namespace",
  "import/no-named-as-default",
  "import/no-named-as-default-member",
  "import/no-unassigned-import",
];

function readJson(filePath: string): unknown {
  return JSON5.parse(fs.readFileSync(filePath, "utf8"));
}

describe("oxlint config", () => {
  it("enforces namespace, evaluation, and unused-binding policies with the installed binary", () => {
    const tempRoot = fs.realpathSync(createTempDir("openclaw-oxlint-policy-"));
    const typescriptExtensions = ["ts", "tsx", "mts", "cts"];
    const javascriptExtensions = ["js", "jsx", "cjs", "mjs"];
    const evaluation = 'eval("1 + 1");\nglobalThis.eval("1 + 1");\n';
    const fixtures = [
      ...typescriptExtensions.map((extension) => ({
        file: `src/namespaces.${extension}`,
        source: [
          "export type Profile = { ready: boolean };",
          "export const Profile = { ready: true };",
          "export interface Adapter { ready: boolean; }",
          "export const Adapter: Adapter = { ready: true };",
        ].join("\n"),
        rules: [],
      })),
      ...javascriptExtensions.map((extension) => ({
        file: `src/redeclaration.${extension}`,
        source:
          "var duplicateBinding = 1;\nvar duplicateBinding = 2;\nconsole.log(duplicateBinding);\n",
        rules: ["eslint(no-redeclare)", "eslint(no-var)", "eslint(no-var)"],
      })),
      ...typescriptExtensions.map((extension) => ({
        file: `src/no-var.${extension}`,
        source: "export var legacyBinding = 1;\n",
        rules: ["eslint(no-var)"],
      })),
      ...[...typescriptExtensions, ...javascriptExtensions].flatMap((extension) => [
        {
          file: `src/evaluation.${extension}`,
          source: evaluation,
          rules: ["eslint(no-eval)", "eslint(no-eval)"],
        },
        {
          file: `src/unused.${extension}`,
          source:
            "function meaningful(_event) { return true; }\nfunction bare(_) { return true; }\nmeaningful(1);\nbare(1);\n",
          rules: ["eslint(no-unused-vars)"],
        },
      ]),
      ...[
        "extensions/qa-lab/src/web-runtime.ts",
        "extensions/qa-lab/src/web-runtime.test.ts",
        "extensions/qa-lab/src/other-runtime.ts",
        "extensions/other/src/web-runtime.ts",
      ].map((file) => ({
        file,
        source: evaluation,
        rules:
          file === "extensions/qa-lab/src/web-runtime.ts"
            ? ["eslint(no-eval)"]
            : ["eslint(no-eval)", "eslint(no-eval)"],
      })),
    ];
    fs.copyFileSync(".oxlintrc.json", path.join(tempRoot, ".oxlintrc.json"));
    for (const fixture of fixtures) {
      const target = path.join(tempRoot, fixture.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fixture.source);
    }
    // These syntax-rule fixtures need no type program; one batch uses the real config and paths.
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/oxlint/bin/oxlint"),
        "--config",
        ".oxlintrc.json",
        "--format",
        "json",
        "--threads=1",
        "--report-unused-disable-directives-severity",
        "error",
        ...fixtures.map((fixture) => fixture.file),
      ],
      { cwd: tempRoot, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as {
      number_of_files: number;
      diagnostics: Array<{
        filename: string;
        code: string;
        severity: string;
        labels: Array<{ span: { line: number } }>;
      }>;
    };
    expect(report.number_of_files).toBe(fixtures.length);
    for (const fixture of fixtures) {
      const diagnostics = report.diagnostics.filter(
        (diagnostic) => diagnostic.filename.replaceAll("\\", "/") === fixture.file,
      );
      expect(diagnostics.map((diagnostic) => diagnostic.code).toSorted(), fixture.file).toEqual(
        fixture.rules.toSorted(),
      );
      expect(
        diagnostics.every((diagnostic) => diagnostic.severity === "error"),
        fixture.file,
      ).toBe(true);
    }
    const ownerDiagnostics = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.filename.replaceAll("\\", "/") === "extensions/qa-lab/src/web-runtime.ts",
    );
    expect(ownerDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual([1]);
    const unusedDiagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.code === "eslint(no-unused-vars)",
    );
    expect(unusedDiagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual(
      [...typescriptExtensions, ...javascriptExtensions].map(() => 2),
    );
  });

  it("keeps plugin tests in a bounded type-aware project without losing their types", () => {
    const tempRoot = fs.realpathSync(createTempDir("openclaw-oxlint-extension-project-"));
    for (const file of [
      ".oxlintrc.json",
      "tsconfig.json",
      "extensions/tsconfig.package-boundary.base.json",
      "extensions/tsconfig.package-boundary.paths.json",
      "extensions/tsconfig.json",
    ]) {
      // A missing discovery config must fail on the selected project, not fixture setup.
      if (fs.existsSync(file)) {
        const target = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
      }
    }
    fs.symlinkSync(path.resolve("node_modules"), path.join(tempRoot, "node_modules"), "junction");
    const fixtures = {
      "src/imported.ts": "export function work(): Promise<void> { return Promise.resolve(); }",
      "src/unrelated.ts": "export const unrelated = 1;",
      "src/contracts.d.ts": "declare function fromCore(): Promise<void>;",
      "ui/contracts.d.ts": "declare function fromUi(): Promise<void>;",
      "packages/contracts.d.ts": "declare function fromPackage(): Promise<void>;",
      "extensions/contracts.d.ts": "declare function fromPlugin(): Promise<void>;",
      "extensions/sample/tsconfig.json": JSON.stringify({
        extends: "../tsconfig.package-boundary.base.json",
      }),
      "extensions/sample/src/runtime.ts": "export const stable = 1;",
      "extensions/sample/src/owner.test.ts": [
        'import { work } from "../../../src/imported.js";',
        "work(); fromCore(); fromUi(); fromPackage(); fromPlugin();",
      ].join("\n"),
      "extensions/sample/src/test-support/helper.ts":
        'export { work } from "../../../../src/imported.js";',
    };
    for (const [file, source] of Object.entries(fixtures)) {
      const target = path.join(tempRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    const selected = [
      "extensions/sample/src/runtime.ts",
      "extensions/sample/src/owner.test.ts",
      "extensions/sample/src/test-support/helper.ts",
    ];
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/oxlint/bin/oxlint"),
        "--config",
        ".oxlintrc.json",
        "--type-aware",
        "--format",
        "json",
        "--threads=1",
        ...selected,
      ],
      {
        cwd: tempRoot,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OXC_LOG: "debug",
          GOMAXPROCS: "2",
          OXLINT_TSGOLINT_PATH: path.resolve(
            "node_modules/.bin",
            process.platform === "win32" ? "tsgolint.CMD" : "tsgolint",
          ),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as {
      number_of_files: number;
      diagnostics: Array<{ code: string }>;
    };
    expect(report.number_of_files).toBe(selected.length);
    expect(
      report.diagnostics.map((diagnostic) => diagnostic.code),
      result.stdout,
    ).toEqual(Array.from({ length: 5 }, () => "typescript(no-floating-promises)"));
    for (const file of selected) {
      const config = file.endsWith("/runtime.ts")
        ? "extensions/sample/tsconfig.json"
        : "extensions/tsconfig.json";
      expect(result.stderr.replaceAll("\\", "/")).toContain(
        `Got tsconfig for file ${path.join(tempRoot, file).replaceAll("\\", "/")}: ${path.join(tempRoot, config).replaceAll("\\", "/")}`,
      );
    }
    const project = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/@typescript/native-preview/bin/tsgo"),
        "--showConfig",
        "--project",
        "extensions/tsconfig.json",
      ],
      { cwd: tempRoot, encoding: "utf8", timeout: 10_000 },
    );
    expect(project.error).toBeUndefined();
    expect(project.status, project.stdout + project.stderr).toBe(0);
    const parsedProject = JSON.parse(project.stdout) as { files: string[] };
    expect(parsedProject.files).not.toContain("../src/unrelated.ts");
    expect(parsedProject.files).toEqual(
      expect.arrayContaining([
        "../src/contracts.d.ts",
        "../ui/contracts.d.ts",
        "../packages/contracts.d.ts",
        "./contracts.d.ts",
        ...selected.map((file) => `./${file.slice("extensions/".length)}`),
      ]),
    );
  });

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

    expect(tsconfig.compilerOptions?.allowJs).toBe(true);
    expect(tsconfig.include).toContain("**/*.ts");
    expect(tsconfig.include).toContain("**/*.mts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.ts");
    expect(tsconfig.exclude ?? []).not.toContain("**/*.mts");
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
      ".agents/skills/autoreview/tests/fixtures/**",
      "test/fixtures/oxlint-boundary-guards/**",
      "**/a2ui.bundle.js",
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

  it("allows ecosystem contract fields with leading underscores", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.rules?.["eslint/no-underscore-dangle"]).toEqual([
      "error",
      { allow: ["__typename", "_meta"] },
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
          "**/*.{test,suite}.ts",
          "**/*.{test,suite}.tsx",
          "**/*.e2e.test.ts",
          "**/*.live.test.ts",
          "**/*test-harness.ts",
          "**/*test-helpers.ts",
          "**/*test-support.ts",
        ],
        rules: {
          "import/first": "off",
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
    const scopedBudgets = maxLinesOverrides.filter((override) => override.excludeFiles);
    const exactExceptions = maxLinesOverrides.filter((override) => !override.excludeFiles);

    expect(scopedBudgets).toHaveLength(4);
    expect(scopedBudgets.map((override) => override.rules?.["max-lines"])).toEqual([
      ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      ["error", { max: 700, skipBlankLines: true, skipComments: true }],
      ["error", { max: 800, skipBlankLines: true, skipComments: true }],
      ["error", { max: 1000, skipBlankLines: true, skipComments: true }],
    ]);
    for (const override of scopedBudgets) {
      expect(override.excludeFiles).toContain("**/protocol-gen/**");
      expect(override.excludeFiles).toContain("**/*.generated.*");
      expect(override.excludeFiles).toContain("ui/src/i18n/locales/**");
      expect(override.excludeFiles).toContain("src/wizard/i18n/locales/**");
    }
    for (const override of scopedBudgets.slice(0, 3)) {
      expect(override.excludeFiles).toContain("**/*.{test,spec,suite}.*");
    }
    expect(scopedBudgets[3]?.files).toEqual(
      expect.arrayContaining([
        "src/**/*.{test,spec,suite}.*",
        "ui/src/**/*.{test,spec,suite}.*",
        "packages/**/*.{test,spec,suite}.*",
        "extensions/**/*.{test,spec,suite}.*",
      ]),
    );
    expect(exactExceptions).toEqual([
      {
        files: ["extensions/copilot/src/event-bridge.ts"],
        rules: {
          "max-lines": ["error", { max: 950, skipBlankLines: true, skipComments: true }],
        },
      },
      {
        files: ["extensions/copilot/src/attempt-transcript-journal.test.ts"],
        rules: {
          "max-lines": ["error", { max: 1200, skipBlankLines: true, skipComments: true }],
        },
      },
    ]);
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

  it("enables clean zero-baseline lint rules and keeps deferred import rules off", () => {
    const config = readJson(".oxlintrc.json") as OxlintConfig;

    expect(config.plugins).toContain("import");
    for (const rule of ZERO_BASELINE_RULES) {
      expect(config.rules?.[rule]).toBe("error");
    }
    for (const rule of DEFERRED_IMPORT_RULES) {
      expect(config.rules?.[rule]).toBe("off");
    }
  });
});
