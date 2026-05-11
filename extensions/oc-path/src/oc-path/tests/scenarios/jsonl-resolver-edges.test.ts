import { describe, expect, it } from "vitest";
import type { JsoncValue } from "../../jsonc/ast.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { resolveJsonlOcPath } from "../../jsonl/resolve.js";
import { parseOcPath } from "../../oc-path.js";

function rs(raw: string, ocPath: string) {
  return resolveJsonlOcPath(parseJsonl(raw).ast, parseOcPath(ocPath));
}

function expectNumberValue(node: JsoncValue, value: number) {
  expect(node.kind).toBe("number");
  if (node.kind === "number") {
    expect(node.value).toBe(value);
  }
}

function expectStringValue(node: JsoncValue, value: string) {
  expect(node.kind).toBe("string");
  if (node.kind === "string") {
    expect(node.value).toBe(value);
  }
}

describe("jsonl resolver edges", () => {
  it("root resolves with no segments", () => {
    expect(rs('{"a":1}\n', "oc://log")?.kind).toBe("root");
  });

  it("L1 resolves to a value line", () => {
    const m = rs('{"a":1}\n', "oc://log/L1");
    expect(m?.kind).toBe("line");
  });

  it("L99 unknown line returns null", () => {
    expect(rs('{"a":1}\n', "oc://log/L99")).toBeNull();
  });

  it("$last picks the most recent value line", () => {
    const m = rs('{"a":1}\n{"a":2}\n{"a":3}\n', "oc://log/$last/a");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expectNumberValue(m.node.value, 3);
    }
  });

  it("$last skips trailing blank lines", () => {
    const m = rs('{"a":1}\n\n\n', "oc://log/$last/a");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expectNumberValue(m.node.value, 1);
    }
  });

  it("$last skips trailing malformed lines", () => {
    const m = rs('{"a":1}\nbroken\n', "oc://log/$last/a");
    expect(m?.kind).toBe("object-entry");
  });

  it("$last on empty file returns null", () => {
    expect(rs("", "oc://log/$last/x")).toBeNull();
  });

  it("$last on all-blank file returns null", () => {
    expect(rs("\n\n\n", "oc://log/$last/x")).toBeNull();
  });

  it("$last on all-malformed file returns null", () => {
    expect(rs("a\nb\nc\n", "oc://log/$last/x")).toBeNull();
  });

  it("garbage line address returns null", () => {
    expect(rs('{"a":1}\n', "oc://log/garbage")).toBeNull();
    expect(rs('{"a":1}\n', "oc://log/L")).toBeNull();
    expect(rs('{"a":1}\n', "oc://log/Labc")).toBeNull();
  });

  it("descent into a blank line returns null", () => {
    expect(rs('{"a":1}\n\n{"b":2}\n', "oc://log/L2/anything")).toBeNull();
  });

  it("descent into a malformed line returns null", () => {
    expect(rs('{"a":1}\nbroken\n{"b":2}\n', "oc://log/L2/anything")).toBeNull();
  });

  it("missing field on a value line returns null", () => {
    expect(rs('{"a":1}\n', "oc://log/L1/missing")).toBeNull();
  });

  it("dotted descent through line value resolves", () => {
    const m = rs('{"r":{"ok":true,"d":"x"}}\n', "oc://log/L1/r.d");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expectStringValue(m.node.value, "x");
    }
  });

  it("array index inside a line resolves", () => {
    const m = rs('{"items":["a","b","c"]}\n', "oc://log/L1/items.2");
    expect(m?.kind).toBe("value");
    if (m?.kind === "value") {
      expectStringValue(m.node, "c");
    }
  });

  it("line numbers are 1-indexed", () => {
    const m = rs('{"a":1}\n{"a":2}\n', "oc://log/L1/a");
    if (m?.kind === "object-entry") {
      expectNumberValue(m.node.value, 1);
    }
  });

  it("line numbers preserved across blank/malformed entries", () => {
    const m = rs('{"a":1}\n\nbroken\n{"a":4}\n', "oc://log/L4/a");
    expect(m?.kind).toBe("object-entry");
    if (m?.kind === "object-entry") {
      expectNumberValue(m.node.value, 4);
    }
  });

  it("resolver is non-mutating", () => {
    const { ast } = parseJsonl('{"a":1}\n{"b":2}\n');
    const before = JSON.stringify(ast);
    rs('{"a":1}\n{"b":2}\n', "oc://log/L1");
    rs('{"a":1}\n{"b":2}\n', "oc://log/$last");
    expect(JSON.stringify(ast)).toBe(before);
  });

  it("hostile inputs do not throw", () => {
    expect(() => rs("not json\n", "oc://log/L1")).not.toThrow();
    expect(() => rs("", "oc://log/$last")).not.toThrow();
  });
});
