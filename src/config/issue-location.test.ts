import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { renderConfigValidationIssueLines } from "./issue-location.js";
import type { ConfigFileSnapshot, ConfigValidationIssue } from "./types.js";

type PathSegment = string | number;

function renderIssue(params: {
  issue: ConfigValidationIssue;
  raw: string | null;
  parsed: unknown;
  effective: unknown;
}): string {
  return (
    renderConfigValidationIssueLines(
      {
        issues: [params.issue],
        raw: params.raw,
        parsed: params.parsed,
        sourceConfig: params.effective as ConfigFileSnapshot["sourceConfig"],
        path: "/tmp/openclaw.json",
      },
      "",
    )[0] ?? ""
  );
}

function formatConfigIssuePath(pathSegments: PathSegment[]): string {
  return renderIssue({
    issue: { path: pathSegments.join("."), pathSegments, message: "Invalid input" },
    raw: null,
    parsed: {},
    effective: {},
  }).replace(/: Invalid input$/, "");
}

function resolveConfigIssueLineInRaw(raw: string, pathSegments: PathSegment[]): number | undefined {
  let parsed: unknown = {};
  try {
    parsed = JSON5.parse(raw);
  } catch {
    // Malformed or empty text cannot own a source location.
  }
  const rendered = renderIssue({
    issue: { path: pathSegments.join("."), pathSegments, message: "Invalid input" },
    raw,
    parsed,
    effective: parsed,
  });
  const match = rendered.match(/^openclaw\.json:(\d+) — /);
  return match?.[1] ? Number(match[1]) : undefined;
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
  const rendered = renderIssue({
    issue: { path: pathValue, pathSegments, message },
    raw: JSON5.stringify(root),
    parsed: root,
    effective: root,
  });
  const issueText = rendered.split(" — ").at(-1) ?? rendered;
  return issueText.slice(issueText.indexOf(": ") + 2);
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

  it("normalizes an empty path to the root marker", () => {
    expect(formatConfigIssuePath([])).toBe("<root>");
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

describe("renderConfigValidationIssueLines", () => {
  const issue = (pathSegments: PathSegment[], message: string): ConfigValidationIssue => ({
    path: pathSegments.join("."),
    pathSegments,
    message,
  });

  it("combines display paths, source locations, and received values", () => {
    const raw = [
      "{",
      '  "agents": {',
      '    "list": [',
      '      { "tools": { "profile": "none" } }',
      "    ]",
      "  }",
      "}",
    ].join("\n");
    const config = { agents: { list: [{ tools: { profile: "none" } }] } };

    expect(
      renderIssue({
        issue: issue(
          ["agents", "list", 0, "tools", "profile"],
          'Invalid input (allowed: "minimal", "coding")',
        ),
        raw,
        parsed: config,
        effective: config,
      }),
    ).toBe(
      'openclaw.json:4 — agents.list[0].tools.profile: Invalid input (allowed: "minimal", "coding"), got: "none"',
    );
  });

  it("omits locations and received values for included config", () => {
    const config = { models: { providers: { openai: { api: "bad" } } } };
    expect(
      renderIssue({
        issue: issue(
          ["models", "providers", "openai", "api"],
          'Invalid input (allowed: "openai-chatgpt")',
        ),
        raw: '{ "$include": "./models.json" }',
        parsed: config,
        effective: config,
      }),
    ).toBe('models.providers.openai.api: Invalid input (allowed: "openai-chatgpt")');
  });

  it("uses structured paths to distinguish dotted keys from nested keys", () => {
    const config = { "foo.bar": "literal", foo: { bar: "nested" } };
    const raw = ['{ "foo.bar": "literal",', '  foo: { bar: "nested" } }'].join("\n");

    expect(
      renderIssue({
        issue: issue(["foo.bar"], "Invalid input"),
        raw,
        parsed: config,
        effective: config,
      }),
    ).toBe('openclaw.json:1 — foo.bar: Invalid input, got: "literal"');
    expect(
      renderIssue({
        issue: issue(["foo", "bar"], "Invalid input"),
        raw,
        parsed: config,
        effective: config,
      }),
    ).toBe('openclaw.json:2 — foo.bar: Invalid input, got: "nested"');
  });

  it("omits values changed by environment substitution", () => {
    expect(
      renderIssue({
        issue: issue(["gateway", "bind"], "Invalid input"),
        raw: '{ gateway: { bind: "${BIND}" } }',
        parsed: { gateway: { bind: "${BIND}" } },
        effective: { gateway: { bind: "lan" } },
      }),
    ).toBe("openclaw.json:1 — gateway.bind: Invalid input");
  });

  it.each(["custom", "vendor.plugin"])("omits plugin-owned values for %s", (pluginId) => {
    const config = {
      plugins: { entries: { [pluginId]: { config: { accessCode: "private" } } } },
    };
    expect(
      renderIssue({
        issue: issue(["plugins", "entries", pluginId, "config", "accessCode"], "Invalid input"),
        raw: JSON5.stringify(config),
        parsed: config,
        effective: config,
      }),
    ).toBe(`openclaw.json:1 — plugins.entries.${pluginId}.config.accessCode: Invalid input`);
  });
});
