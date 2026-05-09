import { describe, expect, it } from "vitest";
import { appendJsonlOcPath, setJsonlOcPath } from "../../jsonl/edit.js";
import { emitJsonl } from "../../jsonl/emit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { parseOcPath } from "../../oc-path.js";

describe("setJsonlOcPath — value replacement", () => {
  const log = '{"event":"start"}\n{"event":"step","n":1}\n{"event":"end"}\n';

  it("replaces a field on a specific line", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/L2/n"), {
      kind: "number",
      value: 42,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = emitJsonl(r.ast).split("\n");
      expect(JSON.parse(lines[1] ?? "")).toEqual({ event: "step", n: 42 });
    }
  });

  it("replaces an entire line value", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/L2"), {
      kind: "object",
      entries: [{ key: "event", line: 0, value: { kind: "string", value: "replaced" } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = emitJsonl(r.ast).split("\n");
      expect(JSON.parse(lines[1] ?? "")).toEqual({ event: "replaced" });
    }
  });

  it("resolves $last and edits the most recent value line", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/$last/event"), {
      kind: "string",
      value: "final",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = emitJsonl(r.ast).split("\n");
      expect(JSON.parse(lines[2] ?? "")).toEqual({ event: "final" });
    }
  });

  it("reports unresolved for unknown line addresses", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/L99/x"), {
      kind: "number",
      value: 1,
    });
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });

  it("reports not-a-value-line when targeting a blank line", () => {
    const { ast } = parseJsonl('{"a":1}\n\n{"b":2}\n');
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/L2"), {
      kind: "number",
      value: 1,
    });
    expect(r).toEqual({ ok: false, reason: "not-a-value-line" });
  });
});

describe("appendJsonlOcPath — session checkpointing primitive", () => {
  it("appends to an empty file", () => {
    const { ast } = parseJsonl("");
    const next = appendJsonlOcPath(ast, {
      kind: "object",
      entries: [{ key: "event", line: 0, value: { kind: "string", value: "start" } }],
    });
    expect(emitJsonl(next)).toBe('{"event":"start"}');
  });

  it("appends to an existing log preserving prior lines", () => {
    const { ast } = parseJsonl('{"a":1}\n');
    const next = appendJsonlOcPath(ast, {
      kind: "object",
      entries: [{ key: "b", line: 0, value: { kind: "number", value: 2 } }],
    });
    const out = emitJsonl(next).split("\n");
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[1] ?? "")).toEqual({ b: 2 });
  });

  it("preserves CRLF line endings when appending", () => {
    const { ast } = parseJsonl('{"a":1}\r\n');
    const next = appendJsonlOcPath(ast, {
      kind: "object",
      entries: [{ key: "b", line: 0, value: { kind: "number", value: 2 } }],
    });
    expect(emitJsonl(next)).toBe('{"a":1}\r\n{"b":2}');
  });
});

describe("setJsonlOcPath — $last line address", () => {
  const log = '{"event":"start","n":1}\n{"event":"step","n":2}\n{"event":"end","n":3}\n';

  it("writes under $last line address", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/$last/n"), {
      kind: "number",
      value: 99,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = emitJsonl(r.ast).split("\n");
      expect(JSON.parse(lines[2] ?? "")).toEqual({ event: "end", n: 99 });
    }
  });

  it("reports unresolved for $last against an empty log", () => {
    const { ast } = parseJsonl("");
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/$last/n"), {
      kind: "number",
      value: 99,
    });
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });
});

describe("setJsonlOcPath — $last positional field tokens", () => {
  const log = '{"items":[10,20,30],"events":{"a":1,"b":2}}\n';

  it("edits the last array item on a line via $last", () => {
    const { ast } = parseJsonl(log);
    const r = setJsonlOcPath(ast, parseOcPath("oc://session-events/L1/items/$last"), {
      kind: "number",
      value: 99,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const firstLine =
        emitJsonl(r.ast)
          .split("\n")
          .find((l) => l.length > 0) ?? "";
      expect(JSON.parse(firstLine)).toEqual({
        items: [10, 20, 99],
        events: { a: 1, b: 2 },
      });
    }
  });
});

describe("setJsonlOcPath — quoted field segments", () => {
  it("edits a field key containing a slash via quoted segment", () => {
    const raw = `{"event":"start","detail":{"github/repo":"old"}}\n`;
    const { ast } = parseJsonl(raw);
    const r = setJsonlOcPath(ast, parseOcPath('oc://x.jsonl/L1/detail/"github/repo"'), {
      kind: "string",
      value: "new",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = emitJsonl(r.ast)
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        event: "start",
        detail: { "github/repo": "new" },
      });
    }
  });
});
