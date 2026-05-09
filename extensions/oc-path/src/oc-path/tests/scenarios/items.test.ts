import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("items", () => {
  it("plain dash bullets", () => {
    const { ast } = parseMd("## H\n- a\n- b\n- c\n");
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(["a", "b", "c"]);
  });

  it("star bullets", () => {
    const { ast } = parseMd("## H\n* a\n* b\n");
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(["a", "b"]);
  });

  it("plus bullets", () => {
    const { ast } = parseMd("## H\n+ a\n+ b\n");
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(["a", "b"]);
  });

  it("mixed bullet markers in same section", () => {
    const { ast } = parseMd("## H\n- dash\n* star\n+ plus\n");
    expect(ast.blocks[0]?.items.length).toBe(3);
  });

  it("kv-shape items populate kv", () => {
    const { ast } = parseMd("## H\n- gh: GitHub CLI\n");
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({ key: "gh", value: "GitHub CLI" });
  });

  it("plain item has no kv", () => {
    const { ast } = parseMd("## H\n- plain text\n");
    expect(ast.blocks[0]?.items[0]?.kv).toBeUndefined();
  });

  it("multiple colons — first colon is the kv split", () => {
    const { ast } = parseMd("## H\n- url: http://x.com:80/p\n");
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({
      key: "url",
      value: "http://x.com:80/p",
    });
  });

  it("colon with no space after is still kv", () => {
    const { ast } = parseMd("## H\n- key:value\n");
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({ key: "key", value: "value" });
  });

  it("quoted value preserved verbatim (no unquote at item layer)", () => {
    const { ast } = parseMd('## H\n- title: "quoted: value"\n');
    expect(ast.blocks[0]?.items[0]?.kv?.value).toBe('"quoted: value"');
  });

  it("slug from kv key when kv present", () => {
    const { ast } = parseMd("## H\n- The Tool: description\n");
    expect(ast.blocks[0]?.items[0]?.slug).toBe("the-tool");
  });

  it("slug from item text when no kv", () => {
    const { ast } = parseMd("## H\n- The Plain Item\n");
    expect(ast.blocks[0]?.items[0]?.slug).toBe("the-plain-item");
  });

  it("items inside fenced code block are NOT extracted", () => {
    const raw = "## H\n```\n- not a bullet\n- still not\n```\n- real bullet\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.items.length).toBe(1);
    expect(ast.blocks[0]?.items[0]?.text).toBe("real bullet");
  });

  it("line numbers track through block body", () => {
    const { ast } = parseMd("## H\n- first\n- second\n- third\n");
    expect(ast.blocks[0]?.items.map((i) => i.line)).toEqual([2, 3, 4]);
  });

  it("trailing whitespace on bullet trimmed in text", () => {
    const { ast } = parseMd("## H\n- spaced   \n");
    expect(ast.blocks[0]?.items[0]?.text).toBe("spaced");
  });

  it("empty bullet — recognized with empty text/slug", () => {
    const { ast } = parseMd("## H\n- \n- real\n");
    expect(ast.blocks[0]?.items.length).toBe(2);
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(["", "real"]);
  });

  it("indented bullet (sub-bullet) — recognized as item alongside parent", () => {
    const { ast } = parseMd("## H\n- top\n  - sub\n");
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(["top", "sub"]);
  });

  it("numbered list (1. item) — recognized as items", () => {
    const { ast } = parseMd("## H\n1. first\n2. second\n");
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(["first", "second"]);
  });

  it("items in a section with no body before — first item line is heading+1", () => {
    const { ast } = parseMd("## H\n- a\n");
    expect(ast.blocks[0]?.items[0]?.line).toBe(2);
  });

  it("items spread across blocks are scoped to their block", () => {
    const { ast } = parseMd("## A\n- a1\n## B\n- b1\n- b2\n");
    expect(ast.blocks[0]?.items.length).toBe(1);
    expect(ast.blocks[1]?.items.length).toBe(2);
    expect(ast.blocks[1]?.items.map((i) => i.text)).toEqual(["b1", "b2"]);
  });

  it("item with only-symbol kv key still parses", () => {
    const { ast } = parseMd("## H\n- API_KEY: secret-value\n");
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({
      key: "API_KEY",
      value: "secret-value",
    });
    expect(ast.blocks[0]?.items[0]?.slug).toBe("api-key");
  });

  it("item with empty kv value falls through to plain item", () => {
    const { ast } = parseMd("## H\n- key:\n");
    expect(ast.blocks[0]?.items[0]?.kv).toBeUndefined();
    expect(ast.blocks[0]?.items[0]?.text).toBe("key:");
  });

  it("bullet in preamble (before first H2) is NOT in any block", () => {
    const { ast } = parseMd("- preamble bullet\n## H\n- block bullet\n");
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(["block bullet"]);
    expect(ast.preamble).toContain("- preamble bullet");
  });

  it("bullet with internal markdown (italics, code) preserved in text", () => {
    const { ast } = parseMd("## H\n- use *gh* and `curl`\n");
    expect(ast.blocks[0]?.items[0]?.text).toBe("use *gh* and `curl`");
  });
});
