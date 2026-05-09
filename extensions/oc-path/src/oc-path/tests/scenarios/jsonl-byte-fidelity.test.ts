import { describe, expect, it } from "vitest";
import { emitJsonl } from "../../jsonl/emit.js";
import { parseJsonl } from "../../jsonl/parse.js";

function rt(raw: string): string {
  return emitJsonl(parseJsonl(raw).ast);
}

describe("jsonl byte-fidelity", () => {
  it("empty file", () => {
    expect(rt("")).toBe("");
  });

  it("single line no trailing newline", () => {
    expect(rt('{"a":1}')).toBe('{"a":1}');
  });

  it("single line with trailing newline", () => {
    expect(rt('{"a":1}\n')).toBe('{"a":1}\n');
  });

  it("multiple lines preserved", () => {
    const raw = '{"a":1}\n{"b":2}\n{"c":3}\n';
    expect(rt(raw)).toBe(raw);
  });

  it("blank line in the middle preserved", () => {
    const raw = '{"a":1}\n\n{"b":2}\n';
    expect(rt(raw)).toBe(raw);
  });

  it("multiple blank lines preserved", () => {
    const raw = '{"a":1}\n\n\n{"b":2}\n';
    expect(rt(raw)).toBe(raw);
  });

  it("malformed line round-trips verbatim", () => {
    const raw = '{"a":1}\nthis is not json\n{"b":2}\n';
    expect(rt(raw)).toBe(raw);
  });

  it("entirely malformed file round-trips", () => {
    const raw = "header\nbody\nfooter\n";
    expect(rt(raw)).toBe(raw);
  });

  it("leading + trailing blanks preserved", () => {
    const raw = '\n\n{"a":1}\n\n';
    expect(rt(raw)).toBe(raw);
  });

  it("file ending without final newline preserved", () => {
    const raw = '{"a":1}\n{"b":2}';
    expect(rt(raw)).toBe(raw);
  });

  it("nested object lines preserved", () => {
    const raw = '{"a":{"b":{"c":1}}}\n{"x":[1,[2,[3]]]}\n';
    expect(rt(raw)).toBe(raw);
  });

  it("unicode in a value line preserved", () => {
    const raw = '{"name":"héllo 世界 🎉"}\n';
    expect(rt(raw)).toBe(raw);
  });

  it("idiosyncratic whitespace inside a line preserved", () => {
    const raw = '{   "a"  :   1   }\n';
    expect(rt(raw)).toBe(raw);
  });

  it("single blank line file preserved", () => {
    const raw = "\n";
    expect(rt(raw)).toBe(raw);
  });

  it("large log (1000 lines) preserved", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `{"i":${i}}`);
    const raw = lines.join("\n") + "\n";
    expect(rt(raw)).toBe(raw);
  });

  it("mixed value + malformed + blank preserved", () => {
    const raw = '{"a":1}\n{not json}\n\n{"b":2}\nstill not json\n{"c":3}\n';
    expect(rt(raw)).toBe(raw);
  });

  // F10 — CRLF preservation. Without lineEnding tracking on the AST,
  // a CRLF input edited via setJsonlOcPath rebuilds raw via render
  // which joins with `\n`, mixing endings on Windows-authored datasets.
  it("CRLF input round-trips byte-identical via the default emit", () => {
    const raw = '{"a":1}\r\n{"b":2}\r\n{"c":3}\r\n';
    expect(rt(raw)).toBe(raw);
  });

  it("CRLF input preserves CRLF after a structural edit (render mode)", () => {
    const raw = '{"a":1}\r\n{"b":2}\r\n';
    const { ast } = parseJsonl(raw);
    const rendered = emitJsonl(ast, { mode: "render" });
    expect(rendered).toBe('{"a":1}\r\n{"b":2}');
    expect((rendered.match(/\r\n/g) ?? []).length).toBe(1);
    expect((rendered.match(/(?<!\r)\n/g) ?? []).length).toBe(0);
  });

  it("LF input preserves LF after a structural edit (render mode)", () => {
    // Symmetric: a Unix-authored log doesn't mysteriously gain CRLF.
    const raw = '{"a":1}\n{"b":2}\n';
    const { ast } = parseJsonl(raw);
    const rendered = emitJsonl(ast, { mode: "render" });
    expect(rendered).toBe('{"a":1}\n{"b":2}');
  });
});
