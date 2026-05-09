import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";

describe("h2-block-split", () => {
  it("no headings → no blocks, all preamble", () => {
    const raw = "Just prose, no headings.\nMore prose.\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks).toEqual([]);
    expect(ast.preamble).toBe("Just prose, no headings.\nMore prose.\n");
  });

  it("single heading splits preamble + one block", () => {
    const { ast } = parseMd("preamble\n## Section\nbody\n");
    expect(ast.preamble.trim()).toBe("preamble");
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe("Section");
    expect(ast.blocks[0]?.bodyText.trim()).toBe("body");
  });

  it("multiple headings produce blocks in order", () => {
    const { ast } = parseMd("## A\nbody-a\n## B\nbody-b\n## C\nbody-c\n");
    expect(ast.blocks.map((b) => b.heading)).toEqual(["A", "B", "C"]);
  });

  it("H1 does NOT split", () => {
    const { ast } = parseMd("# H1 heading\n## H2 heading\n");
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe("H2 heading");
    expect(ast.preamble).toContain("# H1 heading");
  });

  it("H3 does NOT split", () => {
    const { ast } = parseMd("## H2\nbody\n### H3\nstill in H2 block\n");
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.bodyText).toContain("### H3");
  });

  it("`## ` inside fenced code block does NOT split", () => {
    const raw = "## Real\n\n```md\n## Inside code\n```\n\n## Another real\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(["Real", "Another real"]);
  });

  it("`##` without trailing space — does NOT match (regex requires \\s+)", () => {
    const { ast } = parseMd("##NoSpace\n## With space\n");
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe("With space");
  });

  it("leading whitespace before `##` — recognized as heading (CommonMark)", () => {
    const { ast } = parseMd("   ## indented\n## not indented\n");
    expect(ast.blocks.map((b) => b.heading)).toEqual(["indented", "not indented"]);
  });

  it("trailing whitespace on heading — trimmed in heading text", () => {
    const { ast } = parseMd("## Trailing   \n");
    expect(ast.blocks[0]?.heading).toBe("Trailing");
    expect(ast.blocks[0]?.slug).toBe("trailing");
  });

  it("inline code in heading preserved", () => {
    const { ast } = parseMd("## Use `gh` for GitHub\n");
    expect(ast.blocks[0]?.heading).toBe("Use `gh` for GitHub");
  });

  it("markdown formatting in heading preserved", () => {
    const { ast } = parseMd("## **Bold** *italic*\n");
    expect(ast.blocks[0]?.heading).toBe("**Bold** *italic*");
  });

  it("immediately after frontmatter", () => {
    const { ast } = parseMd("---\nk: v\n---\n## Section\nbody\n");
    expect(ast.blocks[0]?.heading).toBe("Section");
    expect(ast.preamble).toBe("");
  });

  it("H2 at end of file (no body)", () => {
    const { ast } = parseMd("preamble\n## End\n");
    expect(ast.blocks[0]?.heading).toBe("End");
    expect(ast.blocks[0]?.bodyText).toBe("");
  });

  it("two consecutive H2s — empty body block between", () => {
    const { ast } = parseMd("## A\n## B\n");
    expect(ast.blocks[0]?.bodyText).toBe("");
    expect(ast.blocks[1]?.heading).toBe("B");
  });

  it("line numbers are 1-based and track through frontmatter", () => {
    const { ast } = parseMd("---\nk: v\n---\n## At line 4\n");
    expect(ast.blocks[0]?.line).toBe(4);
  });

  it("line numbers track through preamble", () => {
    const { ast } = parseMd("line 1\nline 2\n## At line 3\n");
    expect(ast.blocks[0]?.line).toBe(3);
  });

  it("nested fenced code blocks (~~~ vs ```) — only ``` is detected", () => {
    const raw = "## H\n\n~~~md\n~~~\n\n## Next\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(["H", "Next"]);
  });

  it("setext-style heading (`Heading\\n========\\n`) is NOT recognized", () => {
    const raw = "Heading\n=======\n## Real\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe("Real");
  });

  it("empty heading text (`## `)", () => {
    const { ast } = parseMd("## \n");
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe("");
    expect(ast.blocks[0]?.slug).toBe("");
  });

  it("heading with only whitespace (`##    `)", () => {
    const { ast } = parseMd("##    \n");
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe("");
  });

  it("heading-shaped text inside multi-line bullet body — does split", () => {
    const raw = "## Section\n- item starts\n  continues\n## Next\n";
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(["Section", "Next"]);
  });
});
