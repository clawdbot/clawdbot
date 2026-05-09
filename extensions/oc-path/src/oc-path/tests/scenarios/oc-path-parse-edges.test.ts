import { describe, expect, it } from "vitest";
import {
  OcPathError,
  formatOcPath,
  getPathLayout,
  isPattern,
  isValidOcPath,
  parseOcPath,
} from "../../oc-path.js";

function expectErr(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail(`expected OcPathError code ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(OcPathError);
    expect((err as OcPathError).code).toBe(code);
  }
}

describe("oc-path-parse-edges", () => {
  it("file-only", () => {
    expect(parseOcPath("oc://SOUL.md")).toEqual({ file: "SOUL.md" });
  });

  it("file + section", () => {
    expect(parseOcPath("oc://SOUL.md/Boundaries").section).toBe("Boundaries");
  });

  it("file + section + item", () => {
    expect(parseOcPath("oc://SOUL.md/Boundaries/deny-rule-1").item).toBe("deny-rule-1");
  });

  it("file + section + item + field", () => {
    expect(parseOcPath("oc://SOUL.md/B/deny-1/risk").field).toBe("risk");
  });

  it("session query parameter", () => {
    expect(parseOcPath("oc://X.md?session=daily").session).toBe("daily");
  });

  it("session with full path", () => {
    const p = parseOcPath("oc://X.md/sec/item/field?session=cron");
    expect(p).toEqual({
      file: "X.md",
      section: "sec",
      item: "item",
      field: "field",
      session: "cron",
    });
  });

  it("unknown query parameters silently ignored", () => {
    const p = parseOcPath("oc://X.md?foo=bar&session=s&baz=qux");
    expect(p.session).toBe("s");
  });

  it("session= with empty value drops session", () => {
    const p = parseOcPath("oc://X.md?session=");
    expect(p.session).toBeUndefined();
  });

  it("query without `=` ignored", () => {
    const p = parseOcPath("oc://X.md?nokeyhere");
    expect(p.session).toBeUndefined();
  });

  it("missing scheme throws", () => {
    expectErr(() => parseOcPath("SOUL.md"), "OC_PATH_MISSING_SCHEME");
  });

  it("wrong scheme throws", () => {
    expectErr(() => parseOcPath("https://x.com"), "OC_PATH_MISSING_SCHEME");
  });

  it("empty after scheme throws", () => {
    expectErr(() => parseOcPath("oc://"), "OC_PATH_EMPTY");
  });

  it("empty segment throws", () => {
    expectErr(() => parseOcPath("oc://X.md//item"), "OC_PATH_EMPTY_SEGMENT");
  });

  it("too-deep nesting throws", () => {
    expectErr(() => parseOcPath("oc://X.md/a/b/c/d/e"), "OC_PATH_TOO_DEEP");
  });

  it("non-string throws", () => {
    expectErr(() => parseOcPath(42 as unknown as string), "OC_PATH_NOT_STRING");
  });

  it("round-trip canonical forms", () => {
    const cases = [
      "oc://SOUL.md",
      "oc://SOUL.md/Boundaries",
      "oc://SOUL.md/Boundaries/deny-rule-1",
      "oc://SOUL.md/Boundaries/deny-rule-1/risk",
      "oc://SOUL.md?session=daily",
      "oc://X.md/a/b/c?session=s",
      "oc://skills/email-drafter/[frontmatter]/name",
      "oc://config/plugins.entries.foo.token",
    ];
    for (const c of cases) {
      expect(formatOcPath(parseOcPath(c)), `round-trip failed for ${c}`).toBe(c);
    }
  });

  it("isValidOcPath true positives", () => {
    expect(isValidOcPath("oc://X.md")).toBe(true);
    expect(isValidOcPath("oc://X.md/sec/item/field")).toBe(true);
  });

  it("isValidOcPath true negatives", () => {
    expect(isValidOcPath("")).toBe(false);
    expect(isValidOcPath("X.md")).toBe(false);
    expect(isValidOcPath("oc://")).toBe(false);
    expect(isValidOcPath("oc://x//y")).toBe(false);
    expect(isValidOcPath(null)).toBe(false);
    expect(isValidOcPath({})).toBe(false);
  });

  it("file segment with special chars (file with dots/slashes)", () => {
    const p = parseOcPath("oc://config/plugins.entries.foo.token");
    expect(p.file).toBe("config");
    expect(p.section).toBe("plugins.entries.foo.token");
  });

  it("section segment with hyphens / underscores / numbers", () => {
    const p = parseOcPath("oc://X.md/Multi-Tenant_Section_2");
    expect(p.section).toBe("Multi-Tenant_Section_2");
  });

  it("[frontmatter] sentinel is just a section name", () => {
    const p = parseOcPath("oc://X.md/[frontmatter]/name");
    expect(p.section).toBe("[frontmatter]");
    expect(p.item).toBe("name");
  });

  it("formatOcPath rejects empty file", () => {
    expectErr(() => formatOcPath({ file: "" }), "OC_PATH_FILE_REQUIRED");
  });

  it("formatOcPath rejects item without section", () => {
    expectErr(() => formatOcPath({ file: "X.md", item: "i" }), "OC_PATH_NESTING");
  });

  it("formatOcPath quotes raw slot values containing special chars", () => {
    const constructed = formatOcPath({
      file: "config.jsonc",
      section: "agents.defaults.models",
      item: "github-copilot/claude-opus-4-7",
      field: "alias",
    });
    expect(constructed).toBe(
      'oc://config.jsonc/agents.defaults.models/"github-copilot/claude-opus-4-7"/alias',
    );
    const parsed = parseOcPath(constructed);
    expect(parsed.item).toBe('"github-copilot/claude-opus-4-7"');
  });

  it("parseOcPath finds query separator outside quoted keys", () => {
    const parsed = parseOcPath('oc://config.jsonc/"foo?bar"?session=daily');
    expect(parsed.section).toBe('"foo?bar"');
    expect(parsed.session).toBe("daily");
  });

  it("file slot with `/` round-trips via quoting", () => {
    const constructed = formatOcPath({
      file: "skills/email-drafter",
      section: "Tools",
      item: "-1",
    });
    expect(constructed).toBe('oc://"skills/email-drafter"/Tools/-1');
    const parsed = parseOcPath(constructed);
    expect(parsed.file).toBe("skills/email-drafter");
    expect(parsed.section).toBe("Tools");
    expect(parsed.item).toBe("-1");
  });

  it("file slot with dot extension does NOT get quoted", () => {
    expect(formatOcPath({ file: "AGENTS.md" })).toBe("oc://AGENTS.md");
    expect(formatOcPath({ file: "gateway.jsonc", section: "version" })).toBe(
      "oc://gateway.jsonc/version",
    );
  });

  it("formatOcPath rejects field without item or section", () => {
    expect(() => formatOcPath({ file: "X", field: "name" })).toThrow(OcPathError);
    try {
      formatOcPath({ file: "X", field: "name" });
    } catch (err) {
      expect(err).toBeInstanceOf(OcPathError);
      expect((err as OcPathError).code).toBe("OC_PATH_NESTING");
    }
  });

  it("isPattern is quote-aware (literal `*` inside quoted segment)", () => {
    const concrete = parseOcPath('oc://config.jsonc/"items.*.glob"');
    expect(isPattern(concrete)).toBe(false);
    const wildcard = parseOcPath("oc://config.jsonc/items/*");
    expect(isPattern(wildcard)).toBe(true);
  });

  it("getPathLayout is quote-aware", () => {
    const path = parseOcPath('oc://config.jsonc/"github.com"/repos');
    const layout = getPathLayout(path);
    expect(layout.sectionLen).toBe(1);
    expect(layout.subs[0]).toBe('"github.com"');
    expect(layout.itemLen).toBe(1);
    expect(layout.subs[1]).toBe("repos");
  });
});
