import { describe, expect, it } from "vitest";
import { parseJsonl } from "../../jsonl/parse.js";

describe("parseJsonl", () => {
  it("parses an empty file as zero lines", () => {
    const { ast, diagnostics } = parseJsonl("");
    expect(diagnostics).toEqual([]);
    expect(ast.lines).toEqual([]);
  });

  it("parses each line as a JSON value", () => {
    const raw = `{"event":"start"}
{"event":"step","n":1}
{"event":"end"}
`;
    const { ast, diagnostics } = parseJsonl(raw);
    expect(diagnostics).toEqual([]);
    expect(ast.lines).toHaveLength(3);
    expect(ast.lines[0]?.kind).toBe("value");
    expect(ast.lines[2]?.kind).toBe("value");
  });

  it("preserves blank lines as blank entries", () => {
    const raw = '{"a":1}\n\n{"b":2}\n';
    const { ast, diagnostics } = parseJsonl(raw);
    expect(diagnostics).toEqual([]);
    expect(ast.lines.map((l) => l.kind)).toEqual(["value", "blank", "value"]);
  });

  it("flags malformed lines as warnings without aborting", () => {
    const raw = '{"a":1}\nthis is not json\n{"b":2}\n';
    const { ast, diagnostics } = parseJsonl(raw);
    expect(ast.lines.map((l) => l.kind)).toEqual(["value", "malformed", "value"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("OC_JSONL_LINE_MALFORMED");
  });

  it("preserves raw on the AST root for byte-fidelity emit", () => {
    const raw = '{"a":1}\n{"b":2}\n';
    const { ast } = parseJsonl(raw);
    expect(ast.raw).toBe(raw);
  });
});
