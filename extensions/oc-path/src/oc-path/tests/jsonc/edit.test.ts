import { describe, expect, it } from "vitest";
import { setJsoncOcPath } from "../../jsonc/edit.js";
import { emitJsonc } from "../../jsonc/emit.js";
import { parseJsonc } from "../../jsonc/parse.js";
import { parseOcPath } from "../../oc-path.js";

describe("setJsoncOcPath — value replacement", () => {
  const config = `{
  "plugins": {
    "entries": {
      "github": {
        "token": "old"
      }
    }
  }
}`;

  it("replaces a leaf string value", () => {
    const { ast } = parseJsonc(config);
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/plugins.entries.github.token"), {
      kind: "string",
      value: "new",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = emitJsonc(r.ast);
      expect(JSON.parse(out)).toEqual({
        plugins: { entries: { github: { token: "new" } } },
      });
    }
  });

  it("replaces nested objects", () => {
    const { ast } = parseJsonc(config);
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/plugins.entries"), {
      kind: "object",
      entries: [{ key: "gitlab", line: 0, value: { kind: "string", value: "tok" } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(emitJsonc(r.ast))).toEqual({
        plugins: { entries: { gitlab: "tok" } },
      });
    }
  });

  it("replaces an array element by index", () => {
    const { ast } = parseJsonc('{ "limits": [10, 20, 30] }');
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/limits.1"), {
      kind: "number",
      value: 99,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(emitJsonc(r.ast))).toEqual({ limits: [10, 99, 30] });
    }
  });

  it("reports unresolved when a key is missing", () => {
    const { ast } = parseJsonc(config);
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/plugins.entries.gitlab"), {
      kind: "string",
      value: "x",
    });
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });

  it("reports no-root on empty AST", () => {
    const { ast } = parseJsonc("");
    const r = setJsoncOcPath(ast, parseOcPath("oc://config/x"), {
      kind: "string",
      value: "y",
    });
    expect(r).toEqual({ ok: false, reason: "no-root" });
  });

  it("does not mutate the original AST", () => {
    const { ast } = parseJsonc(config);
    const before = JSON.stringify(ast);
    setJsoncOcPath(ast, parseOcPath("oc://config/plugins.entries.github.token"), {
      kind: "string",
      value: "new",
    });
    expect(JSON.stringify(ast)).toBe(before);
  });
});

describe("setJsoncOcPath — $last positional", () => {
  it("edits the last array element via $last", () => {
    const { ast } = parseJsonc('{ "items": [10, 20, 30] }');
    const r = setJsoncOcPath(ast, parseOcPath("oc://config.jsonc/items/$last"), {
      kind: "number",
      value: 99,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(emitJsonc(r.ast))).toEqual({ items: [10, 20, 99] });
    }
  });

  it("reports unresolved for $last against an empty array", () => {
    const { ast } = parseJsonc('{ "items": [] }');
    const r = setJsoncOcPath(ast, parseOcPath("oc://config.jsonc/items/$last"), {
      kind: "number",
      value: 99,
    });
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });
});

describe("setJsoncOcPath — quoted segments (regression: resolve↔edit symmetry)", () => {
  it("edits a key containing slashes via quoted segment", () => {
    // The provider/model alias key contains a `/`; without quoting
    // it would be split as two segments. `resolveJsoncOcPath` handles
    // this; `setJsoncOcPath` MUST handle it the same way or the path
    // becomes resolve-only. Closes ClawSweeper P2 on PR #78678.
    const raw = `{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-opus-4-7": { "alias": "opus" }
      }
    }
  }
}
`;
    const { ast } = parseJsonc(raw);
    const r = setJsoncOcPath(
      ast,
      parseOcPath('oc://config.jsonc/agents.defaults.models/"anthropic/claude-opus-4-7"/alias'),
      { kind: "string", value: "big-opus" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(emitJsonc(r.ast))).toEqual({
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-7": { alias: "big-opus" },
            },
          },
        },
      });
    }
  });
});
