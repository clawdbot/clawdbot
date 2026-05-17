import { describe, expect, it } from "vitest";
import { findOcPaths } from "../find.js";
import { parseJsonc } from "../jsonc/parse.js";
import { parseJsonl } from "../jsonl/parse.js";
import { formatOcPath, hasWildcard, OcPathError, parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { resolveOcPath, setOcPath } from "../universal.js";

describe("hasWildcard", () => {
  it("detects single-segment * in any slot", () => {
    expect(hasWildcard(parseOcPath("oc://X/*/y"))).toBe(true);
    expect(hasWildcard(parseOcPath("oc://X/a/*"))).toBe(true);
    expect(hasWildcard(parseOcPath("oc://X/a/b/*"))).toBe(true);
  });

  it("detects ** in any slot", () => {
    expect(hasWildcard(parseOcPath("oc://X/**"))).toBe(true);
    expect(hasWildcard(parseOcPath("oc://X/a/**/c"))).toBe(true);
  });

  it("detects wildcards inside dotted sub-segments", () => {
    expect(hasWildcard(parseOcPath("oc://X/a.*.c"))).toBe(true);
    expect(hasWildcard(parseOcPath("oc://X/a.**.c"))).toBe(true);
  });

  it("returns false for plain paths", () => {
    expect(hasWildcard(parseOcPath("oc://X/a/b/c"))).toBe(false);
    expect(hasWildcard(parseOcPath("oc://X/a.b.c"))).toBe(false);
  });

  it("treats `*` inside an identifier as literal", () => {
    expect(hasWildcard(parseOcPath("oc://X/foo*bar"))).toBe(false);
    expect(hasWildcard(parseOcPath("oc://X/a*"))).toBe(false);
  });
});

describe("wildcard guard", () => {
  const ast = parseJsonc('{"steps":[{"id":"a","command":"foo"}]}').ast;

  it("resolveOcPath throws OcPathError for wildcard pattern", () => {
    expect(() => resolveOcPath(ast, parseOcPath("oc://wf/steps/*/command"))).toThrow(/findOcPaths/);
    try {
      resolveOcPath(ast, parseOcPath("oc://wf/**"));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OcPathError);
      expect((err as OcPathError).code).toBe("OC_PATH_WILDCARD_IN_RESOLVE");
    }
  });

  it("setOcPath returns wildcard-not-allowed for wildcard pattern", () => {
    const r = setOcPath(ast, parseOcPath("oc://wf/steps/*/command"), "bar");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("wildcard-not-allowed");
    }
  });

  it("setOcPath wildcard guard reason carries actionable detail", () => {
    const r = setOcPath(ast, parseOcPath("oc://wf/**"), "bar");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain("findOcPaths");
    }
  });
});

describe("findOcPaths — non-wildcard fast-path", () => {
  it("wraps resolveOcPath result for plain path", () => {
    const ast = parseJsonc('{"name":"x"}').ast;
    const out = findOcPaths(ast, parseOcPath("oc://wf/name"));
    expect(out).toHaveLength(1);
    expect(out[0].match.kind).toBe("leaf");
    expect(formatOcPath(out[0].path)).toBe("oc://wf/name");
  });

  it("returns empty for unresolved plain path", () => {
    const ast = parseJsonc('{"name":"x"}').ast;
    expect(findOcPaths(ast, parseOcPath("oc://wf/missing"))).toHaveLength(0);
  });
});

describe("findOcPaths — JSONC kind", () => {
  const jsonc = parseJsonc(
    "{\n" +
      '  "plugins": {\n' +
      '    "github": {"enabled": true},\n' +
      '    "gitlab": {"enabled": false},\n' +
      '    "slack": {"enabled": true}\n' +
      "  }\n" +
      "}\n",
  ).ast;

  it("* in item slot enumerates each plugin", () => {
    const out = findOcPaths(jsonc, parseOcPath("oc://config/plugins/*/enabled"));
    expect(out).toHaveLength(3);
    const keys = out.map((m) => m.path.item);
    expect(keys.toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual([
      "github",
      "gitlab",
      "slack",
    ]);
  });

  it("returns boolean leaves with leafType", () => {
    const out = findOcPaths(jsonc, parseOcPath("oc://config/plugins/*/enabled"));
    for (const m of out) {
      expect(m.match.kind).toBe("leaf");
      if (m.match.kind === "leaf") {
        expect(m.match.leafType).toBe("boolean");
      }
    }
  });
});

describe("findOcPaths — JSONL kind", () => {
  const jsonl = parseJsonl(
    '{"event":"start","userId":"u1"}\n' +
      '{"event":"action","userId":"u1"}\n' +
      '{"event":"end","userId":"u1"}\n',
  ).ast;

  it("* in section slot enumerates each value line", () => {
    const out = findOcPaths(jsonl, parseOcPath("oc://session/*/event"));
    expect(out).toHaveLength(3);
    const events = out.map((m) => (m.match.kind === "leaf" ? m.match.valueText : ""));
    expect(events).toEqual(["start", "action", "end"]);
  });

  it("preserves Lnnn line addresses in concrete paths", () => {
    const out = findOcPaths(jsonl, parseOcPath("oc://session/*/event"));
    for (const m of out) {
      expect(m.path.section).toMatch(/^L\d+$/);
    }
  });

  it("union {L1,L2} at line slot enumerates each alternative", () => {
    const out = findOcPaths(jsonl, parseOcPath("oc://session/{L1,L3}/event"));
    expect(out).toHaveLength(2);
    const events = out.map((m) => (m.match.kind === "leaf" ? m.match.valueText : ""));
    expect(events).toEqual(["start", "end"]);
  });

  it("union of positional + literal line addresses works", () => {
    const out = findOcPaths(jsonl, parseOcPath("oc://session/{L1,$last}/event"));
    expect(out).toHaveLength(2);
    const events = out.map((m) => (m.match.kind === "leaf" ? m.match.valueText : ""));
    expect(events).toEqual(["start", "end"]);
  });

  it("predicate [event=action] at line slot filters by top-level field", () => {
    const out = findOcPaths(jsonl, parseOcPath("oc://session/[event=action]/userId"));
    expect(out).toHaveLength(1);
    if (out[0]?.match.kind === "leaf") {
      expect(out[0].match.valueText).toBe("u1");
    }
  });

  it("predicate [event=missing] at line slot matches zero lines (silent zero is correct)", () => {
    const out = findOcPaths(jsonl, parseOcPath("oc://session/[event=missing]/userId"));
    expect(out).toHaveLength(0);
  });
});

describe("positional primitives — $first / $last", () => {
  it("$first picks first array element", () => {
    const jsonc = parseJsonc('{"items":[10,20,30]}').ast;
    const m = resolveOcPath(jsonc, parseOcPath("oc://config/items/$first"));
    expect(m?.kind === "leaf" && m.valueText).toBe("10");
  });

  it("$last picks last array element", () => {
    const jsonc = parseJsonc('{"items":[10,20,30]}').ast;
    const m = resolveOcPath(jsonc, parseOcPath("oc://config/items/$last"));
    expect(m?.kind === "leaf" && m.valueText).toBe("30");
  });

  it("$first picks first value line on jsonl", () => {
    const jsonl = parseJsonl('{"event":"start"}\n{"event":"step"}\n{"event":"end"}\n').ast;
    const m = resolveOcPath(jsonl, parseOcPath("oc://session/$first/event"));
    expect(m?.kind === "leaf" && m.valueText).toBe("start");
  });

  it("$last picks last value line on jsonl", () => {
    const jsonl = parseJsonl('{"event":"start"}\n{"event":"step"}\n{"event":"end"}\n').ast;
    const m = resolveOcPath(jsonl, parseOcPath("oc://session/$last/event"));
    expect(m?.kind === "leaf" && m.valueText).toBe("end");
  });

  it("hasWildcard returns false for positional tokens", () => {
    expect(hasWildcard(parseOcPath("oc://X/$first/id"))).toBe(false);
    expect(hasWildcard(parseOcPath("oc://X/$last/id"))).toBe(false);
  });
});

describe("quoted segments (v1.0)", () => {
  const jsonc = parseJsonc(
    '{"agents":{"defaults":{"models":{' +
      '"anthropic/claude-opus-4-7":{"alias":"opus47","contextWindow":1000000},' +
      '"github-copilot/claude-opus-4.7-1m-internal":{"alias":"copilot-opus-1m","contextWindow":1000000},' +
      '"plain":{"alias":"p","contextWindow":200000}' +
      "}}}}",
  ).ast;

  it("resolveOcPath — quoted segment with literal slash", () => {
    const m = resolveOcPath(
      jsonc,
      parseOcPath('oc://config/agents.defaults.models/"anthropic/claude-opus-4-7"/alias'),
    );
    expect(m?.kind).toBe("leaf");
    if (m?.kind === "leaf") {
      expect(m.valueText).toBe("opus47");
    }
  });

  it("resolveOcPath — quoted segment with literal slash AND dot", () => {
    const m = resolveOcPath(
      jsonc,
      parseOcPath(
        'oc://config/agents.defaults.models/"github-copilot/claude-opus-4.7-1m-internal"/alias',
      ),
    );
    expect(m?.kind).toBe("leaf");
    if (m?.kind === "leaf") {
      expect(m.valueText).toBe("copilot-opus-1m");
    }
  });

  it("quoted segment with whitespace", () => {
    const ast = parseJsonc('{"prompts":{"hello world":"value"}}').ast;
    const m = resolveOcPath(ast, parseOcPath('oc://X/prompts/"hello world"'));
    expect(m?.kind).toBe("leaf");
    if (m?.kind === "leaf") {
      expect(m.valueText).toBe("value");
    }
  });

  it('rejects quoted segments containing `"` or `\\` (no escape support)', () => {
    expect(() => parseOcPath('oc://X/keys/"a\\\\b"')).toThrow(/Quoted segment cannot contain/);
  });

  it("findOcPaths — wildcard returns paths with quoted keys when needed", () => {
    const out = findOcPaths(jsonc, parseOcPath("oc://config/agents.defaults.models/*/alias"));
    expect(out).toHaveLength(3);
    const items = out.map((m) => m.path.item);
    expect(items.some((s) => s === "plain")).toBe(true);
    expect(items.some((s) => s === '"anthropic/claude-opus-4-7"')).toBe(true);
    expect(items.some((s) => s === '"github-copilot/claude-opus-4.7-1m-internal"')).toBe(true);
  });

  it("findOcPaths — emitted paths round-trip through resolveOcPath", () => {
    const out = findOcPaths(jsonc, parseOcPath("oc://config/agents.defaults.models/*/alias"));
    for (const m of out) {
      const r = resolveOcPath(jsonc, m.path);
      expect(r?.kind).toBe("leaf");
    }
  });

  it("rejects unbalanced quotes at parse time", () => {
    expect(() => parseOcPath('oc://X/"unterminated')).toThrow(/Unbalanced/);
  });

  it("control characters still rejected inside quotes", () => {
    expect(() => parseOcPath('oc://X/"\x00"')).toThrow(/Control character/);
  });
});

describe("value predicates — numeric operators (v1.1)", () => {
  const jsonc = parseJsonc(
    '{"models":{"providers":{"anthropic":{"models":[' +
      '{"id":"claude-sonnet-4-6","contextWindow":1000000,"maxTokens":128000},' +
      '{"id":"claude-opus-4-7","contextWindow":1000000,"maxTokens":240000},' +
      '{"id":"claude-sonnet-4-7","contextWindow":200000,"maxTokens":64000}' +
      "]}}}}",
  ).ast;

  const PREFIX = "oc://config/models.providers.anthropic.models";

  it("> finds models exceeding the per-request output cap", () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[maxTokens>128000]/id`));
    expect(out).toHaveLength(1);
    if (out[0].match.kind === "leaf") {
      expect(out[0].match.valueText).toBe("claude-opus-4-7");
    }
  });

  it(">= matches the boundary", () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[maxTokens>=128000]/id`));
    const ids = out.map((m) => (m.match.kind === "leaf" ? m.match.valueText : ""));
    expect(ids.toSorted()).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });

  it("< filters small context windows", () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[contextWindow<500000]/id`));
    expect(out).toHaveLength(1);
    if (out[0].match.kind === "leaf") {
      expect(out[0].match.valueText).toBe("claude-sonnet-4-7");
    }
  });

  it("<= matches the boundary", () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[contextWindow<=200000]/id`));
    const ids = out.map((m) => (m.match.kind === "leaf" ? m.match.valueText : ""));
    expect(ids).toEqual(["claude-sonnet-4-7"]);
  });

  it("numeric operator rejects non-numeric leaves silently", () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[id>5]/id`));
    expect(out).toHaveLength(0);
  });

  it("rejects numeric predicate value that is not a number", () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[maxTokens>foo]/id`));
    expect(out).toHaveLength(0);
  });
});

describe("value predicates — jsonc", () => {
  const jsonc = parseJsonc(
    '{"plugins":{"github":{"enabled":true,"role":"vcs"},"slack":{"enabled":false,"role":"chat"},"jira":{"enabled":true,"role":"tracker"}}}',
  ).ast;

  it("[enabled=true] filters by sibling boolean", () => {
    const out = findOcPaths(jsonc, parseOcPath("oc://config/plugins/[enabled=true]/role"));
    expect(out).toHaveLength(2);
    const roles = out.map((m) => (m.match.kind === "leaf" ? m.match.valueText : ""));
    expect(roles.toSorted()).toEqual(["tracker", "vcs"]);
  });
});

describe("ordinal addressing — md", () => {
  // Two items share slug `foo` after slugify.
  const md = parseMd("## Tools\n\n- foo: a\n- foo: b\n- bar: c\n").ast;

  it("#0 picks the first item by document order", () => {
    const m = resolveOcPath(md, parseOcPath("oc://AGENTS.md/tools/#0/foo"));
    expect(m?.kind).toBe("leaf");
    if (m?.kind === "leaf") {
      expect(m.valueText).toBe("a");
    }
  });

  it("#1 picks the second item — distinct from #0 even though slug collides", () => {
    const m = resolveOcPath(md, parseOcPath("oc://AGENTS.md/tools/#1/foo"));
    expect(m?.kind).toBe("leaf");
    if (m?.kind === "leaf") {
      expect(m.valueText).toBe("b");
    }
  });

  it("out-of-range #N returns null", () => {
    expect(resolveOcPath(md, parseOcPath("oc://AGENTS.md/tools/#99/foo"))).toBeNull();
  });

  it("findOcPaths disambiguates duplicate-slug items via #N", () => {
    const out = findOcPaths(md, parseOcPath("oc://AGENTS.md/tools/*/foo"));
    expect(out).toHaveLength(2);
    const items = out.map((m) => m.path.item);
    expect(items).toEqual(["#0", "#1"]);
    const values = out.map((m) => (m.match.kind === "leaf" ? m.match.valueText : ""));
    expect(values.toSorted()).toEqual(["a", "b"]);
  });

  it("non-duplicate slug keeps slug form (back-compat)", () => {
    const md2 = parseMd("## Tools\n\n- foo: a\n- bar: b\n").ast;
    const out = findOcPaths(md2, parseOcPath("oc://AGENTS.md/tools/*"));
    const items = out.map((m) => m.path.item);
    expect(items.toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(["bar", "foo"]);
  });
});

describe("findOcPaths — Markdown kind", () => {
  const md = parseMd(
    "---\nname: drafter\nrole: writer\n---\n\n" +
      "## Tools\n\n" +
      "- send_email: enabled\n" +
      "- search: enabled\n" +
      "- read_email: disabled\n",
  ).ast;

  it("* in field slot enumerates frontmatter keys", () => {
    const out = findOcPaths(md, parseOcPath("oc://SOUL.md/[frontmatter]/*"));
    expect(out).toHaveLength(2);
    const keys = out.map((m) => m.path.item ?? m.path.field);
    expect(keys.toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(["name", "role"]);
  });

  it("* in field slot enumerates each item kv key", () => {
    const out = findOcPaths(md, parseOcPath("oc://SKILL.md/Tools/send-email/*"));
    expect(out).toHaveLength(1);
    expect(out[0].match.kind).toBe("leaf");
    if (out[0].match.kind === "leaf") {
      expect(out[0].match.valueText).toBe("enabled");
    }
  });

  it("* in item slot + matching field returns each item whose kv key matches", () => {
    const out = findOcPaths(md, parseOcPath("oc://SKILL.md/Tools/*/send_email"));
    expect(out).toHaveLength(1);
    expect(out[0].path.item).toBe("send-email");
  });

  it("** at section slot matches items at every depth (cross-kind symmetry)", () => {
    // The retain-i branch on `**` keeps the wildcard active across
    // descent — without it, multi-block md files match only the
    // immediate-block layer.
    const multiBlock = parseMd(
      "## Boundaries\n\n" +
        "- never: rm -rf\n\n" +
        "## Tools\n\n" +
        "- send_email: enabled\n" +
        "- search: enabled\n",
    ).ast;
    const out = findOcPaths(multiBlock, parseOcPath("oc://SOUL.md/**/send-email"));
    expect(out.length).toBeGreaterThanOrEqual(1);
    const items = out.map((m) => m.path.item).filter((v): v is string => v !== undefined);
    expect(items).toContain("send-email");
  });
});

describe("findOcPaths — quoted segments survive expansion", () => {
  it("finds keys with slashes when the path quotes them and a sibling wildcards", () => {
    const raw = `{
  "agents": {
    "defaults": {
      "models": {
        "github-copilot/claude-opus-4-7": {
          "alias": "opus-internal",
          "contextWindow": 200000
        }
      }
    }
  }
}
`;
    const { ast } = parseJsonc(raw);
    const out = findOcPaths(
      ast,
      parseOcPath(
        'oc://config.jsonc/agents.defaults.models/"github-copilot/claude-opus-4-7"/{alias,contextWindow}',
      ),
    );
    expect(out.length).toBe(2);
    const fields = out
      .map((m) => m.path.field)
      .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(fields).toEqual(["alias", "contextWindow"]);
  });
});

describe("union segments — md", () => {
  const RAW = `## Boundaries

- enabled: true
- timeout: 5

## Limits

- max-tokens: 4096
- alias: claude-3
`;

  it("expands {a,b} at the section slot", () => {
    const ast = parseMd(RAW).ast;
    const out = findOcPaths(ast, parseOcPath("oc://X.md/{boundaries,limits}/*/*"));
    expect(out.length).toBe(4);
    const sections = out
      .map((m) => m.path.section)
      .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(sections).toEqual(["boundaries", "boundaries", "limits", "limits"]);
  });

  it("expands {a,b} at the item slot", () => {
    const ast = parseMd(RAW).ast;
    const out = findOcPaths(ast, parseOcPath("oc://X.md/limits/{max-tokens,alias}/*"));
    expect(out.length).toBe(2);
    const items = out.map((m) => m.path.item).toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(items).toEqual(["alias", "max-tokens"]);
  });

  it("expands {a,b} at the field slot — md items have one kv, so at most one alt", () => {
    const ast = parseMd(RAW).ast;
    const out = findOcPaths(ast, parseOcPath("oc://X.md/limits/alias/{alias,nope}"));
    expect(out.length).toBe(1);
    expect(out[0]?.path.field).toBe("alias");
  });
});

describe("predicate segments — md", () => {
  const RAW = `## Boundaries

- enabled: true
- timeout: 5

## Limits

- enabled: false
- max-tokens: 4096
`;

  it("matches sections that contain an item satisfying the predicate", () => {
    const ast = parseMd(RAW).ast;
    const out = findOcPaths(ast, parseOcPath("oc://X.md/[enabled=true]/*/*"));
    expect(out.length).toBeGreaterThan(0);
    for (const m of out) {
      expect(m.path.section).toBe("boundaries");
    }
  });

  it("matches items whose kv pair satisfies the predicate", () => {
    const ast = parseMd(RAW).ast;
    const out = findOcPaths(ast, parseOcPath("oc://X.md/limits/[enabled=false]/*"));
    expect(out.length).toBe(1);
    expect(out[0]?.path.item).toBe("enabled");
  });

  it("matches the kv pair at the field slot", () => {
    const ast = parseMd(RAW).ast;
    const out = findOcPaths(ast, parseOcPath("oc://X.md/limits/max-tokens/[max-tokens=4096]"));
    expect(out.length).toBe(1);
    expect(out[0]?.path.field).toBe("max-tokens");
  });

  it("returns empty when no section's item matches", () => {
    const ast = parseMd(RAW).ast;
    const out = findOcPaths(ast, parseOcPath("oc://X.md/[enabled=maybe]/*/*"));
    expect(out).toEqual([]);
  });

  it("returns empty when no item matches the predicate", () => {
    const ast = parseMd(RAW).ast;
    const out = findOcPaths(ast, parseOcPath("oc://X.md/limits/[enabled=true]/*"));
    expect(out).toEqual([]);
  });
});
