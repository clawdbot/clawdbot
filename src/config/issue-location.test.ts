import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { attachConfigIssueDiagnostics } from "./issue-location.js";

type PathSegment = string | number;

function formatConfigIssuePath(pathSegments: PathSegment[]): string {
  return (
    attachConfigIssueDiagnostics(
      [{ path: pathSegments.join("."), pathSegments, message: "Invalid input" }],
      { raw: null, parsed: {}, effective: {}, formatPathForDisplay: true },
    )[0]?.path ?? ""
  );
}

function resolveConfigIssueLineInRaw(raw: string, pathSegments: PathSegment[]): number | undefined {
  let parsed: unknown = {};
  try {
    parsed = JSON5.parse(raw);
  } catch {
    // Malformed or empty text cannot own a source location.
  }
  return attachConfigIssueDiagnostics(
    [{ path: pathSegments.join("."), pathSegments, message: "Invalid input" }],
    { raw, parsed, effective: parsed },
  )[0]?.line;
}

function appendReceivedValueHint(message: string, pathValue: string, value: unknown): string {
  const pathSegments = pathValue.split(".");
  const root: Record<string, unknown> = {};
  let current = root;
  for (const segment of pathSegments.slice(0, -1)) {
    const child: Record<string, unknown> = {};
    current[segment] = child;
    current = child;
  }
  current[pathSegments.at(-1) ?? ""] = value;
  return (
    attachConfigIssueDiagnostics([{ path: pathValue, pathSegments, message }], {
      raw: JSON5.stringify(root),
      parsed: root,
      effective: root,
      includeReceivedValueHint: true,
    })[0]?.message ?? message
  );
}

describe("formatConfigIssuePath", () => {
  it("formats numeric segments with bracket notation", () => {
    expect(formatConfigIssuePath(["agents", "list", 3, "tools", "profile"])).toBe(
      "agents.list[3].tools.profile",
    );
  });

  it("handles consecutive numeric indices", () => {
    expect(formatConfigIssuePath(["a", 0, "b", 1])).toBe("a[0].b[1]");
  });

  it("returns empty string for empty path", () => {
    expect(formatConfigIssuePath([])).toBe("");
  });

  it("handles all-string path", () => {
    expect(formatConfigIssuePath(["foo", "bar", "baz"])).toBe("foo.bar.baz");
  });
});

describe("resolveConfigIssueLineInRaw", () => {
  it("resolves line number for nested array object values", () => {
    const raw = [
      "{",
      '  "agents": {',
      '    "list": [',
      "      {",
      '        "id": "main"',
      "      },",
      "      {",
      '        "tools": {',
      '          "profile": "none"',
      "        }",
      "      }",
      "    ]",
      "  }",
      "}",
    ].join("\n");

    expect(resolveConfigIssueLineInRaw(raw, ["agents", "list", 1, "tools", "profile"])).toBe(9);
  });

  it("resolves line number for top-level key", () => {
    const raw = ["{", '  "update": {', '    "channel": "nightly"', "  }", "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["update", "channel"])).toBe(3);
  });

  it("returns undefined for path not in raw text", () => {
    const raw = ["{", "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["nonexistent"])).toBeUndefined();
  });

  it("handles JSON5 comments", () => {
    const raw = ["{", "  // comment", '  "key": "value"', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["key"])).toBe(3);
  });

  it("handles comments between unquoted keys and colons", () => {
    const raw = ["{", "  key // comment", '  : "value"', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["key"])).toBe(3);
  });

  it("handles comments directly after scalar values", () => {
    const raw = ["{", "  ignored: 1 // comment", '  , target: "bad"', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["target"])).toBe(3);
  });

  it("uses the active value when an object repeats a key", () => {
    const raw = ["{", '  key: "old",', '  key: "bad"', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["key"])).toBe(3);
  });

  it("handles single-quoted strings", () => {
    const raw = ["{", "  'key': 'value'", "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["key"])).toBe(2);
  });

  it("handles hex numbers as values", () => {
    const raw = ["{", '  "a": 0x1A,', '  "b": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["b"])).toBe(3);
  });

  it("handles leading decimal numbers", () => {
    const raw = ["{", '  "a": .5,', '  "b": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["b"])).toBe(3);
  });

  it("handles Infinity value", () => {
    const raw = ["{", '  "a": Infinity,', '  "b": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["b"])).toBe(3);
  });

  it("handles NaN value", () => {
    const raw = ["{", '  "a": NaN,', '  "b": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["b"])).toBe(3);
  });

  it("handles null and boolean values", () => {
    const raw = ["{", '  "a": null, "b": true, "c": false', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["a"])).toBe(2);
    expect(resolveConfigIssueLineInRaw(raw, ["b"])).toBe(2);
    expect(resolveConfigIssueLineInRaw(raw, ["c"])).toBe(2);
  });

  it("handles trailing commas in objects", () => {
    const raw = ["{", '  "a": 1,', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["a"])).toBe(2);
  });

  it("handles trailing commas in arrays", () => {
    const raw = ["{", '  "a": [1, 2,]', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["a"])).toBe(2);
  });

  it("handles deeply nested arrays", () => {
    const raw = ["{", '  "a": { "b": { "c": [1, [2, [3]]] } } }', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["a", "b", "c", 1, 0])).toBe(2);
  });

  it("handles unicode escape sequences in strings", () => {
    const raw = ["{", '  "a": "hello \\u0041",', '  "b": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["b"])).toBe(3);
  });

  it("handles multi-line string continuation", () => {
    const raw = ["{", '  "a": "hello \\', 'world",', '  "b": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["b"])).toBe(4);
  });

  it("handles unicode keys", () => {
    const raw = ["{", '  "café": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["café"])).toBe(2);
  });

  it("handles escaped quotes in strings", () => {
    const raw = ["{", '  "a": "hello \\"world\\"",', '  "b": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["b"])).toBe(3);
  });

  it("handles block comments before keys", () => {
    const raw = ["{", "  /* comment */", '  "key": "value"', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["key"])).toBe(3);
  });

  it("handles mixed single/double quotes", () => {
    const raw = ["{", "  'key': \"value\"", "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["key"])).toBe(2);
  });

  it("handles empty object value", () => {
    const raw = ["{", '  "a": {}', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["a"])).toBe(2);
  });

  it("handles empty array value", () => {
    const raw = ["{", '  "a": []', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["a"])).toBe(2);
  });

  it("handles array index navigation with nested objects", () => {
    const raw = [
      "{",
      '  "agents": {',
      '    "list": [',
      "      {",
      '        "id": "main"',
      "      },",
      "      {",
      '        "tools": {',
      '          "profile": "none"',
      "        }",
      "      }",
      "    ]",
      "  }",
      "}",
    ].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["agents", "list", 1, "tools", "profile"])).toBe(9);
  });

  it("gracefully degrades for unresolvable paths", () => {
    const raw = ["{", '  "a": 1', "}"].join("\n");
    expect(resolveConfigIssueLineInRaw(raw, ["nonexistent"])).toBeUndefined();
    expect(resolveConfigIssueLineInRaw(raw, ["a", "b"])).toBeUndefined();
    expect(resolveConfigIssueLineInRaw(raw, ["a", 0])).toBeUndefined();
  });

  it("handles empty raw text", () => {
    expect(resolveConfigIssueLineInRaw("", ["a"])).toBeUndefined();
    expect(resolveConfigIssueLineInRaw("  ", ["a"])).toBeUndefined();
  });
});

describe("appendReceivedValueHint", () => {
  it("appends got: for simple values", () => {
    expect(
      appendReceivedValueHint(
        'Invalid input (allowed: "minimal", "coding")',
        "agents.list[0].tools.profile",
        "none",
      ),
    ).toBe('Invalid input (allowed: "minimal", "coding"), got: "none"');
  });

  it("keeps truncated received values on a valid UTF-16 boundary", () => {
    const message = appendReceivedValueHint(
      "invalid input",
      "gateway.bind",
      `${"x".repeat(155)}🎉tail`,
    );
    expect(message).toBe(`invalid input, got: "${"x".repeat(155)}...`);
  });

  it("skips when message already mentions received", () => {
    expect(appendReceivedValueHint("expected string, received number", "gateway.port", 18789)).toBe(
      "expected string, received number",
    );
  });

  it("skips sensitive paths", () => {
    expect(appendReceivedValueHint("invalid token", "channels.telegram.botToken", "abc123")).toBe(
      "invalid token",
    );
  });

  it("skips secret ref objects", () => {
    expect(
      appendReceivedValueHint("invalid input", "models.providers.openai.apiKey", {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      }),
    ).toBe("invalid input");
  });

  it("skips object values", () => {
    expect(appendReceivedValueHint("invalid input", "some.path", { nested: true })).toBe(
      "invalid input",
    );
  });

  it("skips undefined values", () => {
    expect(appendReceivedValueHint("invalid input", "some.path", undefined)).toBe("invalid input");
  });

  it("skips when message already has got:", () => {
    expect(appendReceivedValueHint("already got: something", "some.path", "value")).toBe(
      "already got: something",
    );
  });

  it.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    [-0, "-0"],
  ])("renders JSON5 number %s without coercing it to null", (value, label) => {
    expect(appendReceivedValueHint("invalid input", "some.path", value)).toBe(
      `invalid input, got: ${label}`,
    );
  });
});

describe("attachConfigIssueDiagnostics", () => {
  const issue = (
    pathSegments: Array<string | number>,
    message: string,
    extra: { allowedValues?: string[] } = {},
  ) => ({ path: pathSegments.join("."), pathSegments, message, ...extra });
  const raw = [
    "{",
    '  "agents": {',
    '    "list": [',
    '      { "tools": { "profile": "none" } }',
    "    ]",
    "  }",
    "}",
  ].join("\n");

  const parsed = {
    agents: { list: [{ tools: { profile: "none" } }] },
  };

  it("preserves internal path by default", () => {
    const issues = attachConfigIssueDiagnostics(
      [
        issue(
          ["agents", "list", 0, "tools", "profile"],
          'Invalid input (allowed: "minimal", "coding")',
          {
            allowedValues: ["minimal", "coding"],
          },
        ),
      ],
      { raw, parsed, effective: parsed, configPath: "/tmp/openclaw.json" },
    );

    expect(issues[0]?.path).toBe("agents.list.0.tools.profile");
    expect(issues[0]?.message).toBe('Invalid input (allowed: "minimal", "coding")');
    expect(issues[0]?.line).toBe(4);
    expect(issues[0]?.sourceFile).toBe("openclaw.json");
  });

  it("formats display path when requested", () => {
    const issues = attachConfigIssueDiagnostics(
      [
        issue(
          ["agents", "list", 0, "tools", "profile"],
          'Invalid input (allowed: "minimal", "coding")',
          {
            allowedValues: ["minimal", "coding"],
          },
        ),
      ],
      {
        raw,
        parsed,
        effective: parsed,
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.path).toBe("agents.list[0].tools.profile");
    expect(issues[0]?.message).toContain('got: "none"');
    expect(issues[0]?.line).toBe(4);
  });

  it("handles empty raw gracefully", () => {
    const issues = attachConfigIssueDiagnostics([issue(["foo"], "error")], {
      raw: null,
      parsed: {},
      effective: {},
      configPath: "/tmp/openclaw.json",
    });

    expect(issues[0]?.line).toBeUndefined();
    expect(issues[0]?.sourceFile).toBeUndefined();
  });

  it("handles $include'd paths gracefully (navigator returns undefined)", () => {
    const issues = attachConfigIssueDiagnostics(
      [
        issue(
          ["models", "providers", "openai", "api"],
          'Invalid input (allowed: "openai-chatgpt")',
        ),
      ],
      {
        raw: ["{", '  "$include": "./models.json"', "}"].join("\n"),
        parsed: { models: { providers: { openai: { api: "bad" } } } },
        effective: { models: { providers: { openai: { api: "bad" } } } },
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    // Path exists in parsed but not in raw — no line number, no received value
    expect(issues[0]?.line).toBeUndefined();
    expect(issues[0]?.sourceFile).toBeUndefined();
    expect(issues[0]?.message).toBe('Invalid input (allowed: "openai-chatgpt")');
  });

  it("preserves numeric record keys (not array indices)", () => {
    const issues = attachConfigIssueDiagnostics(
      [issue(["plugins", "entries", "123", "config", "mode"], 'Invalid input (allowed: "good")')],
      {
        raw: [
          "{",
          '  "plugins": {',
          '    "entries": {',
          '      "123": { "config": { "mode": "bad" } }',
          "    }",
          "  }",
          "}",
        ].join("\n"),
        parsed: { plugins: { entries: { "123": { config: { mode: "bad" } } } } },
        effective: { plugins: { entries: { "123": { config: { mode: "bad" } } } } },
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.path).toBe("plugins.entries.123.config.mode");
    expect(issues[0]?.message).toBe('Invalid input (allowed: "good")');
    expect(issues[0]?.line).toBe(4);
  });

  it("preserves non-canonical numeric record keys", () => {
    const recordConfig = { records: { "01": { mode: "bad" }, "1": { mode: "good" } } };
    const issues = attachConfigIssueDiagnostics(
      [issue(["records", "01", "mode"], "Invalid input")],
      {
        raw: '{ records: { "01": { mode: "bad" }, "1": { mode: "good" } } }',
        parsed: recordConfig,
        effective: recordConfig,
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]).toMatchObject({
      path: "records.01.mode",
      message: 'Invalid input, got: "bad"',
      line: 1,
    });
  });

  it("uses structured paths to distinguish dotted keys from nested keys", () => {
    const dottedConfig = { "foo.bar": "literal", foo: { bar: "nested" } };
    const params = {
      raw: ['{ "foo.bar": "literal",', '  foo: { bar: "nested" } }'].join("\n"),
      parsed: dottedConfig,
      effective: dottedConfig,
      configPath: "/tmp/openclaw.json",
      formatPathForDisplay: true,
      includeReceivedValueHint: true,
    };

    expect(
      attachConfigIssueDiagnostics([issue(["foo.bar"], "Invalid input")], params)[0],
    ).toMatchObject({
      message: 'Invalid input, got: "literal"',
      line: 1,
    });
    expect(
      attachConfigIssueDiagnostics([issue(["foo", "bar"], "Invalid input")], params)[0],
    ).toMatchObject({
      message: 'Invalid input, got: "nested"',
      line: 2,
    });
  });

  it("does not let existing values steal missing dotted or nested paths", () => {
    const dottedConfig = { "foo.bar": "literal", foo: {} };
    const params = {
      raw: ['{ "foo.bar": "literal",', "  foo: {} }"].join("\n"),
      parsed: dottedConfig,
      effective: dottedConfig,
      configPath: "/tmp/openclaw.json",
      formatPathForDisplay: true,
      includeReceivedValueHint: true,
    };

    expect(attachConfigIssueDiagnostics([issue(["foo", "bar"], "Required")], params)[0]).toEqual(
      issue(["foo", "bar"], "Required"),
    );
    const nestedOnly = { foo: { bar: "nested" } };
    expect(
      attachConfigIssueDiagnostics([issue(["foo.bar"], "Required")], {
        ...params,
        raw: '{ foo: { bar: "nested" } }',
        parsed: nestedOnly,
        effective: nestedOnly,
      })[0],
    ).toEqual(issue(["foo.bar"], "Required"));
  });

  it("omits values changed by environment substitution", () => {
    const envRaw = raw.replace('"none"', '"${PROFILE}"');
    const issues = attachConfigIssueDiagnostics(
      [issue(["agents", "list", 0, "tools", "profile"], "Invalid input")],
      {
        raw: envRaw,
        parsed: { agents: { list: [{ tools: { profile: "${PROFILE}" } }] } },
        effective: { agents: { list: [{ tools: { profile: "none" } }] } },
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.message).toBe("Invalid input");
    expect(issues[0]?.line).toBe(4);
  });

  it("omits arbitrary plugin-owned values", () => {
    const pluginConfig = {
      plugins: { entries: { custom: { config: { accessCode: "private" } } } },
    };
    const issues = attachConfigIssueDiagnostics(
      [issue(["plugins", "entries", "custom", "config", "accessCode"], "Invalid input")],
      {
        raw: '{ plugins: { entries: { custom: { config: { accessCode: "private" } } } } }',
        parsed: pluginConfig,
        effective: pluginConfig,
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.message).toBe("Invalid input");
    expect(issues[0]?.line).toBe(1);
  });

  it("omits plugin-owned values when the plugin id contains dots", () => {
    const pluginConfig = {
      plugins: { entries: { "vendor.plugin": { config: { sessionValue: "private" } } } },
    };
    const issues = attachConfigIssueDiagnostics(
      [issue(["plugins", "entries", "vendor.plugin", "config", "sessionValue"], "Invalid input")],
      {
        raw: '{ plugins: { entries: { "vendor.plugin": { config: { sessionValue: "private" } } } } }',
        parsed: pluginConfig,
        effective: pluginConfig,
        configPath: "/tmp/openclaw.json",
        formatPathForDisplay: true,
        includeReceivedValueHint: true,
      },
    );

    expect(issues[0]?.message).toBe("Invalid input");
    expect(issues[0]?.line).toBe(1);
  });
});
