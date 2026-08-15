// Diffs tests cover render target plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { preloadDiffHTMLMock } = vi.hoisted(() => ({
  preloadDiffHTMLMock: vi.fn(async () => "<div>mock diff</div>"),
}));

vi.mock("@pierre/diffs/ssr", () => ({
  preloadDiffHTML: preloadDiffHTMLMock,
}));

afterAll(() => {
  vi.doUnmock("@pierre/diffs/ssr");
  vi.resetModules();
});

import { resolveDiffImageRenderOptions, resolveDiffsPluginDefaults } from "./config.js";
import { renderDiffDocument } from "./render.js";

const DEFAULT_DIFFS_TOOL_DEFAULTS = resolveDiffsPluginDefaults(undefined);

function createRenderOptions() {
  return {
    presentation: DEFAULT_DIFFS_TOOL_DEFAULTS,
    image: resolveDiffImageRenderOptions({ defaults: DEFAULT_DIFFS_TOOL_DEFAULTS }),
    expandUnchanged: false,
  };
}

describe("renderDiffDocument render targets", () => {
  beforeEach(() => {
    preloadDiffHTMLMock.mockClear();
  });

  it("renders only the viewer variant for before/after viewer mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "one\n",
        after: "two\n",
      },
      createRenderOptions(),
      "viewer",
    );

    expect(rendered.html).toContain("mock diff");
    expect(rendered.imageHtml).toBeUndefined();
    expect(preloadDiffHTMLMock).toHaveBeenCalledTimes(1);
  });

  it("renders both variants for before/after both mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "before_after",
        before: "one\n",
        after: "two\n",
      },
      createRenderOptions(),
      "both",
    );

    expect(rendered.html).toContain("mock diff");
    expect(rendered.imageHtml).toContain("mock diff");
    expect(preloadDiffHTMLMock).toHaveBeenCalledTimes(1);
  });

  it("renders only the image variant for patch image mode", async () => {
    const rendered = await renderDiffDocument(
      {
        kind: "patch",
        patch: [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      },
      createRenderOptions(),
      "image",
    );

    expect(rendered.html).toBeUndefined();
    expect(rendered.imageHtml).toContain("mock diff");
    expect(preloadDiffHTMLMock).toHaveBeenCalledTimes(1);
  });
});
