import { describe, expect, it, vi } from "vitest";
import type { MessagePresentation } from "../../../interactive/payload.js";
import { renderPresentationForDelivery } from "./presentation-delivery.js";

const tablePresentation: MessagePresentation = {
  title: "Status",
  blocks: [
    {
      type: "table",
      caption: "Session status",
      headers: ["Item", "Value"],
      rows: [["Model", "anthropic/claude-haiku-4-5"]],
    },
  ],
};

describe("renderPresentationForDelivery authored fallback", () => {
  it.each([
    { name: "a table", presentation: tablePresentation },
    {
      name: "a table with native context",
      presentation: {
        ...tablePresentation,
        blocks: [...tablePresentation.blocks, { type: "context", text: "Uptime: 42s" }],
      } satisfies MessagePresentation,
    },
  ])("preserves authored fallback for $name", async ({ presentation }) => {
    const renderPresentation = vi.fn();
    const handler = {
      presentationCapabilities: { supported: true, tables: false, context: true },
      renderPresentation,
    };
    const authoredText = "Model: anthropic/claude-haiku-4-5\nUptime: 42s\nReference UTC: 12:00";

    const rendered = await renderPresentationForDelivery(handler, {
      text: authoredText,
      presentation,
      presentationTextMode: "fallback",
    });

    expect(rendered.text).toBe(authoredText);
    expect(rendered.presentation).toBeUndefined();
    expect(renderPresentation).not.toHaveBeenCalled();
  });

  it("renders natively when the channel keeps table blocks", async () => {
    const renderPresentation = vi.fn().mockImplementation(async (payload: { text?: string }) => ({
      ...payload,
      text: "native table rendering",
    }));
    const handler = {
      presentationCapabilities: { supported: true, tables: true },
      renderPresentation,
    };

    const rendered = await renderPresentationForDelivery(handler, {
      text: "authored plain body",
      presentation: tablePresentation,
      presentationTextMode: "fallback",
    });

    expect(renderPresentation).toHaveBeenCalledTimes(1);
    expect(rendered.text).toBe("native table rendering");
    expect(rendered.presentation).toBeUndefined();
  });

  it("still renders interactive presentations through the channel renderer", async () => {
    const renderPresentation = vi
      .fn()
      .mockImplementation(async (payload: { text?: string }) => payload);
    const handler = {
      presentationCapabilities: { supported: true, buttons: true, tables: false },
      renderPresentation,
    };

    await renderPresentationForDelivery(handler, {
      text: "authored plain body",
      presentation: {
        blocks: [
          ...tablePresentation.blocks,
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        ],
      },
      presentationTextMode: "fallback",
    });

    expect(renderPresentation).toHaveBeenCalledTimes(1);
  });
});
