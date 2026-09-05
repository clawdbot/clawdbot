import { describe, expect, it, vi } from "vitest";
import { canvasA2UIBoardWidgetKind } from "./board-widget.js";

const readPublicResource = vi.hoisted(() =>
  vi.fn(async () => ({ body: new Uint8Array([42]), contentType: "application/javascript" })),
);
vi.mock("./host/a2ui.js", () => ({ readPublicA2uiResource: readPublicResource }));

const V08_SOURCE = [
  JSON.stringify({
    surfaceUpdate: {
      surfaceId: "main",
      components: [{ id: "root", component: { Text: { text: { literalString: "hello" } } } }],
    },
  }),
  JSON.stringify({ beginRendering: { surfaceId: "main", root: "root" } }),
].join("\n");

const V09_SOURCE = JSON.stringify({
  version: "v0.9",
  deleteSurface: { surfaceId: "main" },
});

describe("Canvas A2UI board documents", () => {
  it("exposes only its two registered renderer bundles as public static resources", async () => {
    readPublicResource.mockClear();
    for (const resourcePath of canvasA2UIBoardWidgetKind.resources.paths) {
      await expect(
        canvasA2UIBoardWidgetKind.resources.readPublicResource?.(resourcePath),
      ).resolves.toMatchObject({ contentType: "application/javascript" });
      expect(readPublicResource).toHaveBeenLastCalledWith(resourcePath);
    }
    for (const resourcePath of [
      "/__openclaw__/a2ui/private.json",
      "/__openclaw__/a2ui/../config.json",
      "/__openclaw__/canvas/documents/private/index.html",
    ]) {
      await expect(
        canvasA2UIBoardWidgetKind.resources.readPublicResource?.(resourcePath),
      ).resolves.toBeUndefined();
    }
    expect(readPublicResource).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["v0.8", V08_SOURCE, "/__openclaw__/a2ui/a2ui.bundle.js"],
    ["v0.9", V09_SOURCE, "/__openclaw__/a2ui/a2ui-v0.9.bundle.js"],
  ])("composes %s with the capability-scoped renderer resource", (_name, source, path) => {
    const resourceUrl = `/__openclaw__/cap/token${path}`;
    const document = canvasA2UIBoardWidgetKind.composeDocument?.({
      source,
      title: "A2UI",
      resourceUrls: { [path]: resourceUrl },
      promptGranted: false,
    });

    expect(document).toContain("<openclaw-a2ui-host></openclaw-a2ui-host>");
    expect(document).toContain(resourceUrl);
    expect(document).toContain('"actionTier":"state"');
  });

  it("rejects a document when its renderer resource was not provisioned", () => {
    expect(() =>
      canvasA2UIBoardWidgetKind.composeDocument?.({
        source: V09_SOURCE,
        title: "A2UI",
        resourceUrls: {},
        promptGranted: true,
      }),
    ).toThrow("A2UI renderer resource unavailable");
  });
});
