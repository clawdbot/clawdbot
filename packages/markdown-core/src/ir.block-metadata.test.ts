import { describe, expect, it } from "vitest";
import {
  markdownToIR as parseMarkdownToIR,
  sliceMarkdownIR as sliceParsedMarkdownIR,
  type MarkdownIR,
} from "./ir.js";

type BlockMetadata = {
  kind: "blockquote" | "code_block" | "heading" | "thematic_break";
  start: number;
  end: number;
  depth: number;
  blockquoteDepth?: number;
  codeOrigin?: "fenced" | "indented";
  codeClosed?: boolean;
  headingLevel?: number;
  headingOrigin?: "atx" | "setext";
  language?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
};

type MarkdownIRWithMetadata = Omit<MarkdownIR, "listItems"> & {
  blocks?: BlockMetadata[];
  listItems?: Array<
    NonNullable<MarkdownIR["listItems"]>[number] & {
      contentStart?: number;
      contentEnd?: number;
      markerOnly?: true;
      sourceMarker?: { start: number; end: number };
      sourceContent?: { start: number; end: number };
      sourceIndent?: number;
      sourceStartLine?: number;
      sourceEndLine?: number;
    }
  >;
};

function markdownToIR(...args: Parameters<typeof parseMarkdownToIR>): MarkdownIRWithMetadata {
  return parseMarkdownToIR(...args) as MarkdownIRWithMetadata;
}

function sliceMarkdownIR(
  ...args: Parameters<typeof sliceParsedMarkdownIR>
): MarkdownIRWithMetadata {
  return sliceParsedMarkdownIR(...args) as MarkdownIRWithMetadata;
}

describe("markdownToIR block metadata", () => {
  it("records fenced and indented code origins without changing rendered text", () => {
    const ir = markdownToIR("```ts\nfenced\n```\n\n    indented");
    const blocks = ir.blocks?.filter((block) => block.kind === "code_block") ?? [];

    expect(blocks.map((block) => block.codeOrigin)).toEqual(["fenced", "indented"]);
    expect(blocks[0]).toMatchObject({
      codeClosed: true,
      depth: 1,
      language: "ts",
      sourceStartLine: 0,
      sourceEndLine: 3,
    });
    expect(ir.text.slice(blocks[0]?.start, blocks[0]?.end)).toBe("fenced\n");
    expect(ir.text.slice(blocks[1]?.start, blocks[1]?.end)).toBe("indented\n");
  });

  it("records whether a fenced block owns an explicit closing fence", () => {
    const ir = markdownToIR("```ts\nunclosed");
    const empty = markdownToIR("```ts");
    const overIndented = markdownToIR("```\n    ```");
    const tabIndented = markdownToIR("```\n\t```");
    const unmatchedQuote = markdownToIR("```\n> ```");
    const listed = markdownToIR("- ```\n  code\n  ```");
    const quoted = markdownToIR("> ```\n> code\n> ```");
    const listThenQuote = markdownToIR("10. >   ```\n    >   code\n    >   ```");
    const alternating = markdownToIR("> - > 10. ```\n>   >     code\n>   >     ```");
    const independentFenceIndent = markdownToIR("- item\n   ```\n   code\n  ```");
    const tabQuoted = markdownToIR(">\t```\n>\tcode\n>\t```");
    const paddedList = markdownToIR("   - ```\n     code");

    expect(ir.blocks?.[0]).toMatchObject({ codeOrigin: "fenced", codeClosed: false });
    expect(empty.blocks?.[0]).toMatchObject({
      start: 0,
      end: 1,
      codeOrigin: "fenced",
      codeClosed: false,
    });
    expect(overIndented.blocks?.[0]).toMatchObject({ codeOrigin: "fenced", codeClosed: false });
    expect(tabIndented.blocks?.[0]).toMatchObject({ codeOrigin: "fenced", codeClosed: false });
    expect(unmatchedQuote.blocks?.[0]).toMatchObject({
      codeOrigin: "fenced",
      codeClosed: false,
    });
    expect(listed.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      depth: 2,
    });
    expect(quoted.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      depth: 2,
    });
    expect(listThenQuote.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      depth: 3,
    });
    expect(alternating.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      depth: 5,
    });
    expect(
      independentFenceIndent.blocks?.find((block) => block.kind === "code_block"),
    ).toMatchObject({ codeClosed: true });
    expect(tabQuoted.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      blockquoteDepth: 1,
    });
    expect(paddedList.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: false,
    });
  });

  it("retains nested blockquote depths in deterministic source order", () => {
    const ir = markdownToIR("> outer\n> > inner");
    const blocks = ir.blocks?.filter((block) => block.kind === "blockquote") ?? [];

    expect(blocks.map((block) => block.depth)).toEqual([1, 2]);
    expect(ir.text.slice(blocks[1]?.start, blocks[1]?.end)).toContain("inner");
  });

  it("records heading source ownership and container depth", () => {
    const ir = markdownToIR("> ## nested", { headingStyle: "rich" });
    const empty = markdownToIR("#####", { headingStyle: "rich" });

    expect(ir.blocks?.find((block) => block.kind === "heading")).toMatchObject({
      depth: 2,
      headingLevel: 2,
      headingOrigin: "atx",
      sourceStartLine: 0,
      sourceEndLine: 1,
    });
    expect(empty.blocks?.[0]).toMatchObject({
      kind: "heading",
      start: 0,
      end: 0,
      headingLevel: 5,
    });
  });

  it("records setext headings and thematic breaks without changing rendered bytes", () => {
    const ir = markdownToIR("setext\n---\n\n***", { horizontalRuleText: "" });

    expect(ir.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "heading", headingOrigin: "setext", headingLevel: 2 }),
        expect.objectContaining({
          kind: "thematic_break",
          start: ir.text.length,
          end: ir.text.length,
        }),
      ]),
    );
  });

  it("records marker-only list ownership and its later content span", () => {
    const source = "-\n  child";
    const ir = markdownToIR(source);
    const item = ir.listItems?.[0];

    expect(item).toMatchObject({ kind: "bullet", depth: 0, markerOnly: true });
    expect(ir.text.slice(item?.listMarker?.start, item?.listMarker?.end)).toBe("• ");
    expect(ir.text.slice(item?.contentStart, item?.contentEnd)).toBe("child");
    expect(source.slice(item?.sourceMarker?.start, item?.sourceMarker?.end)).toBe("-");
    expect(source.slice(item?.sourceContent?.start, item?.sourceContent?.end)).toBe("\n  child");
  });

  it("does not mark block content on the marker line as marker-only", () => {
    const fenced = markdownToIR("- ```\n  code\n  ```").listItems?.[0];
    const quoted = markdownToIR("- > quote").listItems?.[0];

    expect(fenced?.markerOnly).toBeUndefined();
    expect(quoted?.markerOnly).toBeUndefined();
    const thematic = markdownToIR("- ***", { horizontalRuleText: "" }).listItems?.[0];
    expect(thematic?.markerOnly).toBeUndefined();
  });

  it("retains zero-length blockquote ownership", () => {
    const ir = markdownToIR("> ***", { horizontalRuleText: "" });

    expect(ir.blocks?.find((block) => block.kind === "blockquote")).toMatchObject({
      start: 0,
      end: 0,
      blockquoteDepth: 1,
    });
    const surrounded = markdownToIR("before\n\n>\n\nafter");
    const quote = surrounded.blocks?.find((block) => block.kind === "blockquote");
    expect(quote?.end).toBeGreaterThanOrEqual(quote?.start ?? 0);
    const zeroHeading = markdownToIR("#####", { headingStyle: "rich" });
    expect(sliceMarkdownIR(zeroHeading, 0, zeroHeading.text.length).blocks?.[0]).toMatchObject({
      kind: "heading",
      start: 0,
      end: 0,
    });
    const withText = markdownToIR("text\n#####", { headingStyle: "rich" });
    expect(sliceMarkdownIR(withText, 0, withText.text.length).blocks).toBeUndefined();
  });

  it("retains CommonMark content indentation after wide marker padding", () => {
    const source = "-     code";
    const item = markdownToIR(source).listItems?.[0];

    expect(source.slice(item?.sourceContent?.start, item?.sourceContent?.end)).toBe("    code");
    expect(item?.sourceIndent).toBe(2);
    expect(markdownToIR("-\t  code").listItems?.[0]?.sourceIndent).toBe(2);
  });

  it("selects source markers relative to list items opened on each line", () => {
    const literalMarkerSource = "- parent\n  - a - b";
    const sameLineSource = "- parent\n  - - child";
    const literalMarkerItems = markdownToIR(literalMarkerSource).listItems ?? [];
    const sameLineItems = markdownToIR(sameLineSource).listItems ?? [];

    expect(
      literalMarkerItems.map((item) =>
        literalMarkerSource.slice(item.sourceMarker?.start, item.sourceMarker?.end),
      ),
    ).toEqual(["-", "-"]);
    expect(literalMarkerItems.map((item) => item.sourceMarker?.start)).toEqual([11, 0]);
    expect(
      sameLineItems
        .toSorted((left, right) => (left.depth ?? 0) - (right.depth ?? 0))
        .map((item) => item.sourceMarker?.start),
    ).toEqual([0, 11, 13]);
  });

  it("indexes lone carriage returns like the CommonMark parser", () => {
    const source = "- one\r- two";
    const items = markdownToIR(source).listItems ?? [];

    expect(items.map((item) => item.sourceMarker?.start)).toEqual([0, 6]);
    expect(
      items.map((item) => source.slice(item.sourceMarker?.start, item.sourceMarker?.end)),
    ).toEqual(["-", "-"]);
  });

  it("locates marker ownership for multiple list containers on one source line", () => {
    const source = "- - child";
    const ir = markdownToIR(source);
    const items = [...(ir.listItems ?? [])].toSorted(
      (left, right) => (left.depth ?? 0) - (right.depth ?? 0),
    );

    expect(
      items.map((item) => source.slice(item.sourceMarker?.start, item.sourceMarker?.end)),
    ).toEqual(["-", "-"]);
    expect(items.map((item) => item.sourceMarker?.start)).toEqual([0, 2]);
    expect(items[0]?.markerOnly).toBeUndefined();
  });

  it("keeps additive metadata out of the legacy enumerable IR shape", () => {
    const ir = markdownToIR("- item\n\n```ts\ncode\n```");
    const item = ir.listItems?.[0];

    expect(ir.blocks).toHaveLength(1);
    expect(Object.keys(ir)).not.toContain("blocks");
    expect(item?.contentStart).toBeDefined();
    expect(Object.keys(item ?? {})).not.toContain("contentStart");
    const serialized = JSON.stringify(ir);
    expect(JSON.parse(serialized)).toEqual({
      text: "• item\n\ncode\n",
      styles: [{ start: 8, end: 13, style: "code_block", language: "ts" }],
      links: [],
      listItems: [
        {
          kind: "bullet",
          listMarker: { start: 0, end: 2 },
          listId: 0,
          depth: 0,
          start: 0,
          end: 6,
        },
      ],
    });
  });
});
