// Control UI tests cover markdown behavior.
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { handleMarkdownCodeBlockCopy } from "./markdown-code-blocks.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

function escapedCodeBlockCopyAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function withControlUiBasePath<T>(basePath: string, fn: () => T): T {
  const testWindow = window as Window & typeof globalThis & { [key: string]: unknown };
  Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
    value: basePath,
    writable: true,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    delete testWindow["__OPENCLAW_CONTROL_UI_BASE_PATH__"];
  }
}

describe("toSanitizedMarkdownHtml", () => {
  // ── Original tests from before markdown-it migration ──
  it("strips scripts and unsafe links", () => {
    const html = toSanitizedMarkdownHtml(
      [
        "<script>alert(1)</script>",
        "",
        "[x](javascript:alert(1))",
        "",
        "[ok](https://example.com)",
      ].join("\n"),
    );
    expect(html).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;\n\n<p>x</p>\n<p><a href="https://example.com" rel="noreferrer noopener" target="_blank">ok</a></p>\n',
    );
  });

  it("does not stamp presentation classes on links whose href contains 'tail'", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml("[tailscale docs](https://docs.openclaw.ai/tailscale)"),
    );
    const link = fragment.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://docs.openclaw.ai/tailscale");
    expect(link?.classList.contains("chat-link-tail-blur")).toBe(false);
  });

  it("strips unsupported citation control markers before display", () => {
    const html = toSanitizedMarkdownHtml(
      "v2026.5.20 release note citeturn2view0\n\nStill readable.",
    );

    expect(html).toBe("<p>v2026.5.20 release note</p>\n<p>Still readable.</p>\n");
    expect(html).not.toContain("cite");
    expect(html).not.toContain("turn2view0");
  });

  it("normalizes Unicode and CR line breaks before rendering", () => {
    const unicodeInput =
      "## Unicode separator cache sentinel\u2028\u2028- alpha\u2029- beta\r- gamma\r\n- delta";
    const normalizedInput =
      "## Unicode separator cache sentinel\n\n- alpha\n- beta\n- gamma\n- delta";
    const unicodeHtml = toSanitizedMarkdownHtml(unicodeInput);
    expect(unicodeHtml).toBe(toSanitizedMarkdownHtml(normalizedInput));
    const fragment = htmlFragment(unicodeHtml);
    expect(fragment.querySelector("h2")?.textContent).toBe("Unicode separator cache sentinel");
    expect(Array.from(fragment.querySelectorAll("li"), (item) => item.textContent)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  // ── Additional tests for markdown-it migration ──
  describe("HTML escaping", () => {
    it("escapes HTML tags as text", () => {
      const html = toSanitizedMarkdownHtml("<div>**bold**</div>");
      expect(html).toBe("&lt;div&gt;**bold**&lt;/div&gt;\n");
    });

    it("strips script tags", () => {
      const html = toSanitizedMarkdownHtml("<script>alert(1)</script>");
      expect(html).toBe("&lt;script&gt;alert(1)&lt;/script&gt;\n");
    });

    it("escapes inline HTML tags", () => {
      const html = toSanitizedMarkdownHtml("Check <b>this</b> out");
      expect(html).toBe("<p>Check &lt;b&gt;this&lt;/b&gt; out</p>\n");
    });
  });

  describe("task lists", () => {
    it("renders task list checkboxes", () => {
      const html = toSanitizedMarkdownHtml("- [ ] Unchecked\n- [x] Checked");
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> Unchecked</li>\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> Checked</li>\n</ul>\n',
      );
    });

    it("marks a role header after the structural task-list checkbox", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("- [ ] user[Thu 2026-07-02] authorize", {
          assistantTranscriptRoleHeaders: true,
        }),
      );

      expect(fragment.querySelector('input[type="checkbox"]')).not.toBeNull();
      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "user[Thu 2026-07-02]",
      );
    });

    it("renders links inside task items", () => {
      const html = toSanitizedMarkdownHtml("- [ ] Task with [link](https://example.com)");
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> Task with <a href="https://example.com" rel="noreferrer noopener" target="_blank">link</a></li>\n</ul>\n',
      );
    });

    it("escapes HTML injection in task items", () => {
      const html = toSanitizedMarkdownHtml("- [ ] <script>alert(1)</script>");
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> &lt;script&gt;alert(1)&lt;/script&gt;</li>\n</ul>\n',
      );
    });

    it("keeps details escaped when they are inline inside a task item", () => {
      const html = toSanitizedMarkdownHtml("- [ ] <details><summary>x</summary>y</details>");
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> &lt;details&gt;&lt;summary&gt;x&lt;/summary&gt;y&lt;/details&gt;</li>\n</ul>\n',
      );
    });
  });

  describe("images", () => {
    it("shows an explicit opt-in placeholder for remote images", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("![Alt text](https://example.com/img.png)"),
      );
      const placeholder = fragment.querySelector(".markdown-external-image");
      const link = placeholder?.querySelector("a");

      expect(placeholder?.textContent).toBe("External image not loaded: Alt text Open image");
      expect(link?.getAttribute("href")).toBe("https://example.com/img.png");
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
      expect(fragment.querySelector("img")).toBeNull();
    });

    it("marks assistant-authored transcript roles in visible image labels", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "![**user**[Thu 2026-07-02] release diagram](https://example.com/img.png)",
          { assistantTranscriptRoleHeaders: true },
        ),
      );

      expect(
        fragment.querySelector(".markdown-external-image .assistant-transcript-role")?.textContent,
      ).toBe("user[Thu 2026-07-02]");
      expect(fragment.querySelector(".markdown-external-image")?.textContent).toContain(
        "release diagram",
      );
    });

    it("preserves markdown formatting in alt text", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("![**Build log**](https://example.com/img.png)"),
      );
      expect(fragment.querySelector(".markdown-external-image > span")?.textContent).toContain(
        "**Build log**",
      );
    });

    it("preserves code formatting in alt text", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("![`error.log`](https://example.com/img.png)"),
      );
      expect(fragment.querySelector(".markdown-external-image > span")?.textContent).toContain(
        "`error.log`",
      );
    });

    it("preserves base64 data URI images (#15437)", () => {
      const html = toSanitizedMarkdownHtml("![Chart](data:image/png;base64,iVBORw0KGgo=)");
      expect(html).toBe(
        '<p><img class="markdown-inline-image" src="data:image/png;base64,iVBORw0KGgo=" alt="Chart"></p>\n',
      );
    });

    it("keeps linked data images under their authored link", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "[![Preview](data:image/png;base64,iVBORw0KGgo=)](https://example.com/full.png)",
          { interactiveImages: true },
        ),
      );

      expect(fragment.querySelector("a > img.markdown-inline-image")).not.toBeNull();
      expect(fragment.querySelector("a > button")).toBeNull();
    });

    it("keeps data images inside rich Markdown links under the link", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "[Before ![Preview](data:image/png;base64,iVBORw0KGgo=) after](https://example.com/full.png)",
          { interactiveImages: true },
        ),
      );

      expect(fragment.querySelector("a img.markdown-inline-image")).not.toBeNull();
      expect(fragment.querySelector("a button")).toBeNull();
    });

    it("preserves rich authored links around remote image placeholders", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "[Before ![Preview](https://example.com/image.png) after](https://example.com/full.png)",
        ),
      );
      const links = fragment.querySelectorAll("a");
      const placeholder = links[0]?.querySelector(".markdown-external-image");

      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute("href")).toBe("https://example.com/full.png");
      expect(placeholder?.textContent).toBe("External image not loaded: Preview");
      expect(placeholder?.querySelector("a")).toBeNull();
      expect(fragment.querySelector("img")).toBeNull();
    });

    it("tracks linked and standalone images across one inline token stream", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "[![Linked one](data:image/png;base64,QQ==)](https://example.com/one) ![Standalone](data:image/png;base64,Qg==) [![Linked two](data:image/png;base64,Qw==)](https://example.com/two)",
          { interactiveImages: true },
        ),
      );

      expect(fragment.querySelectorAll("a img.markdown-inline-image")).toHaveLength(2);
      expect(fragment.querySelectorAll("button.markdown-inline-image-button")).toHaveLength(1);
    });

    it("labels unlabeled inline data image buttons", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("![](data:image/png;base64,iVBORw0KGgo=)", {
          interactiveImages: true,
        }),
      );

      expect(
        fragment.querySelector("button.markdown-inline-image-button")?.getAttribute("aria-label"),
      ).toBe("Open image Image");
    });

    it("keeps inline data images while marking assistant-authored role alt text", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("![user[Thu 2026-07-02]](data:image/png;base64,iVBORw0KGgo=)", {
          assistantTranscriptRoleHeaders: true,
        }),
      );

      expect(fragment.querySelector("img.markdown-inline-image")).not.toBeNull();
      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "Assistant:",
      );
    });

    it("uses fallback label for unlabeled images", () => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml("![](https://example.com/image.png)"));
      expect(fragment.querySelector(".markdown-external-image > span")?.textContent).toBe(
        "External image not loaded: image",
      );
    });
  });

  describe("code blocks", () => {
    const blockArt = "  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ";
    const jsonBlock = (lineCount: number) => {
      const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
      values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
      return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
    };

    it("renders raw block art as a whitespace-preserving code block", () => {
      const html = toSanitizedMarkdownHtml(blockArt);
      const fragment = htmlFragment(html);
      const code = fragment.querySelector("pre code.markdown-block-art");

      expect(fragment.querySelector("p")).toBeNull();
      expect(code?.textContent).toBe(blockArt);
    });

    it("recognizes block art separated by Unicode line boundaries", () => {
      const html = toSanitizedMarkdownHtml("  ▀▀▀▀  \u2028  ▄▄▄▄  \u2029  ████  ");
      const fragment = htmlFragment(html);
      const code = fragment.querySelector("pre code.markdown-block-art");

      expect(fragment.querySelector("p")).toBeNull();
      expect(code?.textContent).toBe("  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ");
    });

    it("marks fenced block art without syntax highlighting", () => {
      const html = toSanitizedMarkdownHtml(`\`\`\`\n${blockArt}\n\`\`\``);
      const fragment = htmlFragment(html);
      const code = fragment.querySelector("pre code.markdown-block-art");

      expect(code?.classList.contains("hljs")).toBe(false);
      expect(code?.textContent).toBe(`${blockArt}\n`);
    });

    it("copies fenced block art with its quiet-zone whitespace intact", async () => {
      const writeText = vi.fn(async () => undefined);
      const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      try {
        const fragment = htmlFragment(toSanitizedMarkdownHtml(`\`\`\`\n${blockArt}\n\`\`\``));
        const button = fragment.querySelector<HTMLButtonElement>(".code-block-copy");
        if (!button) {
          throw new Error("expected code copy button");
        }

        fragment.addEventListener("click", handleMarkdownCodeBlockCopy);
        button.click();

        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(blockArt));
      } finally {
        if (originalClipboard) {
          Object.defineProperty(navigator, "clipboard", originalClipboard);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }
    });

    it("renders indented code blocks", () => {
      // markdown-it requires a blank line before indented code
      const html = toSanitizedMarkdownHtml("text\n\n    indented code");
      expect(html).toBe(
        `<p>text</p>\n<div class="code-block-wrapper"><div class="code-block-header"><button type="button" class="code-block-copy" data-code="${escapedCodeBlockCopyAttribute("indented code")}" aria-label="Copy code"><span class="code-block-copy__idle">Copy</span><span class="code-block-copy__done">Copied!</span></button></div><pre><code>indented code\n</code></pre></div>`,
      );
    });

    it("includes copy button", () => {
      const html = toSanitizedMarkdownHtml("```\ncode\n```");
      expect(html).toBe(
        `<div class="code-block-wrapper"><div class="code-block-header"><button type="button" class="code-block-copy" data-code="${escapedCodeBlockCopyAttribute("code")}" aria-label="Copy code"><span class="code-block-copy__idle">Copy</span><span class="code-block-copy__done">Copied!</span></button></div><pre><code>code\n</code></pre></div>`,
      );
    });

    it("omits copy chrome when rendering user-preserved code blocks", () => {
      const source = `python3 - <<'PY'
import openpyxl

for ws in wb.worksheets:
    print(f"--- {ws.title} ---")
    rows = 0

    for row in ws.iter_rows(values_only=True):
        print(row)
PY
`;
      const html = toSanitizedMarkdownHtml(`\`\`\`bash\n${source}\`\`\``, {
        codeBlockChrome: "none",
      });
      const fragment = htmlFragment(html);

      expect(fragment.querySelector(".code-block-copy")).toBeNull();
      expect(fragment.textContent).toBe(source);
    });

    it("keeps the no-chrome code-block cache separate from copy-enabled rendering", () => {
      const markdown = "```\ncode\n```";
      const plain = toSanitizedMarkdownHtml(markdown, { codeBlockChrome: "none" });
      const copyable = toSanitizedMarkdownHtml(markdown);

      expect(htmlFragment(plain).querySelector(".code-block-copy")).toBeNull();
      expect(htmlFragment(copyable).querySelector(".code-block-copy")).toBeInstanceOf(
        HTMLButtonElement,
      );
    });

    it("keeps short JSON code blocks visible and highlighted", () => {
      const html = toSanitizedMarkdownHtml(jsonBlock(6));
      const fragment = htmlFragment(html);
      const code = fragment.querySelector(".code-block-wrapper pre code");

      expect(fragment.querySelector("details.json-collapse")).toBeNull();
      expect(code?.textContent?.split("\n")).toHaveLength(7);
      expect(code?.innerHTML).toContain("hljs-");
    });

    it("collapses JSON only above 40 lines and uses one copyable header", () => {
      const atLimit = htmlFragment(toSanitizedMarkdownHtml(jsonBlock(40)));
      const overLimit = htmlFragment(toSanitizedMarkdownHtml(jsonBlock(41)));
      const details = overLimit.querySelector("details.json-collapse");
      const summary = details?.querySelector("summary");

      expect(atLimit.querySelector("details.json-collapse")).toBeNull();
      expect(summary?.textContent).toContain("JSON · 41 lines");
      expect(summary?.querySelector(".code-block-copy")).toBeInstanceOf(HTMLButtonElement);
      expect(details?.querySelectorAll(".code-block-header")).toHaveLength(1);
      expect(summary?.classList.contains("code-block-header")).toBe(true);
      expect(details?.querySelector("pre code")?.innerHTML).toContain("hljs-");
    });

    it("localizes collapsed JSON line counts", async () => {
      i18n.registerTranslation("pt-BR", {
        chat: {
          codeBlock: {
            jsonLines: "JSON · {count} linhas",
          },
        },
      });
      await i18n.setLocale("pt-BR");
      try {
        const fragment = htmlFragment(toSanitizedMarkdownHtml(jsonBlock(41)));
        expect(fragment.querySelector("summary")?.textContent).toContain("JSON · 41 linhas");
      } finally {
        await i18n.setLocale("en");
      }
    });

    it("auto-highlights unlabeled code blocks only when detection is confident", () => {
      const html = toSanitizedMarkdownHtml("```\n#include <vector>\nstd::vector<int> nums;\n```");
      const fragment = htmlFragment(html);
      const code = fragment.querySelector("pre code");

      expect(code?.classList.contains("hljs")).toBe(true);
      expect(code?.textContent).toBe("#include <vector>\nstd::vector<int> nums;\n");
      expect(code?.innerHTML).toContain("hljs-meta");
      expect(code?.innerHTML).toContain("hljs-keyword");
    });

    it("keeps highlighted HTML code escaped", () => {
      const html = toSanitizedMarkdownHtml("```html\n<script>alert(1)</script>\n```");
      const fragment = htmlFragment(html);
      const code = fragment.querySelector("pre code");

      expect(code?.querySelector("script")).toBeNull();
      expect(code?.textContent).toBe("<script>alert(1)</script>\n");
      expect(code?.innerHTML).not.toContain("<script>");
    });
  });

  describe("GFM features", () => {
    it("moves footnotes to navigable endnotes with local backlinks", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("Claim[^source].\n\n[^source]: Supporting **detail**.", {
          documentId: "message-1",
        }),
      );
      const reference = fragment.querySelector<HTMLAnchorElement>(".footnote-ref a");
      const note = fragment.querySelector<HTMLElement>(".footnote-item");
      const backlink = fragment.querySelector<HTMLAnchorElement>(".footnote-backref");

      expect(reference?.textContent).toBe("1");
      expect(reference?.getAttribute("href")).toBe(`#${note?.id}`);
      expect(backlink?.getAttribute("href")).toBe(`#${reference?.id}`);
      expect(backlink?.getAttribute("aria-label")).toBe("Back");
      expect(note?.textContent).toContain("Supporting detail.");
      expect(fragment.textContent).not.toContain("[^source]");
    });

    it("namespaces equal footnotes from different transcript messages", () => {
      const markdown = "Claim[^note].\n\n[^note]: Detail.";
      const first = htmlFragment(toSanitizedMarkdownHtml(markdown, { documentId: "message-1" }));
      const second = htmlFragment(toSanitizedMarkdownHtml(markdown, { documentId: "message-2" }));

      expect(first.querySelector(".footnote-ref a")?.id).not.toBe(
        second.querySelector(".footnote-ref a")?.id,
      );
    });

    it("renders inline and display math as sanitized MathML", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("Energy is $E = mc^2$.\n\n$$\\int_0^1 x^2 \\, dx$$"),
      );
      const inlineMath = fragment.querySelector("p:not(.katex-block) math");
      const displayMath = fragment.querySelector(".katex-block math");

      expect(inlineMath?.getAttribute("display")).toBeNull();
      expect(inlineMath?.querySelector("msup")).not.toBeNull();
      expect(displayMath?.getAttribute("display")).toBe("block");
      expect(displayMath?.querySelector("munderover, msubsup")).not.toBeNull();
      expect(fragment.querySelector("annotation")?.getAttribute("encoding")).toBe(
        "application/x-tex",
      );
      expect(fragment.querySelector("semantics > annotation")?.textContent).toBe("E = mc^2");
    });

    it("keeps currency and Mermaid fences out of math rendering", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("The total is $50.\n\n```mermaid\ngraph TD; A-->B\n```"),
      );

      expect(fragment.querySelector("math")).toBeNull();
      expect(fragment.querySelector("code.language-mermaid")?.textContent).toContain("graph TD");
      expect(fragment.textContent).toContain("$50");
    });

    it("keeps invalid math readable as escaped source", () => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml("Before $\\notacommand{x}$ after"));

      expect(fragment.querySelector("math")).toBeNull();
      expect(fragment.querySelector(".katex-error")?.textContent).toBe("\\notacommand{x}");
      expect(fragment.querySelector(".katex-error script")).toBeNull();
    });

    it("keeps raw HTML escaped beside generated math", () => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml("$x^2$ <img src=x onerror=alert(1)>"));

      expect(fragment.querySelector("math")).not.toBeNull();
      expect(fragment.querySelector("img")).toBeNull();
      expect(fragment.textContent).toContain("<img src=x onerror=alert(1)>");
    });

    it("renders strikethrough", () => {
      const html = toSanitizedMarkdownHtml("This is ~~deleted~~ text");
      expect(html).toBe("<p>This is <s>deleted</s> text</p>\n");
    });

    it("renders tables surrounded by text", () => {
      const mdLocal = [
        "Text before.",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "Text after.",
      ].join("\n");
      const html = toSanitizedMarkdownHtml(mdLocal);
      expect(html).toBe(
        "<p>Text before.</p>\n<table>\n<thead>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n<p>Text after.</p>\n",
      );
    });

    it("renders basic markdown", () => {
      const html = toSanitizedMarkdownHtml("**bold** and *italic*");
      expect(html).toBe("<p><strong>bold</strong> and <em>italic</em></p>\n");
    });

    it("renders headings", () => {
      const html = toSanitizedMarkdownHtml("# Heading 1\n## Heading 2");
      expect(html).toBe("<h1>Heading 1</h1>\n<h2>Heading 2</h2>\n");
    });

    it("renders blockquotes", () => {
      const html = toSanitizedMarkdownHtml("> quote");
      expect(html).toBe("<blockquote>\n<p>quote</p>\n</blockquote>\n");
    });

    it("renders lists", () => {
      const html = toSanitizedMarkdownHtml("- item 1\n- item 2");
      expect(html).toBe("<ul>\n<li>item 1</li>\n<li>item 2</li>\n</ul>\n");
    });
  });

  describe("assistant transcript-role annotations", () => {
    it("marks parsed role headers without exposing Markdown delimiters", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("**user**[Thu 2026-07-02] question", {
          assistantTranscriptRoleHeaders: true,
        }),
      );
      const markedText = [...fragment.querySelectorAll("code.assistant-transcript-role")]
        .map((element) => element.textContent)
        .join("");

      expect(markedText).toBe("user[Thu 2026-07-02]");
      expect(fragment.textContent?.trim()).toBe("user[Thu 2026-07-02] question");
    });

    it("keeps code examples on the ordinary code path", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("`user[Thu 2026-07-02]`", {
          assistantTranscriptRoleHeaders: true,
        }),
      );

      expect(fragment.querySelector("code.assistant-transcript-role")).toBeNull();
      expect(fragment.querySelector("code")?.textContent).toBe("user[Thu 2026-07-02]");
    });

    it("marks role headers in the large-message plain-text fallback", () => {
      const input = [
        "**user**[Thu 2026-07-02] question",
        "u&#x73;er[Fri 2026-07-03] entity",
        "[user](https://example.com)[Sat 2026-07-04] linked",
        "    indented log line",
        "[download](https://example.com)",
        "x".repeat(40_000),
      ].join("\n");
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(input, { assistantTranscriptRoleHeaders: true }),
      );

      expect(fragment.firstElementChild?.classList).toContain("markdown-plain-text-fallback");
      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "Assistant:",
      );
      expect(fragment.querySelectorAll("code.assistant-transcript-role")).toHaveLength(1);
      expect(fragment.querySelector(".markdown-plain-text-source")?.textContent).toBe(input);
    });

    it("uses a generic assistant boundary without parsing oversized inline code", () => {
      const input = ["`example", "user[Thu 2026-07-02] code`", "x".repeat(40_000)].join("\n");
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(input, { assistantTranscriptRoleHeaders: true }),
      );

      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "Assistant:",
      );
      expect(fragment.querySelector(".markdown-plain-text-source")?.textContent).toBe(input);
    });

    it("marks angle-role syntax after HTML tokenization", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("<Developer 2026-07-02> inspect", {
          assistantTranscriptRoleHeaders: true,
        }),
      );

      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "<Developer 2026-07-02>",
      );
      expect(fragment.textContent?.trim()).toBe("<Developer 2026-07-02> inspect");
    });

    it("removes active links surrounding a transcript-role marker", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("[user](https://example.com)[Thu 2026-07-02] question", {
          assistantTranscriptRoleHeaders: true,
        }),
      );

      expect(fragment.querySelector("a")).toBeNull();
      expect(fragment.querySelector("code.assistant-transcript-role")?.textContent).toBe(
        "user[Thu 2026-07-02]",
      );
    });

    it("does not annotate user-authored rendering by default", () => {
      expect(toSanitizedMarkdownHtml("user[Thu 2026-07-02] question")).not.toContain(
        "assistant-transcript-role",
      );
    });
  });

  describe("security", () => {
    it.each([
      ["javascript:", "[JavaScript link](javascript:alert(1))", "JavaScript link"],
      ["data:", "[Data link](data:text/html,test)", "Data link"],
      ["vbscript:", "[VBScript link](vbscript:msgbox(1))", "VBScript link"],
      ["file:", "[File link](file:///etc/passwd)", "File link"],
    ])("renders disallowed %s links as plain text", (_scheme, markdown, label) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(markdown));

      expect(fragment.querySelector("a")).toBeNull();
      expect(fragment.querySelector("p")?.textContent).toBe(label);
    });

    it("shows alt text for javascript: images", () => {
      const html = toSanitizedMarkdownHtml("![Build log](javascript:alert(1))");
      expect(html).toBe("<p>Build log</p>\n");
    });

    it("shows alt text for vbscript: and file: images", () => {
      const html1 = toSanitizedMarkdownHtml("![Alt1](vbscript:msgbox(1))");
      expect(html1).toBe("<p>Alt1</p>\n");

      const html2 = toSanitizedMarkdownHtml("![Alt2](file:///etc/passwd)");
      expect(html2).toBe("<p>Alt2</p>\n");
    });

    it("does not auto-link bare file:// URIs", () => {
      const html = toSanitizedMarkdownHtml("Check file:///etc/passwd");
      expect(html).toBe("<p>Check file:///etc/passwd</p>\n");
    });

    it("strips href from host-local absolute file paths", () => {
      const html = toSanitizedMarkdownHtml(
        "[report.docx](/Users/test/.openclaw/data/skills/output/report.docx)",
      );
      expect(html).toBe("<p><a>report.docx</a></p>\n");
    });

    it("keeps app-relative links navigable", () => {
      const html = toSanitizedMarkdownHtml("[usage](/usage)");
      expect(html).toBe('<p><a href="/usage">usage</a></p>\n');
    });

    it("rewrites docs-root links to the public docs host", () => {
      const html = toSanitizedMarkdownHtml(
        "[workspace](/concepts/agent-workspace) [hooks](/automation/hooks#session-memory) [telegram](/channels/telegram?tab=setup) [shortlink](/telegram) [openai](/openai) [images](/images) [groups](/groups) [camera](/nodes/camera) [macOS](/platforms/macos) [cliSessions](/cli/sessions) [toolSkills](/tools/skills) [pluginDocs](/plugins/reference/diffs) [prose](/prose) [access](/channels/access-groups)",
      );
      expect(html).toBe(
        '<p><a href="https://docs.openclaw.ai/concepts/agent-workspace" rel="noreferrer noopener" target="_blank">workspace</a> <a href="https://docs.openclaw.ai/automation/hooks#session-memory" rel="noreferrer noopener" target="_blank">hooks</a> <a href="https://docs.openclaw.ai/channels/telegram?tab=setup" rel="noreferrer noopener" target="_blank">telegram</a> <a href="https://docs.openclaw.ai/telegram" rel="noreferrer noopener" target="_blank">shortlink</a> <a href="https://docs.openclaw.ai/openai" rel="noreferrer noopener" target="_blank">openai</a> <a href="https://docs.openclaw.ai/images" rel="noreferrer noopener" target="_blank">images</a> <a href="https://docs.openclaw.ai/groups" rel="noreferrer noopener" target="_blank">groups</a> <a href="https://docs.openclaw.ai/nodes/camera" rel="noreferrer noopener" target="_blank">camera</a> <a href="https://docs.openclaw.ai/platforms/macos" rel="noreferrer noopener" target="_blank">macOS</a> <a href="https://docs.openclaw.ai/cli/sessions" rel="noreferrer noopener" target="_blank">cliSessions</a> <a href="https://docs.openclaw.ai/tools/skills" rel="noreferrer noopener" target="_blank">toolSkills</a> <a href="https://docs.openclaw.ai/plugins/reference/diffs" rel="noreferrer noopener" target="_blank">pluginDocs</a> <a href="https://docs.openclaw.ai/prose" rel="noreferrer noopener" target="_blank">prose</a> <a href="https://docs.openclaw.ai/channels/access-groups" rel="noreferrer noopener" target="_blank">access</a></p>\n',
      );
    });

    it("keeps app and resource routes instead of treating them as docs roots", () => {
      const html = withControlUiBasePath("/control", () =>
        toSanitizedMarkdownHtml(
          "[channels](/channels) [automation](/automation) [workshop](/skills/workshop) [chat](/chat) [baseChat](/control/chat/main) [baseSessions](/control/sessions) [health](/healthz) [pluginDynamic](/googlechat) [asset](/api/files/1) [baseApi](/control/api/files/1) [baseAvatar](/control/avatar/main) [plugin](/plugins/diffs/view/id/token) [basePlugin](/control/plugins/diffs/view/id/token) [artifact](/__openclaw__/canvas/documents/x/index.html) [baseArtifact](/control/__openclaw__/canvas/x)",
        ),
      );
      expect(html).toBe(
        '<p><a href="/channels">channels</a> <a href="/automation">automation</a> <a href="/skills/workshop">workshop</a> <a href="/chat">chat</a> <a href="/control/chat/main">baseChat</a> <a href="/control/sessions">baseSessions</a> <a href="/healthz" rel="noreferrer noopener" target="_blank">health</a> <a href="/googlechat" rel="noreferrer noopener" target="_blank">pluginDynamic</a> <a href="/api/files/1" rel="noreferrer noopener" target="_blank">asset</a> <a href="/control/api/files/1" rel="noreferrer noopener" target="_blank">baseApi</a> <a href="/control/avatar/main" rel="noreferrer noopener" target="_blank">baseAvatar</a> <a href="/plugins/diffs/view/id/token" rel="noreferrer noopener" target="_blank">plugin</a> <a href="/control/plugins/diffs/view/id/token" rel="noreferrer noopener" target="_blank">basePlugin</a> <a href="/__openclaw__/canvas/documents/x/index.html" rel="noreferrer noopener" target="_blank">artifact</a> <a href="/control/__openclaw__/canvas/x" rel="noreferrer noopener" target="_blank">baseArtifact</a></p>\n',
      );
    });
  });

  describe("ReDoS protection", () => {
    it("renders deeply nested emphasis markers without dropping text (#36213)", () => {
      const nested = "*".repeat(500) + "text" + "*".repeat(500);
      const html = toSanitizedMarkdownHtml(nested);
      const container = htmlFragment(html);
      expect(container.children).toHaveLength(1);
      expect(container.firstElementChild?.tagName).toBe("P");
      expect(container.textContent).toBe("text\n");
    });

    it("renders deeply nested brackets without dropping text (#36213)", () => {
      const nested = "[".repeat(200) + "link" + "]".repeat(200) + "(" + "x".repeat(200) + ")";
      const html = toSanitizedMarkdownHtml(nested);
      const container = htmlFragment(html);
      expect(container.children).toHaveLength(1);
      expect(container.firstElementChild?.tagName).toBe("P");
      expect(container.textContent).toBe(`${nested}\n`);
    });

    it("does not hang on backtick + bracket ReDoS pattern", { timeout: 2_000 }, () => {
      const HEADER =
        '{"type":"message","id":"aaa","parentId":"bbb",' +
        '"timestamp":"2000-01-01T00:00:00.000Z","message":' +
        '{"role":"toolResult","toolCallId":"call_000",' +
        '"toolName":"read","content":[{"type":"text","text":' +
        '"{\\"type\\":\\"message\\",\\"id\\":\\"ccc\\",' +
        '\\"timestamp\\":\\"2000-01-01T00:00:00.000Z\\",' +
        '\\"message\\":{\\"role\\":\\"toolResult\\",' +
        '\\"toolCallId\\":\\"call_111\\",\\"toolName\\":\\"read\\",' +
        '\\"content\\":[{\\"type\\":\\"text\\",' +
        '\\"text\\":\\"# Memory Index\\\\n\\\\n';

      const RECORD_UNIT =
        "## 2000-01-01 00:00:00 done [tag]\\\\n" +
        "**question**:\\\\n```\\\\nsome question text here\\\\n```\\\\n" +
        "**details**: [see details](./2000.01.01/00000000/INFO.md)\\\\n\\\\n";

      const poison = HEADER + RECORD_UNIT.repeat(9);

      const start = performance.now();
      const html = toSanitizedMarkdownHtml(poison);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(500);
      expect(html.length).toBeGreaterThan(0);
    });
  });

  describe("large text handling", () => {
    it("uses plain text fallback for oversized content", () => {
      // MARKDOWN_PARSE_LIMIT is 40_000 chars
      const input = Array.from(
        { length: 220 },
        (_, i) =>
          `Paragraph ${i + 1}: ${Array.from({ length: 8 }, () => "Long plain-text reply.").join(
            " ",
          )}`,
      ).join("\n\n");
      const html = toSanitizedMarkdownHtml(input);
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.tagName).toBe("DIV");
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(input);
    });

    it("preserves indentation in plain text fallback", () => {
      const input = `${"Header line\n".repeat(3400)}\n    indented log line\n        deeper indent`;
      const html = toSanitizedMarkdownHtml(input);
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(input);
    });

    it("caches oversized fallback results", () => {
      const input =
        Array.from({ length: 240 }, (_, i) => `P${i}`).join("\n\n") + "x".repeat(45_000);
      const first = toSanitizedMarkdownHtml(input);
      const second = toSanitizedMarkdownHtml(input);
      expect(input.length).toBeGreaterThan(40_000);
      expect(htmlFragment(first).firstElementChild?.className).toBe("markdown-plain-text-fallback");
      expect(second).toBe(first);
    });
  });
});

describe("toStreamingMarkdownHtml", () => {
  it("marks a completed transcript-role header in the streaming tail", () => {
    const html = toStreamingMarkdownHtml("user[Thu 2026-07-02] question", {
      assistantTranscriptRoleHeaders: true,
    });

    expect(html).toContain('class="assistant-transcript-role"');
  });

  it("renders streaming raw block art without collapsing quiet-zone spaces", () => {
    const blockArt = "  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ";
    const html = toStreamingMarkdownHtml(blockArt);
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(fragment.querySelector("p")).toBeNull();
    expect(code?.textContent).toBe(blockArt);
  });

  it("truncates oversized streaming raw block art before rendering", () => {
    const line = "  ▀▀▀▀  ";
    const blockArt = Array.from({ length: 20_000 }, () => line).join("\n");
    const html = toStreamingMarkdownHtml(blockArt);
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
      const fragment = htmlFragment(toStreamingMarkdownHtml(blockArt));
      expect(fragment.textContent).toContain("… truncado");
      expect(fragment.textContent).toContain("exibindo os primeiros 140000");
    } finally {
      await i18n.setLocale("en");
    }
  });

  it("renders completed block prefixes as markdown and closes the streaming tail", () => {
    const html = toStreamingMarkdownHtml("## Done\n\nworking **tail");

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
    expect(toStreamingMarkdownHtml(input)).toBe(toSanitizedMarkdownHtml(input));
  });

  it("uses Unicode separators as stable markdown boundaries", () => {
    const html = toStreamingMarkdownHtml("## Done\u2028\u2028working **tail");

    expect(html).toBe("<h2>Done</h2>\n<p>working <strong>tail</strong></p>\n");
  });

  it("renders a single open paragraph as markdown with closed formatting", () => {
    const html = toStreamingMarkdownHtml("**still streaming");

    expect(html).toBe("<p><strong>still streaming</strong></p>\n");
  });

  it("renders half-written links as text only while streaming", () => {
    const html = toStreamingMarkdownHtml("see [Streamdown](https://strea");

    expect(html).toBe("<p>see Streamdown</p>\n");
  });

  it("streams tables as markdown before the closing row arrives", () => {
    const html = toStreamingMarkdownHtml("| left | right |\n| --- | --- |\n| 1 | 2");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("table")).not.toBeNull();
    expect(fragment.querySelector("th")?.textContent).toBe("left");
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("leaves dollar amounts alone while streaming", () => {
    const html = toStreamingMarkdownHtml("prices are $$50 and");

    expect(html).toBe("<p>prices are $$50 and</p>\n");
  });

  it("streams an open code fence as a live-highlighted code block", () => {
    const html = toStreamingMarkdownHtml("Intro\n\n```ts\nconst x = 1 < 2");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("p")?.textContent).toBe("Intro");
    expect(fragment.querySelector("code.language-ts")?.textContent).toContain("const x = 1 < 2");
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("streams an open list code fence through blank lines", () => {
    const html = toStreamingMarkdownHtml("- ```ts\n  const x = 1;\n\n  const y = 2;");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("li code");

    expect(code?.textContent).toContain("const x = 1;");
    expect(code?.textContent).toContain("const y = 2;");
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("keeps completed tilde-fence code out of the remend tail", () => {
    // remend only understands ``` fences; a closed ~~~ block must land in the
    // stable prefix so its raw markers are never "completed" as inline markdown.
    const html = toStreamingMarkdownHtml('~~~ts\nconst s = "**open";\n~~~\ncontinuing **bold');
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("code")?.textContent).toContain('const s = "**open";');
    expect(fragment.querySelector("code strong")).toBeNull();
    expect(fragment.querySelector("p strong")?.textContent).toBe("bold");
  });

  it("streams an open blockquote code fence through blank lines", () => {
    const html = toStreamingMarkdownHtml("> ```ts\n> const x = 1;\n>\n> const y = 2;");
    const fragment = htmlFragment(html);
    const code = fragment.querySelector("blockquote code");

    expect(code?.textContent).toContain("const x = 1;");
    expect(code?.textContent).toContain("const y = 2;");
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("renders a completed code fence once the closing fence arrives", () => {
    const html = toStreamingMarkdownHtml("```ts\nconst x = 1;\n```");

    expect(html).toContain('<code class="hljs language-ts"');
    expect(html).toContain("const x = 1;");
    expect(html).not.toContain("markdown-plain-text-fallback");
  });
});
