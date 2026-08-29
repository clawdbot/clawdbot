import { describe, expect, it } from "vitest";
import { boundCodeModeResult } from "./code-mode-json.js";
import {
  boundOutputToLimit,
  isCodeModeEngagedForModel,
  prepareSource,
  resolveCodeModeConfig,
} from "./code-mode-runtime.js";
import { parseCodeModeScriptSyntax } from "./code-mode-script-syntax.js";

const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

describe("Code Mode output bounding", () => {
  it("preserves Unicode output at its exact serialized byte limit", () => {
    const output = [{ type: "text", text: "😀 café".repeat(200) }];
    const maxOutputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");

    expect(boundOutputToLimit(output, { ...config, maxOutputBytes })).toBe(false);
    expect(output).toEqual([{ type: "text", text: "😀 café".repeat(200) }]);

    expect(boundOutputToLimit(output, { ...config, maxOutputBytes: maxOutputBytes - 1 })).toBe(
      true,
    );
    expect(JSON.stringify(output)).toContain("rerun with narrower args");
  });

  it("bounds output and the returned value under one serialized budget", () => {
    const output = [{ type: "text", text: "😀".repeat(200) }];
    const value = { result: "café".repeat(200) };
    const maxOutputBytes =
      Buffer.byteLength(JSON.stringify(output), "utf8") +
      Buffer.byteLength(JSON.stringify(value), "utf8");

    expect(boundCodeModeResult({ output, value, maxOutputBytes })).toMatchObject({
      output,
      value,
      truncated: false,
    });

    const bounded = boundCodeModeResult({
      output,
      value,
      maxOutputBytes: maxOutputBytes - 1,
    });
    expect(bounded.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(bounded.output), "utf8") +
        Buffer.byteLength(JSON.stringify(bounded.value), "utf8"),
    ).toBeLessThanOrEqual(maxOutputBytes - 1);
  });

  it("does not charge an empty output array against the returned value", () => {
    const value = "ok";
    const maxOutputBytes = Buffer.byteLength(JSON.stringify(value), "utf8");

    expect(boundCodeModeResult({ output: [], value, maxOutputBytes })).toMatchObject({
      output: [],
      value,
      truncated: false,
    });
  });

  it("preserves failure text and output at their exact serialized byte limit", () => {
    const output = [{ type: "text", text: "before failure" }];
    const error = "Error: café 😀";
    const maxOutputBytes =
      Buffer.byteLength(JSON.stringify(output), "utf8") +
      Buffer.byteLength(JSON.stringify(error), "utf8");

    expect(boundCodeModeResult({ output, error, maxOutputBytes })).toEqual({
      output,
      error,
      truncated: false,
    });
  });

  it.each([
    { name: "plain error", errorText: "failure ", output: [], returned: {} },
    { name: "Unicode error", errorText: "😀 café ", output: [], returned: {} },
    { name: "escaped error", errorText: '\\"\n\t', output: [], returned: {} },
    {
      name: "error and output",
      errorText: "😀 failure ",
      output: [{ type: "text", text: "output ".repeat(1_000) }],
      returned: {},
    },
    {
      name: "error, output, and value",
      errorText: "😀 failure ",
      output: [{ type: "text", text: "output ".repeat(1_000) }],
      returned: { value: "value ".repeat(1_000) },
    },
  ])(
    "bounds $name without losing the cause or splitting Unicode",
    ({ errorText, output, returned }) => {
      const maxOutputBytes = 1_024;
      const bounded = boundCodeModeResult({
        output,
        error: `Error: ${errorText.repeat(1_000)}`,
        ...returned,
        maxOutputBytes,
      });

      expect(bounded.truncated).toBe(true);
      expect(bounded.error).toMatch(/^Error: .*\[error truncated\]$/s);
      expect(bounded.error).not.toContain("�");
      const serializedBytes =
        Buffer.byteLength(JSON.stringify(bounded.error), "utf8") +
        (bounded.output.length ? Buffer.byteLength(JSON.stringify(bounded.output), "utf8") : 0) +
        (Object.hasOwn(returned, "value")
          ? Buffer.byteLength(JSON.stringify(bounded.value), "utf8")
          : 0);
      expect(serializedBytes).toBeLessThanOrEqual(maxOutputBytes);
    },
  );
});

describe("Code Mode master switch resolution", () => {
  it.each([
    { name: "boolean shorthand true", codeMode: true, enabled: true },
    { name: "boolean shorthand false", codeMode: false, enabled: false },
    { name: "auto shorthand", codeMode: "auto", enabled: "auto" },
    { name: "object enabled auto", codeMode: { enabled: "auto" }, enabled: "auto" },
    { name: "object with options", codeMode: { timeoutMs: 5000 }, enabled: false },
    { name: "empty object", codeMode: {}, enabled: false },
    { name: "omitted", codeMode: undefined, enabled: false },
  ])("resolves enabled for $name", ({ codeMode, enabled }) => {
    expect(resolveCodeModeConfig({ tools: { codeMode } } as never).enabled).toBe(enabled);
  });

  const preferredModel = { compat: { codeMode: "preferred" } };
  const capableModel = { compat: { codeMode: "capable" } };
  const unflaggedModel = { compat: { supportsTools: true } };

  it.each([
    {
      name: "true engages an unflagged model",
      enabled: true,
      model: unflaggedModel,
      engaged: true,
    },
    {
      name: "false stays off for a preferred model",
      enabled: false,
      model: preferredModel,
      engaged: false,
    },
    {
      name: "auto engages a preferred model",
      enabled: "auto",
      model: preferredModel,
      engaged: true,
    },
    {
      name: "auto skips an explicit capable model",
      enabled: "auto",
      model: capableModel,
      engaged: false,
    },
    {
      name: "auto skips an unflagged model",
      enabled: "auto",
      model: unflaggedModel,
      engaged: false,
    },
    { name: "auto skips a compat-free model", enabled: "auto", model: {}, engaged: false },
    { name: "auto skips a missing model", enabled: "auto", model: undefined, engaged: false },
  ] as const)("$name", ({ enabled, model, engaged }) => {
    expect(isCodeModeEngagedForModel({ enabled }, model)).toBe(engaged);
  });
});

describe("Code Mode guest source validation", () => {
  it("reports syntax errors at user-relative locations", () => {
    expect(parseCodeModeScriptSyntax("const x = ;")).toEqual({
      ok: false,
      message: "Unexpected token",
      line: 1,
      column: 10,
    });
  });

  it.each([
    {
      name: "import-shaped template text",
      code: "return `import('node:fs')`;",
    },
    {
      name: "require-shaped template text",
      code: "return `require('node:fs')`;",
    },
    {
      name: "import.meta-shaped template text",
      code: "return `import.meta.url`;",
    },
    {
      name: "escaped template interpolation",
      code: "return `\\${import('node:fs')}`;",
    },
    {
      name: "escaped template delimiter",
      code: "return `escaped \\` require('node:fs')`;",
    },
    {
      name: "astral Unicode before harmless template text",
      code: "const emoji = '😀'; return `import('node:fs') ${emoji}`;",
    },
    {
      name: "nested harmless template text",
      code: "return `outer ${`require('node:fs')`}`;",
    },
    {
      name: "object braces inside a template expression",
      code: "return `outer ${{ value: `import('node:fs')` }.value}`;",
    },
    {
      name: "quoted module text inside a template expression",
      code: "return `outer ${\"require('node:fs')\"}`;",
    },
    {
      name: "line-commented module access",
      code: "// require('node:fs')\nreturn 7;",
    },
    {
      name: "block-commented module access",
      code: "/* import('node:fs') */ return 7;",
    },
    {
      name: "quoted import.meta text",
      code: 'return "import.meta.url";',
    },
    {
      name: "module-shaped regular expression",
      code: 'return /import.meta/.test("import.meta");',
    },
    {
      name: "module-shaped regular expression after an assignment",
      code: 'const pattern = /import.meta/; return pattern.test("import.meta");',
    },
    {
      name: "module-shaped regular expression in a template expression",
      code: 'return `${/import.meta/.test("import.meta")}`;',
    },
    {
      name: "module-shaped regular expression after division",
      code: "return 10 / /import.meta/.source.length;",
    },
    {
      name: "module-shaped regular expression after a control condition",
      code: 'if (true) /import.meta/.test("import.meta"); return 7;',
    },
    {
      name: "module-shaped regular expression after nested control parentheses",
      code: 'if ((true)) /import.meta/.test("import.meta"); return 7;',
    },
    {
      name: "regular-expression character class with a slash",
      code: 'return /[a/]import.meta/.test("aimport.meta");',
    },
    {
      name: "regular expression after postfix-increment division",
      code: "let value = 10; return value++ / /import.meta/.source.length;",
    },
    {
      name: "regular expression after postfix-decrement division",
      code: "let value = 10; return value-- / /import.meta/.source.length;",
    },
    {
      name: "regular expression after contextual member division",
      code: "const value = { of: 10 }; return value.of / /import.meta/.source.length;",
    },
    {
      name: "regular expression after a keyword-shaped control method",
      code: "const value = { if() { return 10; } }; return value.if() / /import.meta/.source.length;",
    },
    {
      name: "regular expression after an optional keyword-shaped control method",
      code: "const value = { if() { return 10; } }; return value?.if() / /import.meta/.source.length;",
    },
    {
      name: "regular expression after a nested contextual await identifier",
      code: "function run() { const await = 10; return await / /import.meta/.source.length; } return run();",
    },
    {
      name: "regular expression after a keyword-shaped private member",
      code: "class Guest { #return = 10; run() { return this.#return / /import.meta/.source.length; } } return new Guest().run();",
    },
    {
      name: "ordinary import method",
      code: "const api = { import(value) { return value; } }; return api.import(42);",
    },
    {
      name: "ordinary require method",
      code: "const api = { require(value) { return value; } }; return api.require(42);",
    },
    {
      name: "optional ordinary import method",
      code: "const api = { import(value) { return value; } }; return api?.import?.(42);",
    },
    {
      name: "computed ordinary require method",
      code: 'const api = { require(value) { return value; } }; return api["require"](42);',
    },
    {
      name: "ordinary import metadata property",
      code: "const api = { import: { meta: 42 } }; return api.import.meta;",
    },
    {
      name: "ordinary malformed JavaScript for guest syntax diagnostics",
      code: "const answer = ;",
    },
  ])("preserves $name", async ({ code }) => {
    await expect(prepareSource({ code, config })).resolves.toBe(code);
  });

  it.each([
    {
      name: "direct require",
      code: "return require('node:fs');",
    },
    {
      name: "direct dynamic import",
      code: "return import('node:fs');",
    },
    {
      name: "direct import.meta",
      code: "return import.meta.url;",
    },
    {
      name: "comment-separated require",
      code: "return require /* hidden */ ('node:fs');",
    },
    {
      name: "Unicode-escaped direct require",
      code: String.raw`return r\u0065quire('node:fs');`,
    },
    {
      name: "optional direct require",
      code: "return require?.('node:fs');",
    },
    {
      name: "parenthesized direct require",
      code: "return (require)('node:fs');",
    },
    {
      name: "sequence-wrapped direct require",
      code: "return (0, require)('node:fs');",
    },
    {
      name: "comment-separated dynamic import",
      code: "return import /* hidden */ ('node:fs');",
    },
    {
      name: "dynamic import in template interpolation",
      code: "return `${import('node:fs')}`;",
    },
    {
      name: "require in template interpolation",
      code: "return `${require('node:fs')}`;",
    },
    {
      name: "dynamic import in nested template interpolation",
      code: "return `${`nested ${import('node:fs')}`}`;",
    },
    {
      name: "require in nested template interpolation",
      code: "return `${`nested ${require('node:fs')}`}`;",
    },
    {
      name: "dynamic import inside template-expression object braces",
      code: "return `${({ value: import('node:fs') }).value}`;",
    },
    {
      name: "require after a harmless template",
      code: "const message = `import('node:fs')`; return require('node:fs');",
    },
    {
      name: "dynamic import after a harmless regular expression",
      code: "const pattern = /import.meta/; return import('node:fs');",
    },
    {
      name: "dynamic import after division",
      code: "return 10 / import('node:fs');",
    },
    {
      name: "dynamic import after a regex and control condition",
      code: "if (true) /import.meta/.test('x'); return import('node:fs');",
    },
    {
      name: "dynamic import after postfix-increment division",
      code: "let value = 1; return value++ / import('node:fs');",
    },
    {
      name: "dynamic import after postfix-decrement division",
      code: "let value = 1; return value-- / import('node:fs');",
    },
    {
      name: "dynamic import after a contextual of property",
      code: "const value = { of: 1 }; return value.of / import('node:fs');",
    },
    {
      name: "dynamic import after a keyword-shaped return property",
      code: "const value = { return: 1 }; return value.return / import('node:fs');",
    },
    {
      name: "dynamic import after a keyword-shaped control method",
      code: "const value = { if() { return 1; } }; return value.if() / import('node:fs');",
    },
    {
      name: "dynamic import after an optional keyword-shaped return property",
      code: "const value = { return: 1 }; return value?.return / import('node:fs') / 1;",
    },
    {
      name: "require after an optional keyword-shaped return property",
      code: "const value = { return: 1 }; return value?.return / require('node:fs') / 1;",
    },
    {
      name: "dynamic import after an optional keyword-shaped control method",
      code: "const value = { if() { return 1; } }; return value?.if() / import('node:fs');",
    },
    {
      name: "dynamic import after a contextual of identifier",
      code: "const of = 1; return of / import('node:fs');",
    },
    {
      name: "dynamic import after a contextual yield identifier",
      code: "const yield = 1; return yield / import('node:fs');",
    },
    {
      name: "dynamic import after a nested contextual await identifier",
      code: "function run() { const await = 1; return await / (globalThis.pending = import('node:fs')); } run(); return globalThis.pending;",
    },
    {
      name: "dynamic import after a keyword-shaped private member",
      code: "class Guest { #return = 1; run() { return this.#return / (globalThis.pending = import('node:fs')); } } new Guest().run(); return globalThis.pending;",
    },
    {
      name: "require after a nested contextual await identifier",
      code: "function run() { const await = 1; return await / require('node:fs'); } return run();",
    },
    {
      name: "malformed input containing an executable module loader",
      code: "const answer = ; return import('node:fs');",
    },
    {
      name: "dynamic import after an astral-filled TypeScript string",
      code: `const label: string = "${"😀".repeat(96)}"; return import('node:fs');`,
    },
    {
      name: "require after an astral-filled TypeScript string",
      code: `const label: string = "${"😀".repeat(96)}"; return require('node:fs');`,
    },
  ])("rejects $name", async ({ code }) => {
    await expect(prepareSource({ code, config })).rejects.toThrow(
      "code mode module access is disabled",
    );
  });

  it.each([
    {
      name: "module-shaped regular expression after a type annotation",
      code: 'const value: number = 1; return /import.meta/.test("import.meta");',
    },
    {
      name: "module-shaped regular expression after astral Unicode",
      code: `const value: number = 1; const padding = "${"😀".repeat(12)}"; return /import.meta/.test("import.meta");`,
    },
    {
      name: "regular expression after an optional keyword-shaped property",
      code: "const value: { return: number } = { return: 10 }; return value?.return / /import.meta/.source.length;",
    },
    {
      name: "module-shaped nested template text",
      code: "const value: number = 1; return `outer ${`import('node:fs')`}`;",
    },
    {
      name: "module-shaped comment",
      code: "const value: number = 1; /* import('node:fs') */ return value;",
    },
    {
      name: "ordinary typed import method",
      code: "const api: { import(value: number): number } = { import(value) { return value; } }; return api.import(42);",
    },
    {
      name: "ordinary typed require method",
      code: "const api: { require(value: number): number } = { require(value) { return value; } }; return api.require(42);",
    },
  ])("preserves TypeScript $name", async ({ code }) => {
    await expect(prepareSource({ code, language: "typescript", config })).resolves.toEqual(
      expect.any(String),
    );
  });

  it("separates every deterministic literal and executable module-shaped input", async () => {
    const moduleExpressions = [
      "require('node:fs')",
      "import('node:fs')",
      "import.meta.url",
      'require /* comment */ ("node:fs")',
      'import /* comment */ ("node:fs")',
    ];

    for (const expression of moduleExpressions) {
      for (const harmless of [
        `return ${JSON.stringify(expression)};`,
        `return \`literal ${expression}\`;`,
      ]) {
        await expect(prepareSource({ code: harmless, config })).resolves.toBe(harmless);
      }
      for (const executable of [`return ${expression};`, `return \`value \${${expression}}\`;`]) {
        await expect(prepareSource({ code: executable, config })).rejects.toThrow(
          "code mode module access is disabled",
        );
      }
    }
  });

  it("distinguishes every adversarial division and regular-expression context", async () => {
    const divisionContexts = [
      { prefix: "let value = 10; return value++", suffix: "" },
      { prefix: "let value = 10; return value--", suffix: "" },
      { prefix: "const value = { of: 10 }; return value.of", suffix: "" },
      { prefix: "const value = { return: 10 }; return value.return", suffix: "" },
      { prefix: "const value = { if() { return 10; } }; return value.if()", suffix: "" },
      { prefix: "const value = { if() { return 10; } }; return value?.if()", suffix: "" },
      { prefix: "const of = 10; return of", suffix: "" },
      { prefix: "const yield = 10; return yield", suffix: "" },
      {
        prefix: "function run() { const await = 10; return await",
        suffix: " } return run();",
      },
      {
        prefix: "class Guest { #return = 10; run() { return this.#return",
        suffix: " } } return new Guest().run();",
      },
    ];

    for (const { prefix, suffix } of divisionContexts) {
      const harmless = `${prefix} / /import.meta/.source.length;${suffix}`;
      await expect(prepareSource({ code: harmless, config })).resolves.toBe(harmless);

      const executable = `${prefix} / import('node:fs');${suffix}`;
      await expect(prepareSource({ code: executable, config })).rejects.toThrow(
        "code mode module access is disabled",
      );
    }
  });

  it("separates ordinary methods from every disguised module loader", async () => {
    const harmlessMethods = [
      "api.import(value)",
      "api.require(value)",
      "api?.import?.(value)",
      'api["require"](value)',
    ];
    const moduleExpressions = [
      String.raw`r\u0065quire('node:fs')`,
      "require?.('node:fs')",
      "(require)('node:fs')",
      "(0, require)('node:fs')",
    ];

    for (const index of [0, 1, 9_999]) {
      for (const method of harmlessMethods) {
        const harmless = `const value = ${index}; const api = { import(value) { return value; }, require(value) { return value; } }; return ${method};`;
        await expect(prepareSource({ code: harmless, config })).resolves.toBe(harmless);
      }
    }
    for (const expression of moduleExpressions) {
      const executable = `return ${expression};`;
      await expect(prepareSource({ code: executable, config })).rejects.toThrow(
        "code mode module access is disabled",
      );
    }
  });

  it("rejects every Unicode-shifted TypeScript module-access offset", async () => {
    for (let length = 1; length <= 96; length += 1) {
      const padding = "😀".repeat(length);
      for (const access of ["import('node:fs')", "require('node:fs')"]) {
        await expect(
          prepareSource({
            code: `const label: string = "${padding}"; return ${access};`,
            language: "typescript",
            config,
          }),
        ).rejects.toThrow("code mode module access is disabled");
      }
    }
  }, 30_000);
});
