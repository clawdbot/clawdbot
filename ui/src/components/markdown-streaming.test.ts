import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import * as markdownDetails from "./markdown-details.ts";
import { splitStableStreamingMarkdown } from "./markdown-streaming.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

describe("toStreamingMarkdownParts", () => {
  it("does not rescan completed disclosures in appended prefixes", () => {
    const prefixes: string[] = [];
    let prefix = "<details><summary>Done</summary></details>\n\n";
    for (let index = 0; index < 48; index += 1) {
      prefix += `${String(index).padStart(3, "0")} ${"streaming markdown ".repeat(30)}\n`;
      prefixes.push(prefix);
    }
    // A full rescan revisits the completed disclosure on every chunk. Observe
    // the real scanner instead of comparing sub-millisecond wall-clock times.
    const scanDisclosure = vi.spyOn(markdownDetails, "scanMarkdownDisclosureLine");
    try {
      const fullSplits = prefixes.map((value) => splitStableStreamingMarkdown(value));
      expect(scanDisclosure).toHaveBeenCalledTimes(prefixes.length);
      scanDisclosure.mockClear();

      const incrementalSplits = prefixes.map((value) =>
        splitStableStreamingMarkdown(value, "line-scan-regression"),
      );
      expect(incrementalSplits).toEqual(fullSplits);
      expect(scanDisclosure).toHaveBeenCalledTimes(1);
    } finally {
      scanDisclosure.mockRestore();
    }
  });

  it("keeps chunked-prefix splits identical to full splits", () => {
    const splitIncrementally = splitStableStreamingMarkdown as (
      markdown: string,
      streamKey: string,
    ) => ReturnType<typeof splitStableStreamingMarkdown>;
    const cases = [
      [
        "## Result",
        "",
        "A paragraph with `inline code`.",
        "",
        "<details>",
        "<summary>Logs</summary>",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "More **text**",
        "",
        "</details>",
      ].join("\n"),
      "- one\n\n  - nested\n\n[Docs][ref\\]]\n\n[ref\\]]: /docs",
      "`` multiline\n<details> remains code\n``\n\n<details>\n<summary>Real</summary>",
      "- item\n\n    <details>\n    <summary>Logs</summary>\n\n    still inside",
      "1. item\n\n    <details>\n    <summary>Logs</summary>\n\n    still inside",
    ];
    for (const [caseIndex, markdown] of cases.entries()) {
      for (const chunkSize of [1, 7, 64]) {
        for (let end = chunkSize; end <= markdown.length + chunkSize; end += chunkSize) {
          const prefix = markdown.slice(0, Math.min(end, markdown.length));
          const key = `${caseIndex}-${chunkSize}`;
          expect(splitIncrementally(prefix, `split-parity-${key}`)).toEqual(
            splitStableStreamingMarkdown(prefix),
          );
          expect(toStreamingMarkdownParts(prefix, {}, `html-parity-${key}`).join("")).toBe(
            toStreamingMarkdownParts(prefix).join(""),
          );
          if (end >= markdown.length) {
            break;
          }
        }
      }
    }
  });

  it("resets replaced streams and keeps interleaved streams independent", () => {
    const splitIncrementally = splitStableStreamingMarkdown as (
      markdown: string,
      streamKey: string,
    ) => ReturnType<typeof splitStableStreamingMarkdown>;
    const streams = new Map([
      ["a", "First stream\n\n```ts\nconst a = 1;"],
      ["b", "Second stream\n\n<details>\n<summary>B</summary>"],
    ]);
    for (const end of [8, 16, 32, 64]) {
      for (const [key, markdown] of streams) {
        const prefix = markdown.slice(0, end);
        expect(splitIncrementally(prefix, `interleaved-${key}`)).toEqual(
          splitStableStreamingMarkdown(prefix),
        );
      }
    }
    for (const replacement of [
      "short",
      "Replacement\n\n- starts a different list",
      "A much longer replacement\n\n```ts\nconst changed = true;",
    ]) {
      expect(splitIncrementally(replacement, "interleaved-a")).toEqual(
        splitStableStreamingMarkdown(replacement),
      );
    }
  });

  it("resets an incremental cursor when a completed citation marker rewrites its prefix", () => {
    const partial = "Intro\n\ncitevery-long-partial-citation-marker";
    const completed = `${partial}\n\n\`\`\`ts\nconst answer = 42;`;

    toStreamingMarkdownParts(partial, {}, "citation-prefix-replacement");

    expect(toStreamingMarkdownParts(completed, {}, "citation-prefix-replacement").join("")).toBe(
      toStreamingMarkdownParts(completed).join(""),
    );
  });

  it.each(["- item", "1. item"])(
    "keeps details inside a loose %s list continuation while streaming",
    (item) => {
      const markdown = `${item}\n\n    <details>\n    <summary>Logs</summary>\n\n    still inside`;
      const fragment = htmlFragment(
        toStreamingMarkdownParts(markdown, {}, `loose-list:${item}`).join(""),
      );
      const details = fragment.querySelector("li details");

      expect(details?.querySelector("summary")?.textContent).toBe("Logs");
      expect(details?.textContent).toContain("still inside");
    },
  );

  it("preserves incremental parity when streamed text grows beyond the truncation cap", () => {
    const text = Array.from(
      { length: 210 },
      (_, index) => `${String(index).padStart(3, "0")} ${"streamed markdown ".repeat(55)}\n`,
    ).join("");

    for (const end of [139_500, 140_050, 141_000, text.length]) {
      const prefix = text.slice(0, end);

      expect(toStreamingMarkdownParts(prefix, {}, "truncated-stream-parity").join("")).toBe(
        toStreamingMarkdownParts(prefix).join(""),
      );
    }
  });

  it("marks a completed transcript-role header in the streaming tail", () => {
    const html = toStreamingMarkdownParts("user[Thu 2026-07-02] question", {
      assistantTranscriptRoleHeaders: true,
    }).join("");

    expect(html).toContain('class="assistant-transcript-role"');
  });

  it("renders streaming raw block art without collapsing quiet-zone spaces", () => {
    const blockArt = "  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ";
    const html = toStreamingMarkdownParts(blockArt).join("");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(fragment.querySelector("p")).toBeNull();
    expect(code?.textContent).toBe(blockArt);
  });

  it("truncates oversized streaming raw block art before rendering", () => {
    const line = "  ▀▀▀▀  ";
    const blockArt = Array.from({ length: 20_000 }, () => line).join("\n");
    const html = toStreamingMarkdownParts(blockArt).join("");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(code?.textContent).toContain("… truncated");
    expect(code?.textContent).toContain(`showing first 140000`);
    expect(code?.textContent?.length).toBeLessThan(blockArt.length);
  });

  it("localizes the oversized markdown truncation notice", async () => {
    i18n.registerTranslation("pt-BR", {
      chat: {
        markdown: {
          truncated: "… truncado ({total} caracteres, exibindo os primeiros {shown}).",
        },
      },
    });
    await i18n.setLocale("pt-BR");
    try {
      const blockArt = Array.from({ length: 20_000 }, () => "  ▀▀▀▀  ").join("\n");
      const fragment = htmlFragment(toStreamingMarkdownParts(blockArt).join(""));
      expect(fragment.textContent).toContain("… truncado");
      expect(fragment.textContent).toContain("exibindo os primeiros 140000");
    } finally {
      await i18n.setLocale("en");
    }
  });

  it("renders completed block prefixes as markdown and closes the streaming tail", () => {
    const html = toStreamingMarkdownParts("## Done\n\nworking **tail").join("");

    expect(html).toBe("<h2>Done</h2>\n<p>working <strong>tail</strong></p>\n");
  });

  it.each([
    ["loose sibling list items", "- one\n\n- two"],
    ["list-item paragraph continuation", "- one\n\n  continuation"],
    ["nested loose list items", "- one\n\n  - nested"],
    ["a reference link and its later definition", "[Docs][doc]\n\n[doc]: https://example.com"],
    ["escaped bracket labels", "[Docs][ref\\]]\n\n[ref\\]]: https://example.com"],
    ["multiline reference labels", "[Docs][foo bar]\n\n[foo\n bar]: https://example.com"],
    ["list-nested reference definitions", "See [x]\n\n- item\n\n    [x]: /url"],
    ["tab-indented list continuation", "Intro\n\n  - one\n\n\tcontinuation"],
    ["list continuation before a root heading", "- one\n\n  continuation\n# Heading"],
  ])("preserves whole-document Markdown semantics for %s", (_kind, input) => {
    expect(toStreamingMarkdownParts(input).join("")).toBe(toSanitizedMarkdownHtml(input));
  });

  it("uses Unicode separators as stable markdown boundaries", () => {
    const html = toStreamingMarkdownParts("## Done\u2028\u2028working **tail").join("");

    expect(html).toBe("<h2>Done</h2>\n<p>working <strong>tail</strong></p>\n");
  });

  it("renders a single open paragraph as markdown with closed formatting", () => {
    const html = toStreamingMarkdownParts("**still streaming").join("");

    expect(html).toBe("<p><strong>still streaming</strong></p>\n");
  });

  it("renders half-written links as text only while streaming", () => {
    const html = toStreamingMarkdownParts("see [Streamdown](https://strea").join("");

    expect(html).toBe("<p>see Streamdown</p>\n");
  });

  it("streams tables as markdown before the closing row arrives", () => {
    const html = toStreamingMarkdownParts("| left | right |\n| --- | --- |\n| 1 | 2").join("");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("table")).not.toBeNull();
    expect(fragment.querySelector("th")?.textContent).toBe("left");
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("leaves dollar amounts alone while streaming", () => {
    const html = toStreamingMarkdownParts("prices are $$50 and").join("");

    expect(html).toBe("<p>prices are $$50 and</p>\n");
  });
});

describe("indented Markdown source", () => {
  it.each(["    *literal*", "\t*literal*", "\n\n    *literal*"])(
    "renders initial code: %j",
    (source) => {
      expect(
        htmlFragment(toSanitizedMarkdownHtml(source)).querySelector("pre code")?.textContent,
      ).toBe("*literal*\n");
    },
  );

  it.each(["    a\n\n    b", "Intro\n\n    a\n\n    b"])(
    "keeps a streamed indented block together: %j",
    (source) => {
      const fragment = htmlFragment(toStreamingMarkdownParts(source).join(""));
      expect(fragment.querySelectorAll("pre code")).toHaveLength(1);
      expect(fragment.querySelector("pre code")?.textContent).toBe("a\n\nb\n");
    },
  );

  it("never repairs literal punctuation inside streaming indented code", () => {
    const source = "    *literal";
    for (let end = 5; end <= source.length; end++) {
      const fragment = htmlFragment(
        toStreamingMarkdownParts(source.slice(0, end), {}, "indented-prefix").join(""),
      );
      expect(fragment.querySelector("pre code")?.textContent).toBe(`${source.slice(4, end)}\n`);
    }
  });
});
