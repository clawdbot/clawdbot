import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("frontmatter-edges", () => {
  it("simple kv pairs", () => {
    const { ast } = parseMd("---\nname: x\ndescription: y\n---\n");
    expect(ast.frontmatter.map((e) => [e.key, e.value])).toEqual([
      ["name", "x"],
      ["description", "y"],
    ]);
  });

  it("unclosed frontmatter emits diagnostic, treats as preamble", () => {
    const { ast, diagnostics } = parseMd("---\nname: x\nno close fence\nbody\n");
    expect(diagnostics.some((d) => d.code === "OC_FRONTMATTER_UNCLOSED")).toBe(true);
    expect(ast.frontmatter).toEqual([]);
  });

  it("empty frontmatter (just open + close)", () => {
    const { ast } = parseMd("---\n---\n");
    expect(ast.frontmatter).toEqual([]);
  });

  it("frontmatter only, file has no other content", () => {
    const { ast } = parseMd("---\nk: v\n---\n");
    expect(ast.frontmatter).toEqual([{ key: "k", value: "v", line: 2 }]);
    expect(ast.preamble).toBe("");
    expect(ast.blocks).toEqual([]);
  });

  it("double-quoted value", () => {
    const { ast } = parseMd('---\ntitle: "Hello, world"\n---\n');
    expect(ast.frontmatter[0]?.value).toBe("Hello, world");
  });

  it("single-quoted value", () => {
    const { ast } = parseMd("---\ntitle: 'Hello, world'\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("Hello, world");
  });

  it("unquoted value with internal colons preserved", () => {
    const { ast } = parseMd("---\nurl: https://example.com:443/p\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("https://example.com:443/p");
  });

  it("empty value", () => {
    const { ast } = parseMd("---\nk:\n---\n");
    expect(ast.frontmatter[0]).toEqual({ key: "k", value: "", line: 2 });
  });

  it("value with leading/trailing whitespace trimmed", () => {
    const { ast } = parseMd("---\nk:    spaced    \n---\n");
    expect(ast.frontmatter[0]?.value).toBe("spaced");
  });

  it("list-style continuations are silently dropped (substrate stays opinion-free)", () => {
    const { ast } = parseMd("---\ntools:\n  - gh\n  - curl\n---\n");
    // The `tools:` key has an empty inline value; the list continuation
    // lines `  - gh` and `  - curl` don't match the kv regex and are
    // skipped. Lint rules can do their own structural reading of
    // frontmatter; the substrate does not.
    expect(ast.frontmatter.map((e) => e.key)).toEqual(["tools"]);
    expect(ast.frontmatter[0]?.value).toBe("");
  });

  it("line numbers are 1-based and accurate", () => {
    const { ast } = parseMd("---\nk1: v1\nk2: v2\nk3: v3\n---\n");
    expect(ast.frontmatter.map((e) => [e.key, e.line])).toEqual([
      ["k1", 2],
      ["k2", 3],
      ["k3", 4],
    ]);
  });

  it("dash-key allowed", () => {
    const { ast } = parseMd("---\nuser-invocable: true\n---\n");
    expect(ast.frontmatter[0]?.key).toBe("user-invocable");
  });

  it("underscore-key allowed", () => {
    const { ast } = parseMd("---\nparam_set: foo\n---\n");
    expect(ast.frontmatter[0]?.key).toBe("param_set");
  });

  it("number-only value preserved as string", () => {
    const { ast } = parseMd("---\ntimeout: 15000\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("15000");
  });

  it("boolean-like value preserved as string", () => {
    const { ast } = parseMd("---\nenabled: true\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("true");
  });

  it("blank lines inside frontmatter are skipped", () => {
    const { ast } = parseMd("---\n\nk1: v1\n\nk2: v2\n\n---\n");
    expect(ast.frontmatter.map((e) => e.key)).toEqual(["k1", "k2"]);
  });

  it("frontmatter with same key twice — both retained (no dedup)", () => {
    const { ast } = parseMd("---\nk: v1\nk: v2\n---\n");
    expect(ast.frontmatter).toEqual([
      { key: "k", value: "v1", line: 2 },
      { key: "k", value: "v2", line: 3 },
    ]);
  });

  it("frontmatter must be at start — leading blank line breaks detection", () => {
    const { ast } = parseMd("\n---\nk: v\n---\n");
    expect(ast.frontmatter).toEqual([]);
  });

  it("frontmatter must be at start — leading text breaks detection", () => {
    const { ast } = parseMd("intro\n\n---\nk: v\n---\n");
    expect(ast.frontmatter).toEqual([]);
  });

  it("BOM before frontmatter open is tolerated", () => {
    const { ast } = parseMd("﻿---\nname: bom\n---\n");
    expect(ast.frontmatter[0]?.value).toBe("bom");
  });

  it("single-line file with `---` and `---` is empty frontmatter", () => {
    const { ast } = parseMd("---\n---");
    expect(ast.frontmatter).toEqual([]);
  });

  it("hash-prefixed lines skipped (don't match kv regex)", () => {
    const { ast } = parseMd("---\n# comment\nk: v\n---\n");
    expect(ast.frontmatter.map((e) => e.key)).toEqual(["k"]);
  });
});
