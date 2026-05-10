import { describe, expect, it } from "vitest";
import {
  hasReplyChannelData,
  hasReplyContent,
  hasReplyPayloadContent,
  normalizeInteractiveReply,
  presentationToInteractiveControlsReply,
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveInteractiveTextFallback,
} from "./payload.js";

describe("hasReplyChannelData", () => {
  it.each([
    { value: undefined, expected: false },
    { value: {}, expected: false },
    { value: [], expected: false },
    { value: { slack: { blocks: [] } }, expected: true },
  ] as const)("accepts non-empty objects only: %j", ({ value, expected }) => {
    expect(hasReplyChannelData(value)).toBe(expected);
  });
});

describe("hasReplyContent", () => {
  it("treats whitespace-only text and empty structured payloads as empty", () => {
    expect(
      hasReplyContent({
        text: "   ",
        mediaUrls: ["", "   "],
        interactive: { blocks: [] },
        hasChannelData: false,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "shared interactive blocks",
      input: {
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
        },
      },
    },
    {
      name: "explicit extra content",
      input: {
        text: "   ",
        extraContent: true,
      },
    },
  ] as const)("accepts $name", ({ input }) => {
    expect(hasReplyContent(input)).toBe(true);
  });
});

describe("hasReplyPayloadContent", () => {
  it("trims text and falls back to channel data by default", () => {
    expect(
      hasReplyPayloadContent({
        text: "   ",
        channelData: { slack: { blocks: [] } },
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "explicit channel-data overrides",
      payload: {
        text: "   ",
        channelData: {},
      },
      options: {
        hasChannelData: true,
      },
    },
    {
      name: "extra content",
      payload: {
        text: "   ",
      },
      options: {
        extraContent: true,
      },
    },
  ] as const)("accepts $name", ({ payload, options }) => {
    expect(hasReplyPayloadContent(payload, options)).toBe(true);
  });
});

describe("interactive payload helpers", () => {
  it("normalizes interactive replies and resolves text fallbacks", () => {
    const interactive = normalizeInteractiveReply({
      blocks: [
        { type: "text", text: "First" },
        { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        { type: "text", text: "Second" },
      ],
    });

    expect(interactive).toEqual({
      blocks: [
        { type: "text", text: "First" },
        { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        { type: "text", text: "Second" },
      ],
    });
    expect(resolveInteractiveTextFallback({ interactive })).toBe("First\n\nSecond");
  });

  it("preserves URL-only presentation buttons for native link renderers and fallback text", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [{ label: "Docs", url: "https://example.com/docs" }],
        },
      ],
    };

    expect(presentationToInteractiveReply(presentation)).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Docs", url: "https://example.com/docs" }],
        },
      ],
    });
    expect(renderMessagePresentationFallbackText({ presentation })).toBe(
      "- Docs: https://example.com/docs",
    );
  });

  it("converts only presentation controls for native component renderers", () => {
    const presentation = {
      title: "Deploy approval",
      blocks: [
        { type: "text" as const, text: "Canary is ready." },
        { type: "divider" as const },
        {
          type: "buttons" as const,
          buttons: [{ label: "Approve", value: "approve", style: "success" as const }],
        },
        {
          type: "select" as const,
          placeholder: "Rollback target",
          options: [{ label: "Previous", value: "previous" }],
        },
      ],
    };

    expect(presentationToInteractiveReply(presentation)).toEqual({
      blocks: [
        { type: "text", text: "Deploy approval" },
        { type: "text", text: "Canary is ready." },
        {
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve", style: "success" }],
        },
        {
          type: "select",
          placeholder: "Rollback target",
          options: [{ label: "Previous", value: "previous" }],
        },
      ],
    });
    expect(presentationToInteractiveControlsReply(presentation)).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve", style: "success" }],
        },
        {
          type: "select",
          placeholder: "Rollback target",
          options: [{ label: "Previous", value: "previous" }],
        },
      ],
    });
  });

  it("keeps divider-only fallback empty unless a send transport fallback is requested", () => {
    const presentation = {
      blocks: [{ type: "divider" as const }],
    };

    expect(renderMessagePresentationFallbackText({ presentation })).toBe("");
    expect(
      renderMessagePresentationFallbackText({
        presentation,
        emptyFallback: "---",
      }),
    ).toBe("---");
  });
});
