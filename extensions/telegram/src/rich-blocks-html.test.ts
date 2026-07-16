// HTML-island → typed block mapping tests: this is the agent authoring contract
// the core system prompt advertises for rich-enabled Telegram accounts.
import { describe, expect, it } from "vitest";
import { countInputRichBlockChars, type InputRichBlock } from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";

function blocksFor(markdown: string): InputRichBlock[] {
  return markdownToTelegramRichBlocks(markdown).blocks;
}

function single(markdown: string): InputRichBlock {
  const blocks = blocksFor(markdown);
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  if (!block) {
    throw new Error("expected one block");
  }
  return block;
}

describe("block HTML islands", () => {
  it("maps <details> with summary, body, and open attribute", () => {
    const block = single(
      "<details open><summary>Long <b>output</b></summary><p>hidden body</p></details>",
    );
    expect(block).toMatchObject({ type: "details", is_open: true });
    if (block.type !== "details") {
      return;
    }
    expect(JSON.stringify(block.summary)).toContain("output");
    expect(block.blocks).toEqual([{ type: "paragraph", text: "hidden body" }]);
  });

  it("maps <ul> with checkbox tasks", () => {
    const block = single(
      '<ul><li><input type="checkbox" checked/>Done</li><li><input type="checkbox"/>Todo</li><li>Plain</li></ul>',
    );
    expect(block.type).toBe("list");
    if (block.type !== "list") {
      return;
    }
    expect(block.items).toHaveLength(3);
    expect(block.items[0]).toMatchObject({ has_checkbox: true, is_checked: true });
    expect(block.items[1]).toMatchObject({ has_checkbox: true });
    expect(block.items[1]?.is_checked).toBeUndefined();
    expect(block.items[2]?.has_checkbox).toBeUndefined();
  });

  it("maps <ol> items with sequential values", () => {
    const block = single("<ol><li>alpha</li><li>beta</li></ol>");
    if (block.type !== "list") {
      expect(block.type).toBe("list");
      return;
    }
    expect(block.items.map((item) => item.value)).toEqual([1, 2]);
  });

  it("maps figure/img with figcaption and cite credit", () => {
    const block = single(
      '<figure><img src="https://example.com/a.jpg"/><figcaption>Cap<cite>Src</cite></figcaption></figure>',
    );
    expect(block).toEqual({
      type: "photo",
      photo: { type: "photo", media: "https://example.com/a.jpg" },
      caption: { text: "Cap", credit: "Src" },
    });
  });

  it("maps bare img, video, and audio islands", () => {
    const blocks = blocksFor(
      [
        '<img src="https://example.com/a.png"/>',
        "",
        '<video src="https://example.com/a.mp4"></video>',
        "",
        '<audio src="https://example.com/a.mp3"></audio>',
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual(["photo", "video", "audio"]);
  });

  it("rejects non-http media sources", () => {
    const blocks = blocksFor('<img src="file:///etc/passwd"/>');
    expect(blocks.some((block) => block.type === "photo")).toBe(false);
  });

  it("maps tg-math-block, tg-map, hr, aside, and anchor islands", () => {
    const blocks = blocksFor(
      [
        "<tg-math-block>\\int_0^1 x^2 dx</tg-math-block>",
        "",
        '<tg-map lat="48.8584" long="2.2945" zoom="15"/>',
        "",
        "<hr/>",
        "",
        "<aside>Pull quote<cite>Source</cite></aside>",
        "",
        '<a name="top"></a>',
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "mathematical_expression",
      "map",
      "divider",
      "pullquote",
      "anchor",
    ]);
    const map = blocks.find((block) => block.type === "map");
    if (map?.type === "map") {
      expect(map.location).toEqual({ latitude: 48.8584, longitude: 2.2945 });
      expect(map.zoom).toBe(15);
    }
  });

  it("maps tg-collage children to media blocks", () => {
    const block = single(
      '<tg-collage><img src="https://example.com/1.png"/><img src="https://example.com/2.png"/></tg-collage>',
    );
    expect(block.type).toBe("collage");
    if (block.type === "collage") {
      expect(block.blocks.map((child) => child.type)).toEqual(["photo", "photo"]);
    }
  });

  it("maps raw HTML tables with caption, header, and spans", () => {
    const block = single(
      '<table><caption>Stats</caption><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td colspan="2" align="center">wide</td></tr></tbody></table>',
    );
    expect(block.type).toBe("table");
    if (block.type !== "table") {
      return;
    }
    expect(block.caption).toBe("Stats");
    expect(block.cells[0]?.every((cell) => cell.is_header === true)).toBe(true);
    expect(block.cells[1]?.[0]).toMatchObject({ colspan: 2, align: "center" });
  });

  it("keeps surrounding markdown on the paragraph path", () => {
    const blocks = blocksFor("**before**\n\n<hr/>\n\nafter");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "divider", "paragraph"]);
  });

  it("leaves unsupported or unclosed HTML as literal text", () => {
    const blocks = blocksFor("<details><summary>oops</summary> and <custom>tag</custom>");
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    const plain = JSON.stringify(blocks);
    expect(plain).toContain("oops");
  });

  it("keeps unclosed inline tags literal instead of restyling trailing text", () => {
    const blocks = blocksFor("value is <sup>oops and more text");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("<sup>oops");
    expect(serialized).not.toContain('"superscript"');
  });

  it("keeps unsupported matched tags literal", () => {
    const blocks = blocksFor("a <custom>tag</custom> here");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("<custom>");
    expect(serialized).toContain("</custom>");
  });

  it("keeps the entire subtree of unsupported wrappers literal", () => {
    const blocks = blocksFor("a <custom><sup>x</sup></custom> here");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("<sup>x</sup>");
    expect(serialized).not.toContain('"superscript"');
  });

  it("counts rowspan carryover toward the table column limit", () => {
    const secondRow = Array.from({ length: 20 }, (_, i) => `<td>c${i}</td>`).join("");
    const block = single(`<table><tr><td rowspan="2">left</td></tr><tr>${secondRow}</tr></table>`);
    expect(block.type).toBe("pre");
  });

  it("keeps mid-sentence href links inside their paragraph", () => {
    const blocks = blocksFor('jump <a href="#top">back</a> now');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("paragraph");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain('"anchor_name":"top"');
    expect(serialized).toContain("jump ");
    expect(serialized).toContain(" now");
  });

  it("does not turn island examples inside code spans into blocks", () => {
    const blocks = blocksFor('use `<hr/>` or `<img src="https://example.com/a.png"/>` in HTML');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("paragraph");
  });

  it("rejects http (non-https) media sources", () => {
    const blocks = blocksFor('<img src="http://example.com/a.png"/>');
    expect(blocks.some((block) => block.type === "photo")).toBe(false);
  });

  it("counts and projects table captions and splits them onto the first piece only", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      "<table><caption>Stats</caption><tr><td>a</td></tr><tr><td>b</td></tr></table>",
    );
    expect(plainText).toContain("Stats");
    const table = blocks[0];
    if (table?.type !== "table") {
      expect(table?.type).toBe("table");
      return;
    }
    expect(countInputRichBlockChars(table)).toBe("Stats".length + 2);
    const pieces = splitTelegramRichBlocks([table], { textLimit: 6 }).flat();
    expect(pieces.length).toBeGreaterThan(1);
    const captioned = pieces.filter((piece) => piece.type === "table" && piece.caption);
    expect(captioned).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ caption: "Stats" });
  });

  it("maps blockquote cite to the credit field", () => {
    const block = single("<blockquote>Quote text<cite>Author</cite></blockquote>");
    expect(block).toMatchObject({ type: "blockquote", credit: "Author" });
  });

  it("attaches figcaption captions to collages and figure-wrapped maps", () => {
    const blocks = blocksFor(
      [
        '<tg-collage><img src="https://example.com/1.png"/><figcaption>Album<cite>me</cite></figcaption></tg-collage>',
        "",
        '<figure><tg-map lat="1" long="2" zoom="10"/><figcaption>Here</figcaption></figure>',
      ].join("\n"),
    );
    expect(blocks[0]).toMatchObject({
      type: "collage",
      caption: { text: "Album", credit: "me" },
    });
    expect(blocks[1]).toMatchObject({ type: "map", caption: { text: "Here" } });
  });

  it("degrades over-wide HTML tables to a monospace grid", () => {
    const wideRow = Array.from({ length: 21 }, (_, i) => `<td>c${i}</td>`).join("");
    const block = single(`<table><tr>${wideRow}</tr></table>`);
    expect(block.type).toBe("pre");
  });

  it("emits anchor_link nodes for fragment hrefs", () => {
    const blocks = blocksFor('go <a href="#top">back</a> and [also](#top)');
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain('"anchor_link"');
    expect(serialized).toContain('"anchor_name":"top"');
    expect(serialized).not.toContain('"url":"#top"');
  });

  it("keeps islands whose body contains markdown code spans", () => {
    const blocks = blocksFor("<details><summary>cmd</summary><p>run `ls -la` now</p></details>");
    expect(blocks[0]?.type).toBe("details");
  });

  it("degrades non-numeric custom emoji ids to alternative text", () => {
    const blocks = blocksFor('<tg-emoji emoji-id="not-numeric">😀</tg-emoji> hi');
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain('"custom_emoji"');
    expect(serialized).toContain("😀");
  });

  it("splits oversized credited blockquotes with the credit on the last piece", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      `<blockquote>${"q".repeat(50)} ${"r".repeat(50)}<cite>Author</cite></blockquote>`,
    );
    const pieces = splitTelegramRichBlocks(blocks, { textLimit: 64 });
    const quotes = pieces.flat().filter((piece) => piece.type === "blockquote");
    expect(quotes.length).toBeGreaterThan(1);
    expect(quotes.filter((quote) => quote.credit !== undefined)).toHaveLength(1);
    expect(quotes.at(-1)?.credit).toBe("Author");
    for (const chunk of pieces) {
      const chars = chunk.reduce((total, piece) => total + countInputRichBlockChars(piece), 0);
      expect(chars).toBeLessThanOrEqual(64);
    }
  });

  it("matches islands whose bodies quote tag names inside code elements", () => {
    const block = single(
      "<details><summary>How</summary>Maps <code><details></code> and <code><table></code> to blocks.</details>",
    );
    expect(block.type).toBe("details");
    if (block.type !== "details") {
      return;
    }
    expect(JSON.stringify(block.blocks)).toContain("<details>");
  });

  it("suppresses islands nested under an unmatched supported opener", () => {
    const blocks = blocksFor("<details><summary>x</summary><hr/>");
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    expect(JSON.stringify(blocks)).toContain("<details>");
  });

  it("maps gif sources to animation blocks", () => {
    const blocks = blocksFor(
      '<img src="https://example.com/a.gif"/>\n\n<video src="https://example.com/b.gif"></video>',
    );
    expect(blocks.map((block) => block.type)).toEqual(["animation", "animation"]);
  });

  it("keeps media URLs in the plain fallback alongside captions", () => {
    const { plainText } = markdownToTelegramRichBlocks(
      '<figure><img src="https://example.com/a.jpg"/><figcaption>Cap</figcaption></figure>',
    );
    expect(plainText).toContain("Cap");
    expect(plainText).toContain("https://example.com/a.jpg");
  });

  it("keeps rowspan tables atomic when splitting", () => {
    const block = single(
      `<table><tr><td rowspan="2">${"a".repeat(40)}</td><td>${"b".repeat(40)}</td></tr><tr><td>${"c".repeat(40)}</td></tr></table>`,
    );
    const pieces = splitTelegramRichBlocks([block], { textLimit: 64 });
    expect(pieces.flat().filter((piece) => piece.type === "table")).toHaveLength(1);
  });

  it("maps ogg and opus audio to voice-note blocks", () => {
    const blocks = blocksFor(
      '<audio src="https://example.com/a.opus"></audio>\n\n<audio src="https://example.com/b.ogg"></audio>',
    );
    expect(blocks.map((block) => block.type)).toEqual(["voice_note", "voice_note"]);
  });

  it("rejects media elements with nested element bodies", () => {
    const blocks = blocksFor(
      '<video src="https://example.com/a.mp4"><img src="https://example.com/b.jpg"/></video>',
    );
    expect(blocks.some((block) => block.type === "video")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("b.jpg");
  });

  it("rejects malformed map coordinates instead of accepting numeric prefixes", () => {
    const blocks = blocksFor('<tg-map lat="48.8north" long="2.3east" zoom="10"/>');
    expect(blocks.some((block) => block.type === "map")).toBe(false);
  });

  it("rejects duplicate captions in figures and tables", () => {
    const blocks = blocksFor(
      [
        '<figure><img src="https://example.com/a.jpg"/><figcaption>one</figcaption><figcaption>two</figcaption></figure>',
        "",
        "<table><caption>x</caption><caption>y</caption><tr><td>a</td></tr></table>",
      ].join("\n"),
    );
    expect(blocks.some((block) => block.type === "photo" || block.type === "table")).toBe(false);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("two");
    expect(serialized).toContain("y");
  });

  it("rejects media elements with authored body content", () => {
    const blocks = blocksFor('<video src="https://example.com/a.mp4">fallback warning</video>');
    expect(blocks.some((block) => block.type === "video")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("fallback warning");
  });

  it("rejects multi-media figures instead of dropping extra media", () => {
    const blocks = blocksFor(
      '<figure><img src="https://example.com/a.jpg"/><img src="https://example.com/b.jpg"/></figure>',
    );
    expect(blocks.some((block) => block.type === "photo")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("b.jpg");
  });

  it("rejects tables with stray content inside rows or sections", () => {
    const blocks = blocksFor("<table><tr>warning<td>x</td></tr></table>");
    expect(blocks.some((block) => block.type === "table")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("warning");
  });

  it("stays literal when containers hold stray content", () => {
    const blocks = blocksFor(
      '<tg-collage>warning<img src="https://example.com/a.png"/></tg-collage>\n\n<ul>stray<li>item</li></ul>',
    );
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("warning");
    expect(serialized).toContain("stray");
  });

  it("rejects the whole collage when any child fails conversion", () => {
    const blocks = blocksFor(
      '<tg-collage><img src="https://example.com/ok.png"/><img src="http://example.com/bad.png"/></tg-collage>',
    );
    expect(blocks.some((block) => block.type === "collage")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("bad.png");
  });

  it("keeps supported tags nested in unsupported wrappers literal", () => {
    const blocks = blocksFor("<custom><hr/></custom>");
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("<custom>");
    expect(serialized).toContain("<hr/>");
  });

  it("rejects out-of-range map coordinates", () => {
    const blocks = blocksFor('<tg-map lat="91" long="2" zoom="10"/>');
    expect(blocks.some((block) => block.type === "map")).toBe(false);
  });

  it("does not mint blank paragraphs from multiline island indentation", () => {
    const blocks = blocksFor("<details>\n<summary>S</summary>\n<p>B</p>\n</details>");
    expect(blocks).toHaveLength(1);
    const details = blocks[0];
    if (details?.type !== "details") {
      expect(details?.type).toBe("details");
      return;
    }
    expect(details.blocks).toEqual([{ type: "paragraph", text: "B" }]);
  });

  it("projects ordered lists and pullquote credits into plain text", () => {
    const { plainText } = markdownToTelegramRichBlocks(
      "<ol><li>alpha</li><li>beta</li></ol>\n\n<aside>Quote<cite>Author</cite></aside>",
    );
    expect(plainText).toContain("1. alpha");
    expect(plainText).toContain("2. beta");
    expect(plainText).toContain("Quote — Author");
  });
});

describe("inline HTML islands", () => {
  it("maps sup/sub/mark/tg-spoiler/tg-math/tg-emoji inside paragraphs", () => {
    const blocks = blocksFor(
      'H<sub>2</sub>O E=mc<sup>2</sup> <mark>note</mark> <tg-spoiler>secret</tg-spoiler> <tg-math>E=mc^2</tg-math> <tg-emoji emoji-id="5368324170671202286">😀</tg-emoji>',
    );
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain('"subscript"');
    expect(serialized).toContain('"superscript"');
    expect(serialized).toContain('"marked"');
    expect(serialized).toContain('"spoiler"');
    expect(serialized).toContain('"mathematical_expression"');
    expect(serialized).toContain('"custom_emoji"');
    expect(serialized).toContain("5368324170671202286");
  });

  it("maps fragment anchor links inline", () => {
    const blocks = blocksFor('<a name="top"></a>\n\njump <a href="#top">back</a>');
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain('"anchor"');
    expect(serialized).toContain('"anchor_name":"top"');
  });

  it("keeps code span content literal", () => {
    const blocks = blocksFor("run `<tg-math>x</tg-math>` now");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("<tg-math>x</tg-math>");
  });
});

describe("plain projection and media caps", () => {
  it("projects islands into readable plain text", () => {
    const { plainText } = markdownToTelegramRichBlocks(
      '<details><summary>More</summary><p>Hidden</p></details>\n\n<ul><li><input type="checkbox" checked/>Done</li></ul>',
    );
    expect(plainText).toContain("More");
    expect(plainText).toContain("Hidden");
    expect(plainText).toContain("[x] Done");
    expect(plainText).not.toContain("<details>");
  });
});
