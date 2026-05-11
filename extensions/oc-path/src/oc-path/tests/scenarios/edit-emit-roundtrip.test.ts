import { describe, expect, it } from "vitest";
import { setMdOcPath } from "../../edit.js";
import { emitMd } from "../../emit.js";
import { setJsoncOcPath } from "../../jsonc/edit.js";
import { emitJsonc } from "../../jsonc/emit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { resolveJsoncOcPath } from "../../jsonc/resolve.js";
import { setJsonlOcPath } from "../../jsonl/edit.js";
import { emitJsonl } from "../../jsonl/emit.js";
import { parseJsonl } from "../../jsonl/parse.js";
import { parseOcPath } from "../../oc-path.js";
import { parseMd } from "../../parse.js";

describe("edit-then-emit round-trip", () => {
  it("md frontmatter edit re-parses to the new value", () => {
    const md = parseMd("---\nname: old\n---\n\n## Body\n").ast;
    const r = setMdOcPath(md, parseOcPath("oc://AGENTS.md/[frontmatter]/name"), "new");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const reparsed = parseMd(r.ast.raw).ast;
      expect(reparsed.frontmatter.find((e) => e.key === "name")?.value).toBe("new");
    }
  });

  it("md item kv edit re-parses to the new value", () => {
    const md = parseMd("## Boundaries\n\n- timeout: 5\n").ast;
    const r = setMdOcPath(md, parseOcPath("oc://AGENTS.md/boundaries/timeout/timeout"), "60");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const reparsed = parseMd(emitMd(r.ast)).ast;
      const block = reparsed.blocks.find((b) => b.slug === "boundaries");
      expect(block?.items[0]?.kv?.value).toBe("60");
    }
  });

  it("jsonc value edit re-parses to the new value", () => {
    const ast = parseJsonc('{ "k": 1 }').ast;
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/k"), {
      kind: "number",
      value: 42,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(emitJsonc(r.ast))).toEqual({ k: 42 });
    }
  });

  it("jsonc nested edit preserves untouched siblings", () => {
    const ast = parseJsonc('{ "a": 1, "b": { "c": 2, "d": 3 }, "e": 4 }').ast;
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/b.c"), {
      kind: "number",
      value: 99,
    });
    if (r.ok) {
      expect(JSON.parse(emitJsonc(r.ast))).toEqual({
        a: 1,
        b: { c: 99, d: 3 },
        e: 4,
      });
    }
  });

  it("jsonl line edit re-parses to the new value at the same line", () => {
    const ast = parseJsonl('{"a":1}\n{"a":2}\n{"a":3}\n').ast;
    const r = setJsonlOcPath(ast, parseOcPath("oc://log/L2/a"), {
      kind: "number",
      value: 99,
    });
    if (r.ok) {
      const reparsed = parseJsonl(emitJsonl(r.ast)).ast;
      const line2 = reparsed.lines[1];
      expect(line2?.kind).toBe("value");
      if (line2?.kind === "value" && line2.value.kind === "object") {
        const entry = line2.value.entries.find((e) => e.key === "a");
        expect(entry?.value.kind).toBe("number");
        if (entry?.value.kind === "number") {
          expect(entry.value.value).toBe(99);
        }
      }
    }
  });

  it("jsonc edit composes: two sequential edits both land", () => {
    let ast = parseJsonc('{ "a": 1, "b": 2 }').ast;
    let r = setJsoncOcPath(ast, parseOcPath("oc://config/a"), {
      kind: "number",
      value: 10,
    });
    if (r.ok) {
      ast = r.ast;
    }
    r = setJsoncOcPath(ast, parseOcPath("oc://config/b"), {
      kind: "number",
      value: 20,
    });
    if (r.ok) {
      ast = r.ast;
    }
    expect(JSON.parse(emitJsonc(ast))).toEqual({ a: 10, b: 20 });
  });

  it("missing path returns structured failure (not throw)", () => {
    const ast = parseJsonc('{ "a": 1 }').ast;
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/missing"), {
      kind: "number",
      value: 99,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });

  it("each per-kind verb takes its own AST type — no cross-kind leakage", () => {
    // Type-level guarantee: each setter only accepts its kind's AST.
    // Caller picks based on the AST they have. This is the design.
    const md = parseMd("---\nx: 1\n---\n").ast;
    const jsonc = parseJsonc('{"x":1}').ast;
    const jsonl = parseJsonl('{"x":1}\n').ast;

    const a = setMdOcPath(md, parseOcPath("oc://X/[frontmatter]/x"), "2");
    const b = setJsoncOcPath(jsonc, parseOcPath("oc://X/x"), {
      kind: "number",
      value: 2,
    });
    const c = setJsonlOcPath(jsonl, parseOcPath("oc://X/L1/x"), {
      kind: "number",
      value: 2,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
  });

  it("jsonc parser-backed edit preserves comments", () => {
    const raw = '{\n  "k": 1 // comment\n}\n';
    const ast = parseJsonc(raw).ast;
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/k"), {
      kind: "number",
      value: 2,
    });
    if (r.ok) {
      expect(emitJsonc(r.ast)).toContain("// comment");
      const reparsed = resolveJsoncOcPath(r.ast, parseOcPath("oc://config/k"));
      expect(reparsed?.kind).toBe("object-entry");
      if (reparsed?.kind === "object-entry") {
        expect(reparsed.node.value.kind).toBe("number");
        if (reparsed.node.value.kind === "number") {
          expect(reparsed.node.value.value).toBe(2);
        }
      }
    }
  });

  it("edit on empty AST surfaces no-root", () => {
    const ast = parseJsonc("").ast;
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/x"), {
      kind: "number",
      value: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-root");
    }
  });
});
