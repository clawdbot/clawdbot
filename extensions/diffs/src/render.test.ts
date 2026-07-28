// Diffs tests cover render plugin behavior.
import { disposeHighlighter } from "@pierre/diffs";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDiffImageRenderOptions, resolveDiffsPluginDefaults } from "./config.js";
import { renderDiffDocument } from "./render.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);

describe("renderDiffDocument", () => {
  afterEach(async () => {
    await disposeHighlighter();
  });

  it("renders before/after input into a complete viewer document", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "const value = 1;\n",
        after: "const value = 2;\n",
        path: "src/example.ts",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
    );

    expect(rendered.title).toBe("src/example.ts");
    expect(rendered.fileCount).toBe(1);
    expect(rendered.viewerRuntime).toBe("base");
    expect(rendered.html).toContain("data-openclaw-diff-root");
    expect(rendered.html).toContain("src/example.ts");
    expect(rendered.html).toContain("../../assets/viewer.js");
    expect(rendered.imageHtml).toContain("../../assets/viewer.js");
    expect(rendered.imageHtml).toContain("max-width: 960px;");
    expect(rendered.imageHtml).toContain("--diffs-font-size: 16px;");
    expect(rendered.html).toContain("min-height: 100vh;");
    expect(rendered.html).toContain('"diffIndicators":"bars"');
    expect(rendered.html).toContain('"disableLineNumbers":false');
    expect(rendered.html).toContain("--diffs-line-height: 24px;");
    expect(rendered.html).toContain("--diffs-font-size: 15px;");
    expect(rendered.html).not.toContain("fonts.googleapis.com");
    expect(rendered.html).not.toContain('<nav class="oc-diff-card oc-diff-nav"');
    expect(rendered.html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(rendered.html).toContain("scroll-behavior: auto;");
  });

  it("normalizes non-finite presentation numbers before rendering CSS", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "old\n",
        after: "new\n",
      },
      {
        presentation: {
          ...DEFAULT_DIFFS_TOOL_DEFAULTS,
          fontSize: Number.NaN,
          lineSpacing: Number.POSITIVE_INFINITY,
        },
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
    );

    expect(rendered.html).toContain("--diffs-font-size: 15px;");
    expect(rendered.html).toContain("--diffs-line-height: 24px;");
    expect(rendered.imageHtml).toContain("--diffs-font-size: 16px;");
    expect(rendered.html).not.toContain("NaNpx");
    expect(rendered.imageHtml).not.toContain("NaNpx");
  });

  it("resolves viewer assets under an optional base path", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "const value = 1;\n",
        after: "const value = 2;\n",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
    );

    const html = rendered.html ?? "";
    const loaderSrc = html.match(/<script type="module" src="([^"]+)"><\/script>/)?.[1];
    expect(loaderSrc).toBe("../../assets/viewer.js");
    expect(
      new URL(loaderSrc ?? "", "https://example.com/openclaw/plugins/diffs/view/id/token").pathname,
    ).toBe("/openclaw/plugins/diffs/assets/viewer.js");
  });

  it("downgrades invalid language hints to plain text", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "const value = 1;\n",
        after: "const value = 2;\n",
        lang: "not-a-real-language",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
    );

    const html = rendered.html ?? "";

    expect(rendered.title).toBe("Text diff");
    expect(html).toContain("diff.txt");
    expect(html).not.toContain("not-a-real-language");

    const payloads = [...html.matchAll(/data-openclaw-diff-payload>(.*?)<\/script>/g)].map(
      (match) => parseViewerPayloadJson(match[1] ?? ""),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.langs).toEqual(["text"]);
    expect(payloads[0]?.oldFile?.lang).toBeUndefined();
    expect(payloads[0]?.newFile?.lang).toBeUndefined();
  });

  it("keeps uncommon language diffs readable without the language pack", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "REPORT z_demo.\n",
        after: "REPORT z_demo2.\n",
        lang: "abap",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
      "viewer",
    );

    const html = rendered.html ?? "";
    const payload = parseViewerPayloadJson(
      html.match(/data-openclaw-diff-payload>(.*?)<\/script>/)?.[1] ?? "",
    );

    expect(rendered.viewerRuntime).toBe("base");
    expect(html).toContain("../../assets/viewer.js");
    expect(html).not.toContain("diffs-language-pack");
    expect(payload.langs).toEqual(["text"]);
  });

  it("uses the language-pack viewer runtime for uncommon languages when available", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "REPORT z_demo.\n",
        after: "REPORT z_demo2.\n",
        lang: "abap",
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
        languagePackAvailable: true,
      },
      "viewer",
    );

    const html = rendered.html ?? "";
    const payload = parseViewerPayloadJson(
      html.match(/data-openclaw-diff-payload>(.*?)<\/script>/)?.[1] ?? "",
    );

    expect(rendered.viewerRuntime).toBe("language-pack");
    expect(html).toContain("../../../diffs-language-pack/assets/viewer.js");
    expect(payload.langs).toEqual(["abap"]);
  });

  it("renders multi-file patch input with a changed-files summary nav", async () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      "-const a = 1;",
      "+const a = 2;",
      "+const extra = true;",
      " const keep = 0;",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-const b = 1;",
      "+const b = 2;",
    ].join("\n");

    const rendered = await renderDiffDocument(
      {
        kind: "patch",
        patch,
        title: "Workspace patch",
      },
      {
        presentation: {
          ...DEFAULT_DIFFS_TOOL_DEFAULTS,
          layout: "split",
          theme: "dark",
        },
        image: resolveDiffImageRenderOptions({
          defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
          fileQuality: "hq",
          fileMaxWidth: 1180,
        }),
        expandUnchanged: true,
      },
    );

    expect(rendered.title).toBe("Workspace patch");
    expect(rendered.fileCount).toBe(2);
    expect(rendered.html).toContain("Workspace patch");
    expect(rendered.imageHtml).toContain("max-width: 1180px;");

    const html = rendered.html ?? "";
    expect(html).toContain('<nav class="oc-diff-card oc-diff-nav" aria-label="Changed files">');
    expect(html).toContain("2 changed files");
    expect(html).toContain(
      '<span class="oc-diff-nav-additions">+3</span><span class="oc-diff-nav-deletions">-2</span>',
    );
    expect(html).toContain(
      '<span class="oc-diff-nav-additions">+2</span><span class="oc-diff-nav-deletions">-1</span>',
    );
    expect(html).toContain('href="#oc-diff-file-1"');
    expect(html).toContain('id="oc-diff-file-1"');
    expect(html).toContain('href="#oc-diff-file-2"');
    expect(html).toContain('id="oc-diff-file-2"');
    expect(rendered.imageHtml).toContain('<nav class="oc-diff-card oc-diff-nav"');
  });

  it("labels added, deleted, and renamed files in the summary nav and escapes names", async () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+const created = true;",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-const removed = true;",
      "diff --git a/before.ts b/after.ts",
      "similarity index 90%",
      "rename from before.ts",
      "rename to after.ts",
      "--- a/before.ts",
      "+++ b/after.ts",
      "@@ -1 +1 @@",
      "-const v = 1;",
      "+const v = 2;",
      "diff --git a/a&b.ts b/a&b.ts",
      "--- a/a&b.ts",
      "+++ b/a&b.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");

    const rendered = await renderDiffDocument(
      {
        kind: "patch",
        patch,
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
      "viewer",
    );

    const html = rendered.html ?? "";
    expect(html).toContain("4 changed files");
    expect(html).toContain('<span class="oc-diff-nav-badge" data-change="added">added</span>');
    expect(html).toContain('<span class="oc-diff-nav-badge" data-change="deleted">deleted</span>');
    expect(html).toContain('<span class="oc-diff-nav-badge" data-change="renamed">renamed</span>');
    expect(html).toContain("before.ts &rarr; after.ts");
    expect(html).toContain("a&amp;b.ts");
  });

  it("omits the summary nav for single-file patches", async () => {
    const patch = [
      "diff --git a/solo.ts b/solo.ts",
      "--- a/solo.ts",
      "+++ b/solo.ts",
      "@@ -1 +1 @@",
      "-const solo = 1;",
      "+const solo = 2;",
    ].join("\n");

    const rendered = await renderDiffDocument(
      {
        kind: "patch",
        patch,
      },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
      "viewer",
    );

    expect(rendered.fileCount).toBe(1);
    expect(rendered.html).not.toContain('<nav class="oc-diff-card oc-diff-nav"');
  });

  it("rejects patches that exceed file-count limits", async () => {
    const patch = Array.from({ length: 129 }, (_, i) => {
      return [
        `diff --git a/f${i}.ts b/f${i}.ts`,
        `--- a/f${i}.ts`,
        `+++ b/f${i}.ts`,
        "@@ -1 +1 @@",
        "-const x = 1;",
        "+const x = 2;",
      ].join("\n");
    }).join("\n");

    await expect(
      renderDiffDocument(
        {
          kind: "patch",
          patch,
        },
        {
          presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
          image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
          expandUnchanged: false,
        },
      ),
    ).rejects.toThrow("too many files");
  });
});
