// Chat widgets size to their content: the in-frame reporter drives the host
// frame, so a tall document must not end up scrolling inside its own row.
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat widget autosizing",
  startServerBeforeBrowser: true,
});

const documentId = "widget-autosize-proof";
const documentPath = `/__openclaw__/canvas/documents/${documentId}/index.html`;
// Taller than any viewport this suite uses, so a frame that fits the content
// can only come from the reported height rather than from the layout box.
const rowCount = 90;
const rowHeight = 28;

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("fits a widget taller than the previous frame ceiling", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "canvas.document.view": canvasView(
            buildWidgetDocument(
              "Autosize proof",
              `<div style="display:grid">${Array.from(
                { length: rowCount },
                (_, index) =>
                  `<div style="height:${rowHeight}px;line-height:${rowHeight}px">Row ${index + 1}</div>`,
              ).join("")}</div>`,
            ),
          ),
        },
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "autosize-widget",
                name: "canvas_render",
                arguments: { title: "Autosize proof" },
              },
              {
                type: "tool_result",
                id: "autosize-widget",
                name: "canvas_render",
                text: JSON.stringify({
                  kind: "canvas",
                  view: {
                    backend: "canvas",
                    id: documentId,
                    url: documentPath,
                    title: "Autosize proof",
                  },
                  presentation: { target: "assistant_message", sandbox: "scripts" },
                }),
              },
            ],
            timestamp: 100,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const frame = page.locator(".chat-tool-card__preview-frame");
      await frame.waitFor();
      const contentHeight = rowCount * rowHeight;
      await expect
        .poll(async () => Math.round((await frame.boundingBox())?.height ?? 0))
        .toBeGreaterThanOrEqual(contentHeight);
      // The document is fully laid out inside the frame, so nothing is hidden
      // behind a nested scrollbar the transcript cannot reach. The frame is
      // sandboxed and cross-origin, so measure from inside it.
      const overflow = await frame
        .contentFrame()
        .frameLocator("iframe")
        .locator("body")
        .evaluate((body) => body.scrollHeight - window.innerHeight);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
