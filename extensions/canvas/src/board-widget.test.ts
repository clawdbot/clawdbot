import { describe, expect, it } from "vitest";
import { canvasA2UIBoardWidgetKind } from "./board-widget.js";

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
