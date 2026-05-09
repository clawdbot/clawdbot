import { describe, expect, it } from "vitest";
import { emitMd } from "../emit.js";
import { emitJsonc } from "../jsonc/emit.js";
import { parseJsonc } from "../jsonc/parse.js";
import { emitJsonl } from "../jsonl/emit.js";
import { parseJsonl } from "../jsonl/parse.js";
import { parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { detectInsertion, resolveOcPath, setOcPath } from "../universal.js";


describe("detectInsertion", () => {
  it("returns null for plain paths", () => {
    expect(detectInsertion(parseOcPath("oc://X.md/section/item/field"))).toBeNull();
  });

  it("detects bare `+` end-insertion at section", () => {
    const info = detectInsertion(parseOcPath("oc://X.md/tools/+"));
    expect(info?.marker).toBe("+");
    expect(info?.parentPath.section).toBe("tools");
    expect(info?.parentPath.item).toBeUndefined();
  });

  it("detects `+key` keyed insertion", () => {
    const info = detectInsertion(parseOcPath("oc://config/plugins/+gitlab"));
    expect(info?.marker).toEqual({ kind: "keyed", key: "gitlab" });
  });

  it("detects `+nnn` indexed insertion", () => {
    const info = detectInsertion(parseOcPath("oc://config/items/+2"));
    expect(info?.marker).toEqual({ kind: "indexed", index: 2 });
  });

  it("detects file-root insertion", () => {
    const info = detectInsertion(parseOcPath("oc://session.jsonl/+"));
    expect(info?.marker).toBe("+");
    expect(info?.parentPath.section).toBeUndefined();
  });
});


describe("resolveOcPath — md AST", () => {
  const md = parseMd("---\nname: github\n---\n\n## Boundaries\n\n- enabled: true\n").ast;

  it("returns leaf with valueText for frontmatter entry", () => {
    const m = resolveOcPath(md, parseOcPath("oc://X.md/[frontmatter]/name"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "github", leafType: "string" });
  });

  it("returns leaf for item-field", () => {
    const m = resolveOcPath(md, parseOcPath("oc://X.md/boundaries/enabled/enabled"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "true", leafType: "string" });
  });

  it("returns node for block", () => {
    const m = resolveOcPath(md, parseOcPath("oc://X.md/boundaries"));
    expect(m).toMatchObject({ kind: "node", descriptor: "md-block" });
  });

  it("returns root for file-only path", () => {
    const m = resolveOcPath(md, parseOcPath("oc://X.md"));
    expect(m?.kind).toBe("root");
  });

  it("returns null for unresolved", () => {
    expect(resolveOcPath(md, parseOcPath("oc://X.md/missing"))).toBeNull();
  });
});

describe("resolveOcPath — jsonc AST", () => {
  const ast = parseJsonc('{ "k": 42, "s": "x", "b": true, "n": null, "arr": [1,2,3] }').ast;

  it("returns leaf:number for numeric value", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://config/k"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "42", leafType: "number" });
  });

  it("returns leaf:string for string value", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://config/s"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "x", leafType: "string" });
  });

  it("returns leaf:boolean for bool value", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://config/b"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "true", leafType: "boolean" });
  });

  it("returns leaf:null for null value", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://config/n"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "null", leafType: "null" });
  });

  it("returns node:jsonc-array for array value", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://config/arr"));
    expect(m).toMatchObject({ kind: "node", descriptor: "jsonc-array" });
  });

  it("returns leaf at array index", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://config/arr.1"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "2", leafType: "number" });
  });
});

describe("resolveOcPath — jsonl AST", () => {
  const ast = parseJsonl('{"event":"start","n":1}\n{"event":"step","n":2}\n').ast;

  it("returns node:jsonl-line for line address", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://log/L1"));
    expect(m).toMatchObject({ kind: "node", descriptor: "jsonl-line" });
  });

  it("returns leaf for field on line", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://log/L2/event"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "step", leafType: "string" });
  });

  it("returns leaf:number for $last/n", () => {
    const m = resolveOcPath(ast, parseOcPath("oc://log/$last/n"));
    expect(m).toMatchObject({ kind: "leaf", valueText: "2", leafType: "number" });
  });
});

describe("resolveOcPath — insertion-point detection", () => {
  it("returns insertion-point for md section append", () => {
    const md = parseMd("## Tools\n").ast;
    const m = resolveOcPath(md, parseOcPath("oc://X.md/tools/+"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "md-section" });
  });

  it("returns insertion-point for md file-level", () => {
    const md = parseMd("## Tools\n").ast;
    const m = resolveOcPath(md, parseOcPath("oc://X.md/+"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "md-file" });
  });

  it("returns insertion-point for md frontmatter +key", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const m = resolveOcPath(md, parseOcPath("oc://X.md/[frontmatter]/+description"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "md-frontmatter" });
  });

  it("returns insertion-point for jsonc array +", () => {
    const ast = parseJsonc('{ "items": [1,2,3] }').ast;
    const m = resolveOcPath(ast, parseOcPath("oc://config/items/+"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "jsonc-array" });
  });

  it("returns insertion-point for jsonc object +key", () => {
    const ast = parseJsonc('{ "plugins": {} }').ast;
    const m = resolveOcPath(ast, parseOcPath("oc://config/plugins/+gitlab"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "jsonc-object" });
  });

  it("returns insertion-point for jsonl file-root +", () => {
    const ast = parseJsonl("").ast;
    const m = resolveOcPath(ast, parseOcPath("oc://log/+"));
    expect(m).toMatchObject({ kind: "insertion-point", container: "jsonl-file" });
  });

  it("returns null when insertion target is not a container", () => {
    const ast = parseJsonc('{ "k": 42 }').ast;
    const m = resolveOcPath(ast, parseOcPath("oc://config/k/+"));
    expect(m).toBeNull();
  });
});


describe("setOcPath — md leaf", () => {
  it("replaces frontmatter value", () => {
    const md = parseMd("---\nname: old\n---\n").ast;
    const r = setOcPath(md, parseOcPath("oc://X.md/[frontmatter]/name"), "new");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.kind === "md" && r.ast.frontmatter[0]?.value).toBe("new");
    }
  });

  it("replaces item kv value", () => {
    const md = parseMd("## Boundaries\n\n- timeout: 5\n").ast;
    const r = setOcPath(md, parseOcPath("oc://X.md/boundaries/timeout/timeout"), "60");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = emitMd(r.ast as Parameters<typeof emitMd>[0]);
      expect(out).toContain("- timeout: 60");
    }
  });

  it("returns unresolved for missing path", () => {
    const md = parseMd("").ast;
    const r = setOcPath(md, parseOcPath("oc://X.md/missing/x/x"), "v");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });
});

describe("setOcPath — jsonc leaf with coercion", () => {
  it("replaces string leaf with string value", () => {
    const ast = parseJsonc('{ "k": "old" }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/k"), "new");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast2 = r.ast as Parameters<typeof emitJsonc>[0];
      expect(JSON.parse(emitJsonc(ast2))).toEqual({ k: "new" });
    }
  });

  it("coerces value to number when leaf was number", () => {
    const ast = parseJsonc('{ "k": 1 }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/k"), "42");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast2 = r.ast as Parameters<typeof emitJsonc>[0];
      expect(JSON.parse(emitJsonc(ast2))).toEqual({ k: 42 });
    }
  });

  it('coerces "true"/"false" when leaf was boolean', () => {
    const ast = parseJsonc('{ "k": true }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/k"), "false");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast2 = r.ast as Parameters<typeof emitJsonc>[0];
      expect(JSON.parse(emitJsonc(ast2))).toEqual({ k: false });
    }
  });

  it("rejects non-numeric string for number leaf", () => {
    const ast = parseJsonc('{ "k": 1 }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/k"), "not-a-number");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });

  it("rejects non-bool string for boolean leaf", () => {
    const ast = parseJsonc('{ "k": true }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/k"), "maybe");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });
});

describe("setOcPath — jsonl leaf", () => {
  it("replaces field on a value line with coercion", () => {
    const ast = parseJsonl('{"event":"start","n":1}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/L1/n"), "42");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = emitJsonl(r.ast as Parameters<typeof emitJsonl>[0]);
      expect(JSON.parse(out.split("\n")[0])).toEqual({ event: "start", n: 42 });
    }
  });

  it("replaces whole line via JSON value", () => {
    const ast = parseJsonl('{"event":"start"}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/L1"), '{"event":"replaced"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = emitJsonl(r.ast as Parameters<typeof emitJsonl>[0]);
      expect(JSON.parse(out.split("\n")[0])).toEqual({ event: "replaced" });
    }
  });

  it("rejects malformed JSON for whole-line replacement", () => {
    const ast = parseJsonl('{"event":"start"}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/L1"), "not json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });
});


describe("setOcPath — md insertion", () => {
  it("appends item to section with `+`", () => {
    const md = parseMd("## Tools\n\n- gh: GitHub CLI\n").ast;
    const r = setOcPath(md, parseOcPath("oc://X.md/tools/+"), "docker: container CLI");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = emitMd(r.ast as Parameters<typeof emitMd>[0]);
      expect(out).toContain("- gh: GitHub CLI");
      expect(out).toContain("- docker: container CLI");
    }
  });

  it("appends new section at file root with `+`", () => {
    const md = parseMd("## Existing\n").ast;
    const r = setOcPath(md, parseOcPath("oc://X.md/+"), "New Section");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = emitMd(r.ast as Parameters<typeof emitMd>[0]);
      expect(out).toContain("## Existing");
      expect(out).toContain("## New Section");
    }
  });

  it("adds new frontmatter key with +key", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const r = setOcPath(
      md,
      parseOcPath("oc://X.md/[frontmatter]/+description"),
      "a new description",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = emitMd(r.ast as Parameters<typeof emitMd>[0]);
      expect(out).toContain("description: a new description");
    }
  });

  it("rejects duplicate frontmatter key on insertion", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const r = setOcPath(md, parseOcPath("oc://X.md/[frontmatter]/+name"), "y");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("type-mismatch");
    }
  });
});

describe("setOcPath — jsonc insertion", () => {
  it("appends to array with `+`", () => {
    const ast = parseJsonc('{ "items": [1, 2] }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/items/+"), "3");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast2 = r.ast as Parameters<typeof emitJsonc>[0];
      expect(JSON.parse(emitJsonc(ast2))).toEqual({ items: [1, 2, 3] });
    }
  });

  it("inserts at index with `+nnn`", () => {
    const ast = parseJsonc('{ "items": [1, 3] }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/items/+1"), "2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast2 = r.ast as Parameters<typeof emitJsonc>[0];
      expect(JSON.parse(emitJsonc(ast2))).toEqual({ items: [1, 2, 3] });
    }
  });

  it("adds object key with `+key`", () => {
    const ast = parseJsonc('{ "plugins": { "github": "tok" } }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/plugins/+gitlab"), '"new-tok"');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast2 = r.ast as Parameters<typeof emitJsonc>[0];
      expect(JSON.parse(emitJsonc(ast2))).toEqual({
        plugins: { github: "tok", gitlab: "new-tok" },
      });
    }
  });

  it("rejects duplicate object key", () => {
    const ast = parseJsonc('{ "plugins": { "github": "x" } }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/plugins/+github"), '"y"');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });

  it("rejects +key on array", () => {
    const ast = parseJsonc('{ "items": [1, 2] }').ast;
    const r = setOcPath(ast, parseOcPath("oc://config/items/+abc"), "3");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("type-mismatch");
    }
  });

  it("inserts complex object via JSON value", () => {
    const ast = parseJsonc('{ "plugins": {} }').ast;
    const r = setOcPath(
      ast,
      parseOcPath("oc://config/plugins/+gitlab"),
      '{"token":"xyz","enabled":true}',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ast2 = r.ast as Parameters<typeof emitJsonc>[0];
      expect(JSON.parse(emitJsonc(ast2))).toEqual({
        plugins: { gitlab: { token: "xyz", enabled: true } },
      });
    }
  });
});

describe("setOcPath — jsonl insertion (session append)", () => {
  it("appends a JSON line with `+`", () => {
    const ast = parseJsonl('{"event":"start"}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/+"), '{"event":"step","n":1}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = emitJsonl(r.ast as Parameters<typeof emitJsonl>[0]);
      const lines = out.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1])).toEqual({ event: "step", n: 1 });
    }
  });

  it("rejects malformed JSON value", () => {
    const ast = parseJsonl("").ast;
    const r = setOcPath(ast, parseOcPath("oc://log/+"), "not json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("parse-error");
    }
  });

  it("rejects non-root insertion target", () => {
    const ast = parseJsonl('{"a":1}\n').ast;
    const r = setOcPath(ast, parseOcPath("oc://log/L1/+"), "{}");
    expect(r.ok).toBe(false);
  });
});


describe("setOcPath — cross-cutting properties", () => {
  it("is non-mutating across all kinds", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const before = JSON.stringify(md);
    setOcPath(md, parseOcPath("oc://X.md/[frontmatter]/name"), "new");
    expect(JSON.stringify(md)).toBe(before);

    const jsonc = parseJsonc('{ "k": 1 }').ast;
    const before2 = JSON.stringify(jsonc);
    setOcPath(jsonc, parseOcPath("oc://config/k"), "99");
    expect(JSON.stringify(jsonc)).toBe(before2);

    const jsonl = parseJsonl('{"a":1}\n').ast;
    const before3 = JSON.stringify(jsonl);
    setOcPath(jsonl, parseOcPath("oc://log/L1/a"), "99");
    expect(JSON.stringify(jsonl)).toBe(before3);
  });

  it("returns ok-tagged result with new ast on success", () => {
    const md = parseMd("---\nname: x\n---\n").ast;
    const r = setOcPath(md, parseOcPath("oc://X.md/[frontmatter]/name"), "y");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.kind).toBe("md");
    }
  });

  it("returns failure-tagged result with reason on unresolved", () => {
    const ast = parseJsonc("{}").ast;
    const r = setOcPath(ast, parseOcPath("oc://config/missing"), "v");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unresolved");
    }
  });
});
