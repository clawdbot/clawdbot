// OC Path tests cover edit plugin behavior.
import { describe, expect, it } from "vitest";
import { setMdOcPath as setOcPath } from "../edit.js";
import { parseOcPath } from "../oc-path.js";
import { parseMd } from "../parse.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";

describe("setOcPath — frontmatter", () => {
  it("replaces frontmatter while retaining unrelated pre-existing sentinel text", () => {
    const raw = `---
name: github
description: old desc
---
Body ${REDACTED_SENTINEL}.`;
    const { ast } = parseMd(raw);
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/description"), "new desc");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toBe(
        `---\nname: github\ndescription: new desc\n---\n\nBody ${REDACTED_SENTINEL}.`,
      );
    }
  });

  it("reports unresolved when the key is missing", () => {
    const { ast } = parseMd("---\nname: x\n---\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/nope"), "x");
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });

  it("quotes frontmatter values containing structural chars", () => {
    const { ast } = parseMd("---\nx: a\n---\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/x"), "has: colon");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain('x: "has: colon"');
    }
  });
});

describe("setOcPath — item kv field", () => {
  it.each(["$$", "$&", "$1", "$`", "$'", "$HOME"])(
    "preserves literal dollar replacement text %s",
    (token) => {
      const raw = "## Tools\n\n- command: old\n- keep: stable\n";
      const { ast } = parseMd(raw);
      const before = structuredClone(ast);
      const value = `literal ${token}`;
      const result = setOcPath(ast, parseOcPath("oc://X.md/tools/command/command"), value);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ast.raw).toBe(`## Tools\n\n- command: ${value}\n- keep: stable\n`);
      }
      expect(ast).toEqual(before);
    },
  );

  it("replaces an item kv value and reflects it in the rebuilt body", () => {
    const raw = `## Boundaries

- enabled: true
- timeout: 5
`;
    const { ast } = parseMd(raw);
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/boundaries/timeout/timeout"), "30");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toBe("## Boundaries\n\n- enabled: true\n- timeout: 30\n");
    }
  });

  it("reports no-item-kv for an item without kv shape", () => {
    const raw = `## Boundaries

- plain bullet
`;
    const { ast } = parseMd(raw);
    const r = setOcPath(
      ast,
      parseOcPath("oc://AGENTS.md/boundaries/plain-bullet/plain-bullet"),
      "x",
    );
    expect(r).toEqual({ ok: false, reason: "no-item-kv" });
  });

  it("reports unresolved when section/item is missing", () => {
    const { ast } = parseMd("## Other\n\n- foo: bar\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/missing/foo/foo"), "x");
    expect(r).toEqual({ ok: false, reason: "unresolved" });
  });

  it("reports not-writable for section-only addresses", () => {
    const { ast } = parseMd("## Boundaries\n\n- enabled: true\n");
    const r = setOcPath(ast, parseOcPath("oc://AGENTS.md/boundaries"), "x");
    expect(r).toEqual({ ok: false, reason: "not-writable" });
  });
});

describe("setOcPath — sentinel guard (defense-in-depth)", () => {
  // The JSONC + JSONL paths reject sentinel-bearing values at the
  // substrate boundary; the md path was deferring entirely to round-trip
  // echo through emitMd, which acceptPreExistingSentinel:true skips.
  // Closing the gap keeps F9 (formatter sentinel guard) symmetric across
  // all three kinds.
  it("rejects bare sentinel on frontmatter value", () => {
    const { ast } = parseMd("---\nname: x\n---\n");
    expect(() =>
      setOcPath(ast, parseOcPath("oc://AGENTS.md/[frontmatter]/name"), REDACTED_SENTINEL),
    ).toThrow(OcEmitSentinelError);
  });

  it("rejects substring-embedded sentinel on item kv", () => {
    const { ast } = parseMd("## Boundaries\n\n- enabled: true\n");
    expect(() =>
      setOcPath(
        ast,
        parseOcPath("oc://AGENTS.md/boundaries/enabled/enabled"),
        `prefix${REDACTED_SENTINEL}suffix`,
      ),
    ).toThrow(OcEmitSentinelError);
  });
});
