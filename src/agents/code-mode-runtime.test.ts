import { describe, expect, it } from "vitest";
import {
  captureCodeModeOutput,
  captureCodeModeValue,
  CodeModeOutputState,
} from "./code-mode-json.js";
import { isCodeModeEngagedForModel, resolveCodeModeConfig } from "./code-mode-runtime.js";
import { parseCodeModeScriptSyntax } from "./code-mode-script-syntax.js";
import { prepareSource } from "./code-mode-source.js";

const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

function projectResult(params: {
  output: unknown[];
  value?: unknown;
  error?: string;
  maxOutputBytes: number;
}) {
  const state = new CodeModeOutputState(params.maxOutputBytes);
  state.append(captureCodeModeOutput(params.output, params.maxOutputBytes));
  return state.take({
    ...(Object.hasOwn(params, "value")
      ? { value: captureCodeModeValue(params.value, params.maxOutputBytes) }
      : {}),
    ...(params.error === undefined ? {} : { error: params.error }),
  });
}

describe("Code Mode output bounding", () => {
  it("preserves Unicode output at its exact serialized byte limit", () => {
    const output = [{ type: "text", text: "😀 café".repeat(200) }];
    const maxOutputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");

    expect(projectResult({ output, maxOutputBytes }).output).toEqual(output);
    expect(output).toEqual([{ type: "text", text: "😀 café".repeat(200) }]);

    const bounded = projectResult({ output, maxOutputBytes: maxOutputBytes - 1 });
    expect(JSON.stringify(bounded.output)).toContain("rerun with narrower args");
  });

  it("bounds output and the returned value under one serialized budget", () => {
    const output = [{ type: "text", text: "😀".repeat(200) }];
    const value = { result: "café".repeat(200) };
    const maxOutputBytes =
      Buffer.byteLength(JSON.stringify(output), "utf8") +
      Buffer.byteLength(JSON.stringify(value), "utf8");

    expect(projectResult({ output, value, maxOutputBytes })).toMatchObject({
      output,
      value,
    });

    const bounded = projectResult({
      output,
      value,
      maxOutputBytes: maxOutputBytes - 1,
    });
    expect(
      Buffer.byteLength(JSON.stringify(bounded.output), "utf8") +
        Buffer.byteLength(JSON.stringify(bounded.value), "utf8"),
    ).toBeLessThanOrEqual(maxOutputBytes - 1);
  });

  it("does not charge an empty output array against the returned value", () => {
    const value = "ok";
    const maxOutputBytes = Buffer.byteLength(JSON.stringify(value), "utf8");

    expect(projectResult({ output: [], value, maxOutputBytes })).toMatchObject({
      output: [],
      value,
    });
  });

  it("preserves failure text and output at their exact serialized byte limit", () => {
    const output = [{ type: "text", text: "before failure" }];
    const error = "Error: café 😀";
    const maxOutputBytes =
      Buffer.byteLength(JSON.stringify(output), "utf8") +
      Buffer.byteLength(JSON.stringify(error), "utf8");

    expect(projectResult({ output, error, maxOutputBytes })).toEqual({
      output,
      error,
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
      const bounded = projectResult({
        output,
        error: `Error: ${errorText.repeat(1_000)}`,
        ...returned,
        maxOutputBytes,
      });

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

describe("Code Mode source retention", () => {
  it.each([65536, 10 * 1024 * 1024])(
    "retains at most %i source bytes per channel across repeated legs",
    (cap) => {
      const original = [{ type: "text", text: "🦞".repeat(Math.ceil(cap / 4)) }];
      const state = new CodeModeOutputState(cap);
      const leg = captureCodeModeOutput(original, cap);
      const value = captureCodeModeValue(original[0], cap);
      expect(Buffer.byteLength(leg.source.json)).toBeLessThanOrEqual(cap);
      expect(Buffer.byteLength(value.json)).toBeLessThanOrEqual(cap);
      for (let index = 1; index <= 8; index++) {
        state.append(leg);
        state.append(captureCodeModeOutput([], cap));
        expect(state.source.count).toBe(index);
        expect(Buffer.byteLength(state.source.source.json)).toBeLessThanOrEqual(cap);
        expect(state.source.source).toMatchObject({
          kind: "prefix",
          originalBytes: index * (Buffer.byteLength(JSON.stringify(original)) - 1) + 1,
        });
      }
      expect(state.source.source.json).toBe(leg.source.json);
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
    ["import-shaped template text", "return `import('node:fs')`;"],
    ["require-shaped template text", "return `require('node:fs')`;"],
    ["import.meta-shaped template text", "return `import.meta.url`;"],
    ["escaped template interpolation", "return `\\${import('node:fs')}`;"],
    ["escaped template delimiter", "return `escaped \\` require('node:fs')`;"],
    [
      "astral Unicode before harmless template text",
      "const emoji = '😀'; return `import('node:fs') ${emoji}`;",
    ],
    ["nested harmless template text", "return `outer ${`require('node:fs')`}`;"],
    [
      "object braces inside a template expression",
      "return `outer ${{ value: `import('node:fs')` }.value}`;",
    ],
    [
      "quoted module text inside a template expression",
      "return `outer ${\"require('node:fs')\"}`;",
    ],
    ["line-commented module access", "// require('node:fs')\nreturn 7;"],
    ["block-commented module access", "/* import('node:fs') */ return 7;"],
    ["quoted import.meta text", 'return "import.meta.url";'],
    ["module-shaped regular expression", 'return /import.meta/.test("import.meta");'],
    [
      "module-shaped regular expression after an assignment",
      'const pattern = /import.meta/; return pattern.test("import.meta");',
    ],
    [
      "module-shaped regular expression in a template expression",
      'return `${/import.meta/.test("import.meta")}`;',
    ],
    ["module-shaped regular expression after division", "return 10 / /import.meta/.source.length;"],
    [
      "module-shaped regular expression after a control condition",
      'if (true) /import.meta/.test("import.meta"); return 7;',
    ],
    [
      "module-shaped regular expression after nested control parentheses",
      'if ((true)) /import.meta/.test("import.meta"); return 7;',
    ],
    [
      "regular-expression character class with a slash",
      'return /[a/]import.meta/.test("aimport.meta");',
    ],
    [
      "regular expression after postfix-increment division",
      "let value = 10; return value++ / /import.meta/.source.length;",
    ],
    [
      "regular expression after postfix-decrement division",
      "let value = 10; return value-- / /import.meta/.source.length;",
    ],
    [
      "regular expression after contextual member division",
      "const value = { of: 10 }; return value.of / /import.meta/.source.length;",
    ],
    [
      "regular expression after a keyword-shaped control method",
      "const value = { if() { return 10; } }; return value.if() / /import.meta/.source.length;",
    ],
    [
      "regular expression after an optional keyword-shaped control method",
      "const value = { if() { return 10; } }; return value?.if() / /import.meta/.source.length;",
    ],
    [
      "regular expression after a nested contextual await identifier",
      "function run() { const await = 10; return await / /import.meta/.source.length; } return run();",
    ],
    [
      "regular expression after a keyword-shaped private member",
      "class Guest { #return = 10; run() { return this.#return / /import.meta/.source.length; } } return new Guest().run();",
    ],
    [
      "ordinary import method",
      "const api = { import(value) { return value; } }; return api.import(42);",
    ],
    [
      "ordinary require method",
      "const api = { require(value) { return value; } }; return api.require(42);",
    ],
    [
      "optional ordinary import method",
      "const api = { import(value) { return value; } }; return api?.import?.(42);",
    ],
    [
      "computed ordinary require method",
      'const api = { require(value) { return value; } }; return api["require"](42);',
    ],
    [
      "ordinary import metadata property",
      "const api = { import: { meta: 42 } }; return api.import.meta;",
    ],
    ["ordinary malformed JavaScript for guest syntax diagnostics", "const answer = ;"],
  ])("preserves %s", async (_name, code) => {
    await expect(prepareSource({ code, config })).resolves.toBe(code);
  });

  it.each([
    ["direct require", "return require('node:fs');"],
    ["direct dynamic import", "return import('node:fs');"],
    ["direct import.meta", "return import.meta.url;"],
    ["comment-separated require", "return require /* hidden */ ('node:fs');"],
    ["Unicode-escaped direct require", String.raw`return r\u0065quire('node:fs');`],
    ["optional direct require", "return require?.('node:fs');"],
    ["parenthesized direct require", "return (require)('node:fs');"],
    ["sequence-wrapped direct require", "return (0, require)('node:fs');"],
    ["comment-separated dynamic import", "return import /* hidden */ ('node:fs');"],
    ["dynamic import in template interpolation", "return `${import('node:fs')}`;"],
    ["require in template interpolation", "return `${require('node:fs')}`;"],
    [
      "dynamic import in nested template interpolation",
      "return `${`nested ${import('node:fs')}`}`;",
    ],
    ["require in nested template interpolation", "return `${`nested ${require('node:fs')}`}`;"],
    [
      "dynamic import inside template-expression object braces",
      "return `${({ value: import('node:fs') }).value}`;",
    ],
    [
      "require after a harmless template",
      "const message = `import('node:fs')`; return require('node:fs');",
    ],
    [
      "dynamic import after a harmless regular expression",
      "const pattern = /import.meta/; return import('node:fs');",
    ],
    ["dynamic import after division", "return 10 / import('node:fs');"],
    [
      "dynamic import after a regex and control condition",
      "if (true) /import.meta/.test('x'); return import('node:fs');",
    ],
    [
      "dynamic import after postfix-increment division",
      "let value = 1; return value++ / import('node:fs');",
    ],
    [
      "dynamic import after postfix-decrement division",
      "let value = 1; return value-- / import('node:fs');",
    ],
    [
      "dynamic import after a contextual of property",
      "const value = { of: 1 }; return value.of / import('node:fs');",
    ],
    [
      "dynamic import after a keyword-shaped return property",
      "const value = { return: 1 }; return value.return / import('node:fs');",
    ],
    [
      "dynamic import after a keyword-shaped control method",
      "const value = { if() { return 1; } }; return value.if() / import('node:fs');",
    ],
    [
      "dynamic import after an optional keyword-shaped return property",
      "const value = { return: 1 }; return value?.return / import('node:fs') / 1;",
    ],
    [
      "require after an optional keyword-shaped return property",
      "const value = { return: 1 }; return value?.return / require('node:fs') / 1;",
    ],
    [
      "dynamic import after an optional keyword-shaped control method",
      "const value = { if() { return 1; } }; return value?.if() / import('node:fs');",
    ],
    [
      "dynamic import after a contextual of identifier",
      "const of = 1; return of / import('node:fs');",
    ],
    [
      "dynamic import after a contextual yield identifier",
      "const yield = 1; return yield / import('node:fs');",
    ],
    [
      "dynamic import after a nested contextual await identifier",
      "function run() { const await = 1; return await / (globalThis.pending = import('node:fs')); } run(); return globalThis.pending;",
    ],
    [
      "dynamic import after a keyword-shaped private member",
      "class Guest { #return = 1; run() { return this.#return / (globalThis.pending = import('node:fs')); } } new Guest().run(); return globalThis.pending;",
    ],
    [
      "require after a nested contextual await identifier",
      "function run() { const await = 1; return await / require('node:fs'); } return run();",
    ],
    [
      "malformed input containing an executable module loader",
      "const answer = ; return import('node:fs');",
    ],
    [
      "dynamic import after an astral-filled TypeScript string",
      `const label: string = "${"😀".repeat(96)}"; return import('node:fs');`,
    ],
    [
      "require after an astral-filled TypeScript string",
      `const label: string = "${"😀".repeat(96)}"; return require('node:fs');`,
    ],
  ])("rejects %s", async (_name, code) => {
    await expect(prepareSource({ code, config })).rejects.toThrow(
      "code mode module access is disabled",
    );
  });

  it.each([
    [
      "module-shaped regular expression after a type annotation",
      'const value: number = 1; return /import.meta/.test("import.meta");',
    ],
    [
      "module-shaped regular expression after astral Unicode",
      `const value: number = 1; const padding = "${"😀".repeat(12)}"; return /import.meta/.test("import.meta");`,
    ],
    [
      "regular expression after an optional keyword-shaped property",
      "const value: { return: number } = { return: 10 }; return value?.return / /import.meta/.source.length;",
    ],
    [
      "module-shaped nested template text",
      "const value: number = 1; return `outer ${`import('node:fs')`}`;",
    ],
    ["module-shaped comment", "const value: number = 1; /* import('node:fs') */ return value;"],
    [
      "ordinary typed import method",
      "const api: { import(value: number): number } = { import(value) { return value; } }; return api.import(42);",
    ],
    [
      "ordinary typed require method",
      "const api: { require(value: number): number } = { require(value) { return value; } }; return api.require(42);",
    ],
  ])("preserves TypeScript %s", async (_name, code) => {
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
