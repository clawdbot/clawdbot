// Build Diffs Viewer Runtime tests cover build diffs viewer runtime script behavior.
import { describe, expect, it } from "vitest";
import { createPierreDiffsSideEffectImportPlugin } from "../../scripts/build-diffs-viewer-runtime.mjs";

type ResolveCallback = (args: { importer: string; path: string }) => unknown;
type LoadCallback = () => unknown;

function collectPluginCallbacks() {
  const resolveCallbacks: ResolveCallback[] = [];
  const loadCallbacks: LoadCallback[] = [];
  const plugin = createPierreDiffsSideEffectImportPlugin();
  plugin.setup({
    onResolve(_options: unknown, callback: ResolveCallback) {
      resolveCallbacks.push(callback);
    },
    onLoad(_options: unknown, callback: LoadCallback) {
      loadCallbacks.push(callback);
    },
  });
  return { loadCallbacks, resolveCallbacks };
}

describe("build diffs viewer runtime", () => {
  it("replaces Pierre Diffs' empty side-effect import without touching real diff imports", () => {
    const { loadCallbacks, resolveCallbacks } = collectPluginCallbacks();
    expect(resolveCallbacks).toHaveLength(1);
    expect(loadCallbacks).toHaveLength(1);

    expect(
      resolveCallbacks[0]({
        path: "diff",
        importer: "/repo/node_modules/@pierre/diffs/dist/utils/parseDiffDecorations.js",
      }),
    ).toEqual({
      path: "pierre-diffs-parse-decorations-side-effect",
      namespace: "openclaw-diffs-empty-side-effect",
      sideEffects: true,
    });
    expect(
      resolveCallbacks[0]({
        path: "diff",
        importer: "/repo/node_modules/@pierre/diffs/dist/utils/renderDiffWithHighlighter.js",
      }),
    ).toBeUndefined();
    expect(loadCallbacks[0]()).toEqual({
      contents: "export {};\n",
      loader: "js",
    });
  });
});
