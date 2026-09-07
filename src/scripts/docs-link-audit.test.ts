// Docs link audit tests cover documentation link validation behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDocsMarkdown, parseDocsDocument } from "../../scripts/lib/docs-markdown.mjs";
import { normalizeRoute } from "../../scripts/lib/docs-published-routes.mts";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const { prepareExternalLinkAuditTree, prepareMirroredDocsDir, resolveRoute } =
  await import("../../scripts/docs-link-audit.mts");

type AuditCliCase = {
  name: string;
  source: string[];
  broken: number;
  anchors?: boolean;
  diagnostics?: string[];
  files?: Record<string, string>;
  redirects?: Array<{ source: string; destination: string }>;
};

describe("docs-link-audit", () => {
  function tempEntries(prefix: string): Set<string> {
    return new Set(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix)));
  }

  it.each(["\n", "\r\n"])("preserves code literals with line ending %j", (newline) => {
    const source = [
      "Intro",
      "",
      "```md",
      '<Card href="/same" title="Literal" />',
      "```",
      "",
      "[live](/same)",
    ].join(newline);
    const md = createDocsMarkdown();
    const document = parseDocsDocument(source, md, {
      mapLink: (href: string, line: number | undefined) => ({ href, line }),
    });
    expect(document.links).toEqual([{ href: "/same", line: 7 }]);
    expect(md.renderer.render(document.tokens, md.options, document.env)).toContain(
      "&lt;Card href=&quot;/same&quot; title=&quot;Literal&quot; /&gt;",
    );
  });

  it.each([
    {
      name: "published possessive links",
      source: "## Request today's summary\n\n## The vendor's harness, as a plugin",
      headings: [
        ["request-today's-summary", "request-todays-summary"],
        ["the-vendor's-harness%2C-as-a-plugin", "the-vendors-harness-as-a-plugin"],
      ],
      collisions: [],
    },
    {
      name: "normalized duplicates and numbered suffixes before alias reservation",
      source: "## A-s\n\n## As\n\n## A-s\n\n## A-s-2\n\n## A-s",
      headings: [
        ["a-s", null],
        ["as", "as-2"],
        ["a-s-1", "as-3"],
        ["a-s-2", "as-2-1"],
        ["a-s-3", "as-4"],
      ],
      collisions: [{ id: "as", reason: "compatibility alias collision" }],
    },
    {
      name: "percent bytes, underscores and numbered title prefixes",
      source:
        "## café 中文 _Über\n\n## café 中文 _Über\n\n## 1. Today\n\n## 1. Today\n\n## 100% ready",
      headings: [
        ["caf%C3%A9-%E4%B8%AD%E6%96%87-_%C3%BCber", "café-中文-_über"],
        ["caf%C3%A9-%E4%B8%AD%E6%96%87-_%C3%BCber-1", "café-中文-_über-2"],
        ["1.-today", "1-today"],
        ["1.-today-1", "1-today-2"],
        ["100%25-ready", "100%-ready"],
      ],
      collisions: [],
    },
  ])("preserves Mint heading targets for $name", ({ source, headings, collisions }) => {
    const document = parseDocsDocument(source);
    expect(
      document.tokens
        .filter((token) => token.type === "heading_open")
        .map((token) => [token.attrGet("id"), token.meta?.anchorAlias ?? null]),
    ).toEqual(headings);
    expect(document.collisions).toEqual(collisions);
    expect(new Set(document.ids).size).toBe(document.ids.length);
  });

  it.each([
    {
      name: "shared heading/Step TOC with an independent Tab counter",
      source: [
        "## Today's summary",
        '<Steps titleSize="h2">',
        '<Step title="Today\'s summary">one</Step>',
        '<Step title="Today\'s summary">two</Step>',
        "</Steps>",
        "<Tabs>",
        '<Tab title="Today\'s summary">one</Tab>',
        '<Tab title="Todays summary">two</Tab>',
        '<Tab title="Today\'s summary">three</Tab>',
        "</Tabs>",
        '<Accordion title="A-s">one</Accordion>',
        '<Accordion title="As">two</Accordion>',
        '<ParamField body="a-s">one</ParamField>',
        '<ResponseField name="as">two</ResponseField>',
      ],
      ids: [
        "today's-summary",
        "todays-summary",
        "todays-summary-2",
        "todays-summary-3",
        "todays-summary-1",
        "todays-summary-2-1",
        "todays-summary-3-1",
        "as",
        "as-1",
        "param-as",
        "param-as-1",
      ],
      collisions: [],
    },
    {
      name: "authored IDs reserved before heading aliases and component IDs",
      source: [
        "## Today's summary",
        '<a id="todays-summary"></a>',
        '<Tab title="A-s">one</Tab>',
        '<Tab id="as" title="Explicit">two</Tab>',
        '<Accordion title="A-s">three</Accordion>',
        '<ParamField body="a-s">four</ParamField>',
        '<a id="param-as"></a>',
      ],
      ids: ["today's-summary", "todays-summary", "as", "param-as", "as-1", "as-2", "param-as-1"],
      collisions: [{ id: "todays-summary", reason: "compatibility alias collision" }],
    },
    {
      name: "raw component apostrophes normalized after separators",
      source: [
        '<Accordion title="A-s\'s guide">one</Accordion>',
        '<ParamField body="a-s\'sGuide">two</ParamField>',
      ],
      ids: ["as-s-guide", "param-as-s-guide"],
      collisions: [],
    },
  ])("preserves Mint component targets for $name", ({ source, ids, collisions }) => {
    const document = parseDocsDocument(source.join("\n\n"));
    expect(document.ids).toEqual(ids);
    expect(document.collisions).toEqual(collisions);
    expect(new Set(document.ids).size).toBe(document.ids.length);
  });

  it.each<AuditCliCase>([
    {
      name: "component and list fences",
      source: [
        "<Accordion>",
        "    ~~~md",
        "    [example](/hidden-tilde)",
        "    ~~~not-a-closing-fence",
        "    [example](/hidden-after-false-close)",
        "    ~~~",
        "</Accordion>",
        "",
        "- Example",
        "",
        "    ````md",
        "    ```text",
        "    [example](/hidden-nested)",
        "    ```",
        "    ````",
        "",
        "[real](/missing-page)",
        "[valid](/page)",
      ],
      broken: 1,
    },
    {
      name: "legacy malformed MDX",
      source: [
        "<!doctype html>",
        "~~~md",
        "[example](/hidden-fallback)",
        "~~~",
        "[real](/missing-page)",
        "[valid](/page)",
      ],
      broken: 1,
    },
    {
      name: "indented component prose",
      source: ["<Accordion>", "    [real](/missing-page)", "</Accordion>", "[valid](/page)"],
      broken: 1,
    },
    { name: "valid prose", source: ["[valid](/page)"], broken: 0 },
    {
      name: "repeated occurrences beside protected literals",
      source: [
        "---",
        "title: Positions",
        "---",
        "```md",
        "[hidden](/missing-page)",
        "```",
        "[first](/missing-page)",
        "[second](/missing-page)",
        "",
        "`[hidden](/missing-page)` [third](/missing-page)",
        "[valid](/page)",
      ],
      broken: 3,
      diagnostics: [7, 8, 10].map(
        (line) => `page.mdx:${line} :: /missing-page :: route/file not found`,
      ),
    },
    {
      name: "reference, HTML, component and normalized relative occurrences",
      source: [
        "[reference][missing]",
        "",
        "[missing]: /missing-page",
        "",
        '<a href="/missing-page">HTML</a>',
        "",
        '<Card href="/missing-page" title="Component" />',
        "",
        "[relative](./missing-page.md)",
        "[valid](/page)",
      ],
      broken: 4,
      diagnostics: [1, 5, 7, 9].map(
        (line) => `page.mdx:${line} :: /missing-page :: route/file not found`,
      ),
    },
    {
      name: "unmapped expansions",
      source: [
        '<Snippet file="./part.txt" />',
        "",
        '<div class="maturity-category-docs">',
        "[embedded](/missing-page)",
        "</div>",
        "",
        "[valid](/page)",
      ],
      files: { "docs/part.txt": "[included](/missing-page)\n" },
      broken: 2,
      diagnostics: ["page.mdx:unknown :: /missing-page :: route/file not found"],
    },
    {
      name: "decoded direct paths and HTML-alias targets",
      anchors: true,
      source: [
        "[direct](/caf%C3%A9#known)",
        "[literal percent](/100%25#known)",
        "[asset](/image%20space.svg)",
        "[redirect](/via)",
        "[bad redirect](/invalid)",
        "[raw Markdown redirect](/raw)",
        "[after](/missing-page)",
        "[external](/outside)",
      ],
      files: {
        "docs/café.md": "## Known\n",
        "docs/100%.md": "## Known\n",
        "docs/image space.svg": "<svg />",
      },
      redirects: [
        { source: "/via", destination: "https://docs.openclaw.ai/caf%C3%A9#known" },
        { source: "/invalid", destination: "https://docs.openclaw.ai/bad%" },
        { source: "/raw", destination: "/café.md#known" },
        { source: "/outside", destination: "https://example.test/page#external-section" },
      ],
      broken: 4,
      diagnostics: [
        "docs.json:unknown :: /invalid :: malformed URL path",
        "page.mdx:5 :: /invalid :: malformed URL path",
        "page.mdx:6 :: /raw :: fragment requires an HTML page, not raw Markdown",
        "page.mdx:7 :: /missing-page :: route/file not found",
      ],
    },
    ...[false, true].map((anchors) => ({
      name: `malformed emitted paths (anchors=${anchors})`,
      anchors,
      source: [
        '<Card href="/bad%" title="Component" />',
        "",
        '<a href="/bad%FF">HTML</a>',
        "",
        '<img src="/bad%2" />',
        "",
        '<CTA primaryHref="/bad%zz" secondaryHref="https://docs.openclaw.ai/bad%" />',
        "",
        "[markdown](/bad%FF)",
        "[reference][bad]",
        "",
        "[bad]: /bad%FF",
        "",
        "[after](/missing-page)",
        "[valid](/page)",
      ],
      broken: anchors ? 8 : 7,
      diagnostics: [
        ":: /bad% :: malformed URL path",
        ":: /bad%FF :: malformed URL path",
        ":: /missing-page :: route/file not found",
      ],
    })),
    {
      name: "shared emitted fragments",
      anchors: true,
      broken: 4,
      source: [
        "## agents.defaults.cwd",
        "",
        '<Accordion title="Connect" id="connection">',
        "",
        "## Nested",
        "",
        "</Accordion>",
        "",
        "[legacy](#agents-defaults-cwd)",
        "[canonical](#agents.defaults.cwd)",
        "[component](#connection)",
        "[nested](https://docs.openclaw.ai/page#nested)",
        "[absent](#missing)",
        "[relative](./page.mdx#connection)",
        "[raw Markdown](/page.md#connection)",
        "[root](/#root)",
        "[missing root alias](/index#missing)",
        "[unpublished permalink](/unpublished#connection)",
        "[dropped incoming fragment](/drops#missing)",
        "[redirect](/legacy#wrong-incoming-fragment)",
        "[chain](/middle#also-wrong)",
        "[reference][ref]",
        "",
        "[ref]: /page#connection",
        "",
        "```md",
        "## Phantom",
        "[hidden](/hidden-code)",
        "```",
        '<!-- <a id="phantom" href="/hidden-comment"> -->',
      ],
    },
  ])(
    "audits real CLI links after $name",
    ({ source, broken, anchors = false, diagnostics, files = {}, redirects }) => {
      const tempDirs: string[] = [];
      const fixtureRoot = makeTempDir(tempDirs, "docs-link-audit-cli-");
      const docsRoot = path.join(fixtureRoot, "docs");
      const clawHubRoot = path.join(fixtureRoot, "clawhub");
      const home = path.join(fixtureRoot, "home");
      fs.mkdirSync(docsRoot);
      fs.mkdirSync(path.join(clawHubRoot, "docs"), { recursive: true });
      fs.mkdirSync(home);
      fs.writeFileSync(
        path.join(docsRoot, "docs.json"),
        JSON.stringify({
          navigation: [],
          redirects:
            redirects ??
            (anchors && !diagnostics
              ? [
                  { source: "/legacy", destination: "/page#connection" },
                  { source: "/middle", destination: "/legacy#nested" },
                  { source: "/drops", destination: "/next" },
                ]
              : []),
        }),
      );
      for (const [file, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(fixtureRoot, file), content);
      }
      if (anchors) {
        fs.writeFileSync(path.join(docsRoot, "index.md"), "## Root\n\n[next](next#target)\n");
        fs.writeFileSync(path.join(docsRoot, "next.md"), "## Target\n");
      }
      const pageSource =
        anchors && !diagnostics ? ["---", "permalink: /unpublished", "---", ...source] : source;
      fs.writeFileSync(path.join(docsRoot, "page.mdx"), `${pageSource.join("\n")}\n`);

      try {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL("../../scripts/docs-link-audit.mjs", import.meta.url)),
            ...(anchors ? ["--anchors"] : []),
          ],
          {
            cwd: fixtureRoot,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              HOME: home,
              USERPROFILE: home,
              TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
              OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: clawHubRoot,
            },
            timeout: 30_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(broken ? 1 : 0);
        if (!anchors) {
          expect(result.stdout).toContain(`checked_internal_links=${broken + 1}\n`);
        }
        expect(result.stdout).toContain(`broken_links=${broken}\n`);
        expect(result.stdout).not.toContain("/hidden-");
        if (anchors && !diagnostics) {
          expect(result.stdout).toContain("#missing :: fragment not found");
          expect(result.stdout).toContain("/unpublished#connection :: route/file not found");
        }
        for (const diagnostic of diagnostics ?? []) {
          expect(result.stdout).toContain(diagnostic);
        }
        if (broken && !anchors && !diagnostics) {
          expect(result.stdout).toContain(
            `page.mdx:${source.findIndex((line) => line.includes("/missing-page")) + 1} :: /missing-page :: route/file not found`,
          );
        }
      } finally {
        cleanupTempDirs(tempDirs);
      }
    },
  );

  it("normalizes route fragments away", () => {
    expect(normalizeRoute("/plugins/building-plugins#registering-agent-tools")).toBe(
      "/plugins/building-plugins",
    );
    expect(normalizeRoute("/plugins/building-plugins?tab=all")).toBe("/plugins/building-plugins");
  });

  it("prepares every external-link input without exposing code literals", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-external-link-audit-");
    const docsRoot = path.join(fixtureRoot, "docs");
    const source = [
      "<AccordionGroup>",
      '  <Accordion title="Reasoning">',
      "    [reasoning](https://docs.example.test/reasoning)",
      "    `https://api.example.test/v1`",
      "    ````markdown",
      "    ```text",
      "    <CODE_PLACEHOLDER>",
      "    ```",
      "    ~~~",
      "    [code literal](https://code.example.test)",
      "    ~~~",
      "    ````",
      "    - ```html",
      '      <script src="https://code.example.test/list-fence">',
      "      ```",
      "      [after list fence](https://docs.example.test/after-list-fence)",
      "    ```text",
      "    - ```",
      "    <Accordion>",
      "    [fenced component](https://code.example.test/fenced-component)",
      "    ```",
      "    [after literal list fence](https://docs.example.test/after-literal-list-fence)",
      "  </Accordion>",
      "</AccordionGroup>",
      "<Link>",
      "    [component link](https://docs.example.test/component)",
      "</Link>",
      "<Pre>",
      "    [pre component](https://docs.example.test/pre-component)",
      "</Pre>",
      "[after code block](https://docs.example.test/after-code-block)",
      "[after indented code](https://docs.example.test/after-indented-code)",
      "[after script](https://docs.example.test/after-script)",
      "[after void](https://docs.example.test/after-void)",
      "[reference][shared]",
      "",
      "[shared]: https://docs.example.test/reference-first?one=1&two=2",
      "[shared]: https://docs.example.test/reference-second",
      "![image](https://docs.example.test/image.png?one=1&two=2)",
      "`<PROVIDER>_API_KEY=...`",
      "",
    ].join("\n");
    fs.mkdirSync(path.join(docsRoot, "providers"), { recursive: true });
    fs.writeFileSync(path.join(docsRoot, "providers", "example.md"), source, "utf8");
    for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
      fs.writeFileSync(
        path.join(fixtureRoot, filename),
        `<div>\n  [${filename}](https://root.test)\n</div>\n`,
      );
    }

    try {
      const outputRoot = path.join(fixtureRoot, ".audit");
      expect(prepareExternalLinkAuditTree(fixtureRoot, outputRoot)).toEqual({
        files: 4,
        projectedLinks: 14,
      });
      const prepared = fs.readFileSync(
        path.join(outputRoot, "docs", "providers", "example.md"),
        "utf8",
      );
      const preparedLines = prepared.split("\n");
      expect(preparedLines).toHaveLength(source.split("\n").length);
      expect(preparedLines[2]).toContain('href="https://docs.example.test/reasoning"');
      for (const url of [
        "https://docs.example.test/after-list-fence",
        "https://docs.example.test/after-literal-list-fence",
        "https://docs.example.test/component",
        "https://docs.example.test/pre-component",
        "https://docs.example.test/after-code-block",
        "https://docs.example.test/after-indented-code",
        "https://docs.example.test/after-script",
        "https://docs.example.test/after-void",
      ]) {
        expect(prepared).toContain(`href="${url}"`);
      }
      expect(prepared).toContain(
        'href="https://docs.example.test/reference-first?one=1&amp;two=2"',
      );
      expect(prepared).toContain('href="https://docs.example.test/image.png?one=1&amp;two=2"');
      for (const url of [
        "https://api.example.test/v1",
        "https://code.example.test",
        "https://code.example.test/inline",
        "https://code.example.test/list-fence",
        "https://code.example.test/fenced-component",
        "https://code.example.test/unclosed",
        "https://code.example.test/still-hidden",
        "https://code.example.test/pre",
        "https://code.example.test/script",
        "https://code.example.test/script-body",
        "https://docs.example.test/reference-second",
      ]) {
        expect(prepared).not.toContain(url);
      }
      for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
        expect(fs.readFileSync(path.join(outputRoot, filename), "utf8")).toContain(
          'href="https://root.test"',
        );
      }
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("falls back to tolerant parsing for legacy malformed MDX", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-external-link-fallback-");
    fs.mkdirSync(path.join(fixtureRoot, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, "docs", "legacy.md"),
      "<!doctype html>\n<pre>\n[hidden](https://hidden.example.test)\n</pre>\n<Note>\ntext <code>[inline hidden](https://same.example.test)</code> [inline real](https://same.example.test)\n[legacy](https://legacy.example.test)\n</Note>\n<Pre>\n[component](https://component.example.test)\n</Pre>\n[reference][legacy-ref]\n\n[legacy-ref]: https://reference.example.test\n<style><code>[style hidden](https://style.example.test)</code></style> [style real](https://style.example.test)\n```html\n<code>\n[fenced hidden](https://fenced-hidden.example.test)\n```\n<Note>\n[after fence](https://after-fence.example.test)\n</Note>\n",
    );
    for (const filename of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
      fs.writeFileSync(path.join(fixtureRoot, filename), "");
    }

    try {
      const outputRoot = path.join(fixtureRoot, ".audit");
      expect(prepareExternalLinkAuditTree(fixtureRoot, outputRoot)).toEqual({
        files: 4,
        projectedLinks: 6,
      });
      const prepared = fs
        .readFileSync(path.join(outputRoot, "docs", "legacy.md"), "utf8")
        .split("\n");
      expect(prepared[6]).toContain('href="https://legacy.example.test"');
      expect(prepared[5]?.match(/https:\/\/same\.example\.test/g)).toHaveLength(1);
      expect(prepared[9]).toContain('href="https://component.example.test"');
      expect(prepared[11]).toContain('href="https://reference.example.test"');
      expect(prepared[14]?.match(/https:\/\/style\.example\.test/g)).toHaveLength(1);
      expect(prepared[20]).toContain('href="https://after-fence.example.test"');
      expect(prepared.join("\n")).not.toContain("https://hidden.example.test");
      expect(prepared.join("\n")).not.toContain("https://fenced-hidden.example.test");
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("resolves redirects that land on anchored sections", () => {
    const redirects = new Map([
      ["/plugins/agent-tools", "/plugins/building-plugins#registering-agent-tools"],
    ]);
    const routes = new Set(["/plugins/building-plugins"]);

    expect(resolveRoute("/plugins/agent-tools", { redirects, routes })).toEqual({
      ok: true,
      terminal: "/plugins/building-plugins",
    });
  });

  it("does not create mirrored docs copies for non-root docs trees", () => {
    const tempDirs: string[] = [];
    const fixtureRoot = makeTempDir(tempDirs, "docs-link-audit-mirror-");
    const docsRoot = path.join(fixtureRoot, "docs");
    fs.mkdirSync(docsRoot, { recursive: true });

    const before = tempEntries("openclaw-docs-link-audit-");
    try {
      const mirroredDocsDir = prepareMirroredDocsDir(docsRoot);
      expect(mirroredDocsDir).toEqual({
        cleanup: expect.any(Function),
        dir: path.resolve(docsRoot),
        mirroredClawHub: false,
      });
      mirroredDocsDir.cleanup();
      const after = tempEntries("openclaw-docs-link-audit-");
      expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
    } finally {
      cleanupTempDirs(tempDirs);
    }
  });

  it("cleans mirrored docs copies when ClawHub sync fails", () => {
    const before = tempEntries("openclaw-docs-link-audit-");

    expect(() =>
      prepareMirroredDocsDir(undefined, {
        resolveClawHubRepoPathImpl() {
          return path.join(os.tmpdir(), "clawhub-docs");
        },
        syncClawHubDocsTreeImpl() {
          throw new Error("sync failed");
        },
      }),
    ).toThrow("sync failed");

    const after = tempEntries("openclaw-docs-link-audit-");
    expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
  });
});
