import { describe, expect, it, vi } from "vitest";
import {
  prepareZaloDurableReplyPayload,
  resolveZaloDurableReplyOptions,
} from "./monitor-durable.js";

describe("Zalo durable reply helpers", () => {
  it("normalizes markdown tables before durable or legacy delivery", () => {
    const convertMarkdownTables = vi.fn(() => "converted table");

    expect(
      prepareZaloDurableReplyPayload({
        payload: { text: "| a |\n| - |" },
        tableMode: "code",
        convertMarkdownTables,
      }),
    ).toEqual({ text: "converted table" });
    expect(convertMarkdownTables).toHaveBeenCalledWith("| a |\n| - |", "code");
  });

  it("uses durable final delivery for text-only final replies", () => {
    expect(
      resolveZaloDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "final",
        chatId: "123456789",
      }),
    ).toEqual({
      to: "123456789",
    });
  });

  it("keeps media and non-final replies on the legacy path", () => {
    expect(
      resolveZaloDurableReplyOptions({
        payload: { text: "photo", mediaUrl: "https://example.com/photo.jpg" },
        infoKind: "final",
        chatId: "123456789",
      }),
    ).toBe(false);
    expect(
      resolveZaloDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "block",
        chatId: "123456789",
      }),
    ).toBe(false);
  });
});
