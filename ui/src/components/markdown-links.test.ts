// Control UI tests cover markdown link rendering: autolinking, file links, and link marks.
import { describe, expect, it, vi } from "vitest";
import { shortestFileLabels } from "./file-kind.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("toSanitizedMarkdownHtml links", () => {
  describe("www autolinks", () => {
    it("links www.example.com", () => {
      const html = toSanitizedMarkdownHtml("Visit www.example.com today");
      expect(html).toBe(
        '<p>Visit <a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a> today</p>\n',
      );
    });

    it("links www.example.com with path, query, and fragment", () => {
      const html = toSanitizedMarkdownHtml("See www.example.com/path?a=1#section");
      expect(html).toBe(
        '<p>See <a href="http://www.example.com/path?a=1#section" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path?a=1#section</a></p>\n',
      );
    });

    it("links www.example.com with port", () => {
      const html = toSanitizedMarkdownHtml("Visit www.example.com:8080/foo");
      expect(html).toBe(
        '<p>Visit <a href="http://www.example.com:8080/foo" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com:8080/foo</a></p>\n',
      );
    });

    it("links www.localhost and other single-label hosts", () => {
      const html = toSanitizedMarkdownHtml("Visit www.localhost:3000/path for dev");
      expect(html).toBe(
        '<p>Visit <a href="http://www.localhost:3000/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.localhost:3000/path</a> for dev</p>\n',
      );
    });

    it("links Unicode/IDN domains like www.münich.de", () => {
      const html1 = toSanitizedMarkdownHtml("Visit www.münich.de");
      expect(html1).toBe(
        '<p>Visit <a href="http://www.xn--mnich-kva.de" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.münich.de</a></p>\n',
      );

      const html2 = toSanitizedMarkdownHtml("Visit www.café.example");
      expect(html2).toBe(
        '<p>Visit <a href="http://www.xn--caf-dma.example" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.café.example</a></p>\n',
      );
    });

    it("links www.foo_bar.example.com with underscores", () => {
      const html = toSanitizedMarkdownHtml("Visit www.foo_bar.example.com");
      expect(html).toBe(
        '<p>Visit <a href="http://www.foo_bar.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.foo_bar.example.com</a></p>\n',
      );
    });

    it("strips trailing punctuation from links", () => {
      const html1 = toSanitizedMarkdownHtml("Check www.example.com/help.");
      expect(html1).toBe(
        '<p>Check <a href="http://www.example.com/help" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/help</a>.</p>\n',
      );

      const html2 = toSanitizedMarkdownHtml("See www.example.com!");
      expect(html2).toBe(
        '<p>See <a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a>!</p>\n',
      );
    });

    it("strips entity-like suffixes per GFM spec", () => {
      // &hl; looks like an entity reference, so strip it
      const html1 = toSanitizedMarkdownHtml("www.google.com/search?q=commonmark&hl;");
      expect(html1).toBe(
        '<p><a href="http://www.google.com/search?q=commonmark" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.google.com/search?q=commonmark</a>&amp;hl;</p>\n',
      );

      // &amp; is also entity-like
      const html2 = toSanitizedMarkdownHtml("www.example.com/path&amp;");
      expect(html2).toBe(
        '<p><a href="http://www.example.com/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path</a>&amp;</p>\n',
      );
    });

    it("handles quotes with balance checking", () => {
      // Quoted URL — trailing unbalanced " is stripped
      const html1 = toSanitizedMarkdownHtml('"www.example.com"');
      expect(html1).toBe(
        '<p>"<a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a>"</p>\n',
      );

      // Balanced quotes inside path — preserved
      const html2 = toSanitizedMarkdownHtml('www.example.com/path"with"quotes');
      expect(html2).toBe(
        '<p><a href="http://www.example.com/path%22with%22quotes" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path"with"quotes</a></p>\n',
      );

      // Trailing unbalanced " — stripped
      const html3 = toSanitizedMarkdownHtml('www.example.com/path"');
      expect(html3).toBe(
        '<p><a href="http://www.example.com/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path</a>"</p>\n',
      );
    });

    it("does NOT link www. domains starting with non-ASCII", () => {
      const html1 = toSanitizedMarkdownHtml("Visit www.ünich.de");
      expect(html1).toBe("<p>Visit www.ünich.de</p>\n");

      const html2 = toSanitizedMarkdownHtml("Visit www.ñoño.com");
      expect(html2).toBe("<p>Visit www.ñoño.com</p>\n");
    });

    it("handles balanced parentheses in URLs", () => {
      const html = toSanitizedMarkdownHtml("(see www.example.com/foo(bar))");
      expect(html).toBe(
        '<p>(see <a href="http://www.example.com/foo(bar)" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/foo(bar)</a>)</p>\n',
      );
    });

    it("stops at < character", () => {
      // Stops at < character
      const html1 = toSanitizedMarkdownHtml("Visit www.example.com/path<test");
      expect(html1).toBe(
        '<p>Visit <a href="http://www.example.com/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/path</a>&lt;test</p>\n',
      );

      // <tag> pattern — stops before <
      const html2 = toSanitizedMarkdownHtml("Visit www.example.com/<token> here");
      expect(html2).toBe(
        '<p>Visit <a href="http://www.example.com/" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com/</a>&lt;token&gt; here</p>\n',
      );
    });

    it("does NOT link bare domains without www", () => {
      const html = toSanitizedMarkdownHtml("Visit google.com today");
      expect(html).toBe("<p>Visit google.com today</p>\n");
    });

    it("does NOT link filenames with TLD-like extensions", () => {
      const html = toSanitizedMarkdownHtml("Check README.md and config.json");
      expect(html).toBe("<p>Check README.md and config.json</p>\n");
    });

    it("does NOT link IP addresses", () => {
      const html = toSanitizedMarkdownHtml("Check 127.0.0.1:8080");
      expect(html).toBe("<p>Check 127.0.0.1:8080</p>\n");
    });

    it("keeps adjacent trailing CJK text outside www auto-links", () => {
      const html = toSanitizedMarkdownHtml("www.example.com重新解读");
      expect(html).toBe(
        '<p><a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a>重新解读</p>\n',
      );
    });

    it("keeps Japanese text outside www auto-links", () => {
      const html = toSanitizedMarkdownHtml("www.example.comテスト");
      expect(html).toBe(
        '<p><a href="http://www.example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">www.example.com</a>テスト</p>\n',
      );
    });
  });

  describe("explicit protocol links", () => {
    it("links https:// URLs", () => {
      const html = toSanitizedMarkdownHtml("Visit https://example.com");
      expect(html).toBe(
        '<p>Visit <a href="https://example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">https://example.com</a></p>\n',
      );
    });

    it("links http:// URLs", () => {
      const html = toSanitizedMarkdownHtml("Visit http://github.com/openclaw");
      expect(html).toBe(
        '<p>Visit <a href="http://github.com/openclaw" class="markdown-bare-url markdown-github-link" title="http://github.com/openclaw" rel="noreferrer noopener" target="_blank">github.com/openclaw</a></p>\n',
      );
    });

    it("links email addresses", () => {
      const html = toSanitizedMarkdownHtml("Email me at test@example.com");
      expect(html).toBe(
        '<p>Email me at <a href="mailto:test@example.com" rel="noreferrer noopener" target="_blank">test@example.com</a></p>\n',
      );
    });

    it("keeps adjacent trailing CJK text outside https:// auto-links", () => {
      const html = toSanitizedMarkdownHtml("https://example.com重新解读");
      expect(html).toBe(
        '<p><a href="https://example.com" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">https://example.com</a>重新解读</p>\n',
      );
    });

    it("keeps CJK text outside https:// links with path", () => {
      const html = toSanitizedMarkdownHtml("https://example.com/path重新解读");
      expect(html).toBe(
        '<p><a href="https://example.com/path" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">https://example.com/path</a>重新解读</p>\n',
      );
    });

    it("preserves mid-URL CJK in https:// links", () => {
      // CJK in the middle of a URL path (not trailing) must not be trimmed
      const html = toSanitizedMarkdownHtml("https://example.com/你/test");
      expect(html).toBe(
        '<p><a href="https://example.com/%E4%BD%A0/test" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">https://example.com/你/test</a></p>\n',
      );
    });

    it("preserves percent-encoded CJK inside URLs when no raw CJK present", () => {
      // Percent-encoded paths without raw CJK are preserved as-is
      const html = toSanitizedMarkdownHtml("https://example.com/path/%E4%BD%A0%E5%A5%BD");
      expect(html).toBe(
        '<p><a href="https://example.com/path/" class="markdown-bare-url" rel="noreferrer noopener" target="_blank">https://example.com/path/</a>你好</p>\n',
      );
      // markdown-it linkify decodes percent-encoded CJK for display, then our
      // CJK trim rule splits at the first raw CJK char. This is acceptable
      // because raw percent-encoded CJK in chat is extremely rare.
    });

    it("does NOT rewrite explicit markdown links with CJK display text", () => {
      const html = toSanitizedMarkdownHtml("[OpenClaw中文](https://docs.openclaw.ai)");
      expect(html).toBe(
        '<p><a href="https://docs.openclaw.ai" rel="noreferrer noopener" target="_blank">OpenClaw中文</a></p>\n',
      );
    });

    it("preserves mailto: scheme when trimming CJK from email links", () => {
      // Email followed by space+CJK — linkify recognizes the email,
      // then CJK trim should preserve the mailto: prefix.
      const html = toSanitizedMarkdownHtml("Contact test@example.com 中文说明");
      expect(html).toBe(
        '<p>Contact <a href="mailto:test@example.com" rel="noreferrer noopener" target="_blank">test@example.com</a> 中文说明</p>\n',
      );
    });
  });

  describe("file links", () => {
    it("links multi-segment paths only when enabled", () => {
      const enabled = htmlFragment(
        toSanitizedMarkdownHtml("see src/lib/foo.ts for details", { fileLinks: true }),
      );
      const link = enabled.querySelector<HTMLAnchorElement>("a.markdown-file-link");
      expect(link?.dataset.filePath).toBe("src/lib/foo.ts");
      expect(link?.hasAttribute("href")).toBe(false);

      const disabled = htmlFragment(
        toSanitizedMarkdownHtml("see src/lib/foo.ts and src/lib/foo.ts:42 for details"),
      );
      expect(disabled.querySelector("a[data-file-path]")).toBeNull();
    });

    it.each([
      ["plain text", "see src/lib/foo.ts:42"],
      ["inline code", "`src/lib/foo.ts:42`"],
      ["explicit Markdown", "[source](src/lib/foo.ts:42)"],
    ])(
      "makes %s workspace file links keyboard-focusable without adding an href",
      (_kind, input) => {
        const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { fileLinks: true }));
        const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");

        expect(link?.getAttribute("role")).toBe("button");
        expect(link?.getAttribute("tabindex")).toBe("0");
        expect(link?.hasAttribute("href")).toBe(false);
        document.body.append(fragment);
        link?.focus();
        expect(document.activeElement).toBe(link);
        fragment.remove();
      },
    );

    it("links prefixed single-segment paths but not bare prose filenames", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("~/notes.md ./x.ts ../y.ts foo.ts", { fileLinks: true }),
      );
      expect(
        [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")].map(
          (link) => link.dataset.filePath,
        ),
      ).toEqual(["~/notes.md", "./x.ts", "../y.ts"]);
      expect(fragment.textContent).toContain("foo.ts");
    });

    it("keeps line suffixes on the label while storing the parsed line", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("src/lib/foo.ts:42 and bar.ts:7:3", { fileLinks: true }),
      );
      const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
      expect(links[0]?.dataset.filePath).toBe("src/lib/foo.ts");
      expect(links[0]?.dataset.fileLine).toBe("42");
      expect(links[0]?.textContent).toBe("foo.ts:42");
      expect(links[1]?.dataset.filePath).toBe("bar.ts");
      expect(links[1]?.dataset.fileLine).toBe("7");
      expect(links[1]?.textContent).toBe("bar.ts:7:3");
    });

    it("links Windows absolute paths", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("C:/repo/src/foo.ts:42 and `D:\\work\\bar.ts`", {
          fileLinks: true,
        }),
      );
      const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
      expect(links.map((link) => link.dataset.filePath)).toEqual([
        "C:/repo/src/foo.ts",
        "D:\\work\\bar.ts",
      ]);
      expect(links[0]?.dataset.fileLine).toBe("42");
    });

    it("links inline-code paths and conservative bare filenames", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("`src/lib/foo.ts` `navigation.ts` `foo.bar()` `notes.xyz123`", {
          fileLinks: true,
        }),
      );
      expect(
        [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")].map(
          (link) => link.dataset.filePath,
        ),
      ).toEqual(["src/lib/foo.ts", "navigation.ts"]);
      expect(fragment.textContent).toContain("foo.bar()");
      expect(fragment.textContent).toContain("notes.xyz123");
    });

    it("converts explicit relative and absolute local file links", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("[foo.ts](src/utils/foo.ts:42) [x](/Users/a/b.ts)", {
          fileLinks: true,
        }),
      );
      const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
      expect(links).toHaveLength(2);
      expect(links[0]?.dataset).toMatchObject({
        filePath: "src/utils/foo.ts",
        fileLine: "42",
      });
      expect(links[1]?.dataset.filePath).toBe("/Users/a/b.ts");
      expect(links.every((link) => !link.hasAttribute("href"))).toBe(true);

      const disabled = htmlFragment(toSanitizedMarkdownHtml("[x](/Users/a/b.ts)"));
      expect(disabled.querySelector("a")?.hasAttribute("href")).toBe(false);
      expect(disabled.querySelector("a")?.hasAttribute("data-file-path")).toBe(false);
    });

    it("leaves http links as normal links", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("https://example.com/a/b.ts", { fileLinks: true }),
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.href).toBe("https://example.com/a/b.ts");
      expect(link?.hasAttribute("data-file-path")).toBe(false);
    });

    it("does not link paths inside fenced code blocks", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("```ts\nsrc/lib/foo.ts:42\n```", { fileLinks: true }),
      );
      expect(fragment.querySelector("a[data-file-path]")).toBeNull();
      expect(fragment.querySelector("code")?.textContent).toContain("src/lib/foo.ts:42");
    });

    it("guards common prose false positives", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("Node.js, e.g. version 1.2.3", { fileLinks: true }),
      );
      expect(fragment.querySelector("a[data-file-path]")).toBeNull();
    });

    it("labels a file link with its basename and keeps the path addressable", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("see src/components/Button.tsx for details", { fileLinks: true }),
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
      expect(link?.textContent).toBe("Button.tsx");
      expect(link?.dataset.filePath).toBe("src/components/Button.tsx");
      expect(link?.getAttribute("title")).toBe("src/components/Button.tsx");
    });

    it("adds no tooltip when the label is already the whole reference", () => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml("`README.md`", { fileLinks: true }));
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
      expect(link?.textContent).toBe("README.md");
      expect(link?.hasAttribute("title")).toBe(false);
    });

    it("adds no tooltip when an explicit label already repeats the reference", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("[src/lib/foo.ts](src/lib/foo.ts) and [go](src/lib/bar.ts)", {
          fileLinks: true,
        }),
      );
      const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
      expect(links.map((link) => link.getAttribute("title"))).toEqual([null, "src/lib/bar.ts"]);
    });

    it("shortens inline-code paths and keeps author labels on explicit links", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("`src/lib/foo.ts` and [the button](src/ui/Button.tsx:12)", {
          fileLinks: true,
        }),
      );
      const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
      expect(links.map((link) => link.textContent)).toEqual(["foo.ts", "the button"]);
      expect(links.map((link) => link.getAttribute("title"))).toEqual([
        "src/lib/foo.ts",
        "src/ui/Button.tsx:12",
      ]);
    });

    it("grows the label only far enough to tell equal basenames apart", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("ui/src/app.ts and api/src/app.ts and `D:\\work\\app.ts`", {
          fileLinks: true,
        }),
      );
      const links = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")];
      // The Windows path is unique one segment up, so it stops there while the
      // other two grow to three — and it keeps its own separator.
      expect(links.map((link) => link.textContent)).toEqual([
        "ui/src/app.ts",
        "api/src/app.ts",
        "work\\app.ts",
      ]);
    });

    it("keeps labels correct and distinct across thousands of paths", () => {
      // A model-controlled message can reference thousands of distinct files.
      // The regression this guards against is quadratic label derivation, so
      // this pairs an all-unique-basename set (no repeated suffix growth)
      // with a colliding-basename set (forced suffix growth) at the same
      // cardinality; both must resolve correctly, not just quickly.
      const distinctPaths = Array.from(
        { length: 4000 },
        (_, i) => `src/pkg${i % 50}/mod${i}/file${i}.ts`,
      );
      const distinctLabels = shortestFileLabels(distinctPaths);
      expect(distinctLabels.size).toBe(distinctPaths.length);
      for (const path of distinctPaths) {
        expect(distinctLabels.get(path)).toBe(path.slice(path.lastIndexOf("/") + 1));
      }

      const collidingPaths = Array.from({ length: 4000 }, (_, i) => `pkg${i}/shared/index.ts`);
      const collidingLabels = shortestFileLabels(collidingPaths);
      expect(collidingLabels.size).toBe(collidingPaths.length);
      expect(new Set(collidingLabels.values()).size).toBe(collidingPaths.length);
      for (const path of collidingPaths) {
        expect(collidingLabels.get(path)).toBe(path);
      }
    });

    it("keeps per-path lookup cost linear as path count grows (performance contract)", () => {
      // Wall-clock timing flakes under CI load, so this asserts the actual
      // performance contract structurally: count every Map#get call made while
      // shortestFileLabels runs. The trie makes a fixed number of child
      // lookups per path segment (one per segment on insert, one per resolved
      // suffix depth on lookup), so total lookups scale with path count, not
      // its square. The pre-fix full-list rescan (#124230) re-read every other
      // path's segments inside `unique.some(...)` at every depth, which cost
      // O(n^2) lookups for this same all-unique-basename shape -- 8x the paths
      // there costs ~64x the lookups, far outside the linear band asserted
      // below, so a regression back to that scan fails this test every run.
      const countMapLookups = (pathCount: number): number => {
        const paths = Array.from(
          { length: pathCount },
          (_, i) => `src/pkg${i % 50}/mod${i}/file${i}.ts`,
        );
        const getSpy = vi.spyOn(Map.prototype, "get");
        try {
          shortestFileLabels(paths);
          return getSpy.mock.calls.length;
        } finally {
          getSpy.mockRestore();
        }
      };

      const small = countMapLookups(500);
      const large = countMapLookups(4000); // 8x the paths

      expect(large).toBeGreaterThan(small * 4);
      expect(large).toBeLessThan(small * 16);
    });

    it.each([
      ["README.md", "markdown"],
      ["package.json", "package"],
      ["src/components/Button.tsx", "component"],
      ["src/index.ts", "code"],
      ["config/app.yaml", "data"],
      ["scripts/run.sh", "shell"],
      ["docs/logo.png", "image"],
      ["notes/todo.txt", "file"],
      // Inline code so bare filenames link too: the prose scan deliberately
      // ignores them unless they carry a directory or a line suffix.
    ])("classifies %s as the %s glyph kind", (path, kind) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(`\`${path}\``, { fileLinks: true }));
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-file-link");
      expect(link?.dataset.filePath).toBe(path);
      expect(link?.dataset.fileKind).toBe(kind);
    });

    it.each([
      ["spaces", "see docs/my notes.md today"],
      ["parentheses", "see src/lib/foo(1).ts today"],
      ["a fragment", "see README.md#install today"],
      ["a query", "see config.json?raw=1 today"],
    ])("never pulls %s into a file path, and leaves the prose intact", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { fileLinks: true }));
      for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-file-link")) {
        expect(link.dataset.filePath).not.toMatch(/[\s()?]/);
      }
      expect(fragment.textContent).toContain(input);
    });
  });

  describe("session links", () => {
    const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";

    it("links structural keys only when enabled", () => {
      const disabled = htmlFragment(toSanitizedMarkdownHtml(`Open ${sessionKey}`));
      expect(disabled.querySelector("a[data-session-key]")).toBeNull();

      const enabled = htmlFragment(
        toSanitizedMarkdownHtml(`Open ${sessionKey}`, { sessionLinks: true }),
      );
      const link = enabled.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(link?.dataset.sessionKey).toBe(sessionKey);
      expect(link?.textContent).toBe(sessionKey);
      expect(link?.getAttribute("role")).toBe("link");
      expect(link?.getAttribute("tabindex")).toBe("0");
      expect(link?.hasAttribute("href")).toBe(false);
    });

    it.each([
      ["plain text", `Open ${sessionKey}`],
      ["inline code", `Open \`${sessionKey}\``],
    ])("linkifies keys in %s", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { sessionLinks: true }));
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      expect(link?.dataset.sessionKey).toBe(sessionKey);
      expect(link?.textContent).toBe(sessionKey);
    });

    it.each([
      ["an empty prefix", "agent:"],
      ["a missing rest segment", "agent:x"],
      ["an empty middle segment", "agent:x::y"],
      ["a URL query value", `https://example.test/?session=${sessionKey}`],
      ["a fenced code block", `\`\`\`text\n${sessionKey}\n\`\`\``],
    ])("does not link %s", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input, { sessionLinks: true }));
      expect(fragment.querySelector("a[data-session-key]")).toBeNull();
    });

    it("keeps punctuation outside the link and rejects embedded word matches", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(`(${sessionKey}), x${sessionKey}`, { sessionLinks: true }),
      );
      const links = fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-session-link");
      expect(links).toHaveLength(1);
      expect(links[0]?.textContent).toBe(sessionKey);
      expect(fragment.textContent).toBe(`(${sessionKey}), x${sessionKey}\n`);
    });

    it("stays deterministic across streaming tail renders", () => {
      const options = { sessionLinks: true } as const;
      const first = htmlFragment(toStreamingMarkdownHtml(`Open ${sessionKey}`, options));
      const extended = htmlFragment(
        toStreamingMarkdownHtml(`Open ${sessionKey} and continue`, options),
      );
      expect(first.querySelector<HTMLAnchorElement>("a")?.dataset.sessionKey).toBe(sessionKey);
      expect(extended.querySelector<HTMLAnchorElement>("a")?.dataset.sessionKey).toBe(sessionKey);
    });
  });

  describe("bare url links", () => {
    it("marks autolinked URL text but not authored labels", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "https://example.com/a/very/long/path and [a label](https://example.com/a/very/long/path) and www.example.com",
        ),
      );
      expect(
        [...fragment.querySelectorAll("a")].map((link) =>
          link.classList.contains("markdown-bare-url"),
        ),
      ).toEqual([true, false, true]);
    });

    it("leaves email autolinks unmarked", () => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml("Email me at test@example.com"));
      expect(fragment.querySelector("a.markdown-bare-url")).toBeNull();
    });
  });

  describe("github link marks", () => {
    it.each([
      ["bare pull request", "https://github.com/openclaw/openclaw/pull/3434", "#3434"],
      ["bare issue", "https://github.com/openclaw/openclaw/issues/3435", "#3435"],
      ["repository", "https://github.com/openclaw/openclaw", "openclaw/openclaw"],
      ["repository file", "https://github.com/blader/humanizer/blob/main/SKILL.md", "SKILL.md"],
      [
        "other path",
        "https://github.com/openclaw/openclaw/actions/runs/123",
        "github.com/actions/runs/123",
      ],
      ["issue shorthand", "[#3434](https://github.com/openclaw/openclaw/pull/3434)", "#3434"],
      ["labelled link", "[the fix](https://github.com/openclaw/openclaw/pull/3434)", "the fix"],
      ["www host", "[the fix](https://www.github.com/openclaw/openclaw/pull/3434)", "the fix"],
      ["http scheme", "[the fix](http://github.com/openclaw/openclaw/pull/3434)", "the fix"],
      ["list item", "- [the fix](https://github.com/openclaw/openclaw/pull/3434)", "the fix"],
    ])("marks %s", (_kind, input, expectedText) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input));
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.classList.contains("markdown-github-link")).toBe(true);
      expect(link?.textContent).toBe(expectedText);
    });

    it("keeps long generated item references breakable after compaction", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "https://github.com/a-very-long-organization-name/a-very-long-repository-name/issues/3434",
        ),
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.textContent).toBe("#3434");
      expect(link?.classList.contains("markdown-bare-url")).toBe(true);
    });

    it("keeps the specific destination addressable after shortening its label", () => {
      const input = "https://github.com/blader/humanizer/blob/main/SKILL.md";
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input));
      const link = fragment.querySelector<HTMLAnchorElement>("a");
      expect(link?.classList.contains("markdown-github-link")).toBe(true);
      expect(link?.textContent).toBe("SKILL.md");
      expect(link?.getAttribute("href")).toBe(input);
      expect(link?.getAttribute("title")).toBe(input);
    });

    it.each([
      ["non-github host", "[docs](https://example.com/openclaw)"],
      ["lookalike host", "[docs](https://notgithub.com/openclaw)"],
      ["github in query", "[docs](https://example.com/?to=https://github.com/openclaw)"],
      ["subdomain host", "[pages](https://openclaw.github.io/openclaw)"],
      ["image-only link", "[![build](data:image/png;base64,x)](https://github.com/openclaw)"],
    ])("leaves %s unmarked", (_kind, input) => {
      const fragment = htmlFragment(toSanitizedMarkdownHtml(input));
      expect(fragment.querySelector("a.markdown-github-link")).toBeNull();
    });

    it("leaves github urls inside code untouched", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(
          "`https://github.com/openclaw/openclaw`\n\n```\nhttps://github.com/openclaw/openclaw\n```",
        ),
      );
      expect(fragment.querySelector("a")).toBeNull();
      expect(fragment.querySelector(".markdown-github-link")).toBeNull();
    });

    it("keeps the hover preview target intact on marked links", () => {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml("[#3434](https://github.com/openclaw/openclaw/pull/3434)"),
      );
      const link = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-link");
      expect(link?.getAttribute("href")).toBe("https://github.com/openclaw/openclaw/pull/3434");
      expect(link?.getAttribute("target")).toBe("_blank");
    });
  });
});
