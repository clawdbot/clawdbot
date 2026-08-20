import { describe, expect, it, vi } from "vitest";
import type { MessagePresentation } from "../../interactive/payload.js";
import type { ChannelHandler } from "./deliver-contracts.js";
import { renderPresentationForDelivery } from "./deliver-payload.js";

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

function buildHandler(overrides: Partial<ChannelHandler>): ChannelHandler {
  const sendResult = { channel: "telegram" as const, messageId: "1" };
  return {
    chunker: null,
    supportsMedia: false,
    buildTargetRef: () => ({ channel: "telegram", to: "target" }),
    sendText: async () => sendResult,
    sendMedia: async () => sendResult,
    ...overrides,
  };
}

describe("renderPresentationForDelivery authored fallback", () => {
  it("keeps authored fallback text when every data block degrades to text", async () => {
    const renderPresentation = vi.fn();
    const handler = buildHandler({
      presentationCapabilities: { supported: true, tables: false },
      renderPresentation,
    });

    const rendered = await renderPresentationForDelivery(handler, {
      text: "authored plain body",
      presentation: tablePresentation,
      presentationTextMode: "fallback",
    });

    expect(rendered.text).toBe("authored plain body");
    expect(rendered.presentation).toBeUndefined();
    expect(renderPresentation).not.toHaveBeenCalled();
  });

  it("renders natively when the channel keeps table blocks", async () => {
    const renderPresentation = vi.fn().mockImplementation(async (payload: { text?: string }) => ({
      ...payload,
      text: "native table rendering",
    }));
    const handler = buildHandler({
      presentationCapabilities: { supported: true, tables: true },
      renderPresentation,
    });

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
    const handler = buildHandler({
      presentationCapabilities: { supported: true, buttons: true, tables: false },
      renderPresentation,
    });

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
