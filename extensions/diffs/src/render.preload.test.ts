// Diffs tests cover shared SSR preload behavior.
import { disposeHighlighter } from "@pierre/diffs";
import * as diffsSsr from "@pierre/diffs/ssr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDiffImageRenderOptions, resolveDiffsPluginDefaults } from "./config.js";
import { renderDiffDocument } from "./render.js";

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);

vi.mock("@pierre/diffs/ssr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/ssr")>();
  return {
    ...actual,
    preloadDiffHTML: vi.fn(actual.preloadDiffHTML),
  };
});

describe("renderDiffDocument SSR preloads", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await disposeHighlighter();
  });

  it("preloads a before/after diff once for viewer and image output", async () => {
    await renderDiffDocument(
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
      "both",
    );

    expect(diffsSsr.preloadDiffHTML).toHaveBeenCalledTimes(1);
  });

  it("preloads each patch file once for viewer and image output", async () => {
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

    await renderDiffDocument(
      { kind: "patch", patch },
      {
        presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
        image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
        expandUnchanged: false,
      },
      "both",
    );

    expect(diffsSsr.preloadDiffHTML).toHaveBeenCalledTimes(2);
  });
});
