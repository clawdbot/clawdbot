import {
  disposeHighlighter,
  RegisteredCustomThemes,
  ResolvedThemes,
  ResolvingThemes,
} from "@pierre/diffs";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DIFFS_TOOL_DEFAULTS, resolveDiffImageRenderOptions } from "./config.js";
import { renderDiffDocument } from "./render.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

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

  it("renders multi-file patch input", async () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
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
  });

  it("re-registers pierre theme loaders before rendering", async () => {
    await disposeHighlighter();

    const originalLightLoader = RegisteredCustomThemes.get("pierre-light");
    const originalDarkLoader = RegisteredCustomThemes.get("pierre-dark");
    const brokenLoader = async () => {
      throw new Error("broken pierre theme loader");
    };

    RegisteredCustomThemes.set("pierre-light", brokenLoader);
    RegisteredCustomThemes.set("pierre-dark", brokenLoader);
    ResolvedThemes.delete("pierre-light");
    ResolvedThemes.delete("pierre-dark");
    ResolvingThemes.delete("pierre-light");
    ResolvingThemes.delete("pierre-dark");

    try {
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

      expect(rendered.fileCount).toBe(1);
      expect(rendered.html).toContain("src/example.ts");
      expect(RegisteredCustomThemes.get("pierre-light")).not.toBe(brokenLoader);
      expect(RegisteredCustomThemes.get("pierre-dark")).not.toBe(brokenLoader);
    } finally {
      if (originalLightLoader) {
        RegisteredCustomThemes.set("pierre-light", originalLightLoader);
      } else {
        RegisteredCustomThemes.delete("pierre-light");
      }
      if (originalDarkLoader) {
        RegisteredCustomThemes.set("pierre-dark", originalDarkLoader);
      } else {
        RegisteredCustomThemes.delete("pierre-dark");
      }
      await disposeHighlighter();
    }
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
