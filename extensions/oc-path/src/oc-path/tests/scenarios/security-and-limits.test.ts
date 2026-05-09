import { describe, expect, it } from "vitest";
import {
  MAX_PATH_LENGTH,
  MAX_TRAVERSAL_DEPTH,
  OcPathError,
  findOcPaths,
  formatOcPath,
  parseOcPath,
  resolveOcPath,
  setOcPath,
} from "../../index.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { parseJsonl } from "../../jsonl/parse.js";


describe("encoding edges", () => {
  it("strips leading UTF-8 BOM from path string", () => {
    expect(parseOcPath("﻿oc://X/Y").file).toBe("X");
  });

  it("normalizes path segments to NFC", () => {
    const nfc = "café";
    const nfd = "café"; // decomposed
    expect(parseOcPath(`oc://X/${nfd}`)).toEqual(parseOcPath(`oc://X/${nfc}`));
  });

  it("rejects whitespace inside identifier-shaped segments", () => {
    expect(() => parseOcPath("oc://X/foo /bar")).toThrow(OcPathError);
    expect(() => parseOcPath("oc://X/foo\tbar")).toThrow(OcPathError);
  });

  it("rejects control characters and NUL bytes anywhere in the path", () => {
    expect(() => parseOcPath("oc://X/\x00")).toThrow(/Control character/);
    expect(() => parseOcPath("oc://X/foo\x01bar")).toThrow(/Control character/);
    expect(() => parseOcPath("oc://X/foo\x7Fbar")).toThrow(/Control character/);
    expect(() => parseOcPath("oc://X.md/items/[k=a\x00b]")).toThrow(OcPathError);
  });
});


describe("file-slot containment", () => {
  it("rejects absolute POSIX file slot", () => {
    expect(() => parseOcPath("oc:///etc/passwd")).toThrow(/Empty segment/);
    expect(() => parseOcPath('oc://"/etc/passwd"/section')).toThrow(/Absolute file slot/);
  });

  it("rejects Windows drive-letter file slot", () => {
    expect(() => parseOcPath('oc://"C:/Windows/System32/foo"/section')).toThrow(
      /Absolute file slot/,
    );
    // `\` inside quoted segments is rejected outright (no escape support).
    expect(() => parseOcPath('oc://"C:\\\\Windows\\\\System32"/section')).toThrow(OcPathError);
  });

  it("rejects leading-backslash UNC path", () => {
    expect(() => parseOcPath('oc://"\\\\srv\\\\share\\\\foo"/section')).toThrow(OcPathError);
  });

  it("rejects parent-directory escapes", () => {
    expect(() => parseOcPath('oc://"../foo"/section')).toThrow(/Parent-directory/);
    expect(() => parseOcPath('oc://"foo/../bar"/section')).toThrow(/Parent-directory/);
  });

  it("does not URL-decode `%2E%2E` — substrate isn't an HTTP layer", () => {
    expect(parseOcPath('oc://"%2E%2E/foo"/section').file).toBe("%2E%2E/foo");
  });

  it("formatOcPath rejects absolute and parent-directory file slots", () => {
    expect(() => formatOcPath({ file: "/etc/passwd" })).toThrow(/Absolute file slot/);
    expect(() => formatOcPath({ file: "C:/Windows" })).toThrow(/Absolute file slot/);
    expect(() => formatOcPath({ file: ".." })).toThrow(/Parent-directory/);
    expect(() => formatOcPath({ file: "foo/../bar" })).toThrow(/Parent-directory/);
  });
});


describe("path-string and traversal caps", () => {
  it("parseOcPath rejects strings longer than MAX_PATH_LENGTH", () => {
    expect(() => parseOcPath("oc://X/" + "a".repeat(MAX_PATH_LENGTH))).toThrow(/exceeds .* bytes/);
  });

  it("parseOcPath accepts a path right at the cap", () => {
    const justUnder = "oc://X/" + "a".repeat(MAX_PATH_LENGTH - "oc://X/".length);
    expect(() => parseOcPath(justUnder)).not.toThrow();
  });

  it("formatOcPath enforces the same cap on output", () => {
    expect(() => formatOcPath({ file: "X", section: "a".repeat(MAX_PATH_LENGTH) })).toThrow(
      /Formatted oc:\/\/ exceeds/,
    );
  });

  it("walker depth cap fires on synthetic deeply-nested AST", () => {
    // Bypasses parser depth cap so the walker defense fires in isolation.
    type V = import("../../jsonc/ast.js").JsoncValue;
    let leaf: V = { kind: "string", value: "x", line: 1 };
    for (let i = 0; i < MAX_TRAVERSAL_DEPTH + 50; i++) {
      leaf = { kind: "object", entries: [{ key: "a", value: leaf, line: 1 }], line: 1 };
    }
    const ast = {
      kind: "jsonc" as const,
      raw: "",
      root: { kind: "object" as const, entries: [{ key: "root", value: leaf, line: 1 }], line: 1 },
    };
    expect(() => findOcPaths(ast, parseOcPath("oc://X/**"))).toThrow(/MAX_TRAVERSAL_DEPTH/);
  });

  it("jsonc parser surfaces a structured diagnostic on pathological nesting", () => {
    const open = "[".repeat(MAX_TRAVERSAL_DEPTH + 100);
    const close = "]".repeat(MAX_TRAVERSAL_DEPTH + 100);
    const result = parseJsonc(`${open}0${close}`);
    expect(result.ast.root).toBeNull();
    expect(result.diagnostics.some((d) => d.code === "OC_JSONC_DEPTH_EXCEEDED")).toBe(true);
  });

  it("jsonl per-line parser flags malformed deeply-nested values", () => {
    let nested = '"x"';
    for (let i = 0; i < MAX_TRAVERSAL_DEPTH + 50; i++) {
      nested = `{"a":${nested}}`;
    }
    const { diagnostics } = parseJsonl(nested + "\n");
    expect(diagnostics.some((d) => d.code === "OC_JSONL_LINE_MALFORMED")).toBe(true);
  });
});


describe("sentinel literal at format boundary", () => {
  it("formatOcPath rejects a struct carrying the redaction sentinel", () => {
    expect(() => formatOcPath({ file: "AGENTS.md", section: "__OPENCLAW_REDACTED__" })).toThrow(
      /sentinel literal/,
    );
  });
});


describe("numeric segments dispatch by node kind", () => {
  it("negative numeric key on object resolves as literal key (openclaw#59934)", () => {
    // Telegram supergroup IDs are negative numbers used as map keys.
    const ast = parseJsonc(
      '{"channels":{"telegram":{"groups":{"-5028303500":{"requireMention":false}}}}}',
    ).ast;
    const m = resolveOcPath(
      ast,
      parseOcPath("oc://config/channels.telegram.groups.-5028303500.requireMention"),
    );
    expect(m?.kind).toBe("leaf");
  });

  it("`$last` literal key on an object is shadowed by the positional sentinel", () => {
    const ast = parseJsonc('{"$last":"literal-value","foo":"bar"}').ast;
    const m = resolveOcPath(ast, parseOcPath("oc://X/$last"));
    expect(m?.kind === "leaf" && m.valueText).toBe("bar");
  });
});


describe("setOcPath value coercion is locale-independent and exact-match", () => {
  it("number coercion accepts `1.5`, refuses `1,5`", () => {
    const ast = parseJsonc('{"x":1.0}').ast;
    expect(setOcPath(ast, parseOcPath("oc://X/x"), "1.5").ok).toBe(true);
    const r = setOcPath(ast, parseOcPath("oc://X/x"), "1,5");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });

  it("boolean coercion accepts `true` / `false` only", () => {
    const ast = parseJsonc('{"x":true}').ast;
    expect(setOcPath(ast, parseOcPath("oc://X/x"), "false").ok).toBe(true);
    expect(setOcPath(ast, parseOcPath("oc://X/x"), "False").ok).toBe(false);
    expect(setOcPath(ast, parseOcPath("oc://X/x"), "TRUE").ok).toBe(false);
    expect(setOcPath(ast, parseOcPath("oc://X/x"), "yes").ok).toBe(false);
  });
});


describe("predicate-value injection is contained", () => {
  it("regex metacharacters in predicate value match literally, not as regex", () => {
    const ast = parseJsonc('{"items":[{"name":"a.*"},{"name":"abc"}]}').ast;
    const matches = findOcPaths(ast, parseOcPath("oc://X.jsonc/items/[name=a.*]"));
    expect(matches).toHaveLength(1);
  });

  it("equals-sign in predicate value is treated as part of the value", () => {
    const ast = parseJsonc('{"items":[{"k":"a=b"},{"k":"c"}]}').ast;
    const matches = findOcPaths(ast, parseOcPath("oc://X.jsonc/items/[k=a=b]"));
    expect(matches).toHaveLength(1);
  });

  it("predicate-shaped bracket without operator is a literal sentinel", () => {
    expect(parseOcPath("oc://X.jsonc/items/[name]").item).toBe("[name]");
  });

  it("rejects empty predicate body and empty key/value", () => {
    expect(() => parseOcPath("oc://X.jsonc/items/[]")).toThrow(OcPathError);
    expect(() => parseOcPath("oc://X/[=foo]")).toThrow(/Malformed predicate/);
    expect(() => parseOcPath("oc://X/[id=]")).toThrow(/Malformed predicate/);
  });

  it("predicate value containing `/` round-trips and matches literally", () => {
    const p = parseOcPath("oc://X/[id=foo/bar]/cmd");
    expect(p.section).toBe("[id=foo/bar]");
    const ast = parseJsonc('{"steps":[{"id":"foo/bar","cmd":"x"},{"id":"baz","cmd":"y"}]}').ast;
    const matches = findOcPaths(ast, parseOcPath("oc://wf/steps/[id=foo/bar]/cmd"));
    expect(matches).toHaveLength(1);
  });

  it("predicate value containing `.` round-trips and matches literally", () => {
    const ast = parseJsonc('{"steps":[{"id":"1.0","cmd":"x"},{"id":"2.0","cmd":"y"}]}').ast;
    const matches = findOcPaths(ast, parseOcPath("oc://wf/steps/[id=1.0]/cmd"));
    expect(matches).toHaveLength(1);
  });
});


describe("structural rejection", () => {
  it("rejects mismatched brackets and braces", () => {
    expect(() => parseOcPath("oc://X/[unclosed")).toThrow(OcPathError);
    expect(() => parseOcPath("oc://X/closed]")).toThrow(OcPathError);
    expect(() => parseOcPath("oc://X/{a,b")).toThrow(OcPathError);
  });

  it("rejects empty union and empty alternative", () => {
    expect(() => parseOcPath("oc://X/{}")).toThrow(/Empty union/);
    expect(() => parseOcPath("oc://X/{a,,b}")).toThrow(/Empty alternative/);
  });

  it("rejects empty dotted sub-segment in formatOcPath output", () => {
    expect(() => formatOcPath({ file: "a.md", section: "foo." })).toThrow(/Empty dotted/);
    expect(() => formatOcPath({ file: "a.md", section: ".foo" })).toThrow(/Empty dotted/);
    expect(() => formatOcPath({ file: "a.md", section: "foo..bar" })).toThrow(/Empty dotted/);
  });

  it("rejects unescaped `&` and `%` in segments", () => {
    expect(() => parseOcPath("oc://X.md/a&b")).toThrow(OcPathError);
    expect(() => parseOcPath("oc://X.md/a%b")).toThrow(OcPathError);
  });
});
