import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound normalizePayload", () => {
  it("normalizes metadata-only direct payloads with provided fallback text", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        text: "   ",
        fallbackText: { text: "Pablo Daily Summary\n- Review the stuck cron." },
        channelData: {
          telegram: {
            buttons: [[{ text: "Open task", url: "https://example.test/task" }]],
          },
        },
      },
    });

    expect(normalized).toEqual({
      text: "Pablo Daily Summary\n- Review the stuck cron.",
      fallbackText: { text: "Pablo Daily Summary\n- Review the stuck cron." },
      channelData: {
        telegram: {
          buttons: [[{ text: "Open task", url: "https://example.test/task" }]],
        },
      },
    });
  });

  it("keeps reaction-only payloads textless during payload normalization", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        fallbackText: { text: "Pablo Daily Summary\n- Review the stuck cron." },
        channelData: {
          telegram: {
            reaction: { emoji: "+1", replyToId: "123" },
          },
        },
      },
    });

    expect(normalized).toEqual({
      fallbackText: { text: "Pablo Daily Summary\n- Review the stuck cron." },
      channelData: {
        telegram: {
          reaction: { emoji: "+1", replyToId: "123" },
        },
      },
    });
  });

  it("suppresses metadata-only button payloads when no fallback text exists", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        channelData: {
          telegram: {
            buttons: [[{ text: "Open task", url: "https://example.test/task" }]],
          },
        },
      },
    });

    expect(normalized).toBeNull();
  });

  it("suppresses unrelated metadata-only payloads even when fallback text exists", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        fallbackText: { text: "Pablo Daily Summary\n- Review the stuck cron." },
        channelData: { plugin: { traceId: "trace-1" } },
      },
    });

    expect(normalized).toBeNull();
  });

  it.each([
    { name: "media", payload: { mediaUrl: "https://example.test/report.png" } },
    { name: "location", payload: { location: { latitude: 1, longitude: 2 } } },
    {
      name: "portable buttons",
      payload: {
        presentation: {
          blocks: [{ type: "buttons" as const, buttons: [{ label: "Retry", value: "retry" }] }],
        },
      },
    },
  ])("preserves $name payloads without Telegram metadata", ({ payload }) => {
    const normalized = telegramOutbound.normalizePayload?.({ cfg: {} as never, payload });

    expect(normalized).toEqual(payload);
  });

  it("merges all fallback adopters into the linked summary and keeps reactions separate", () => {
    const payloads = [
      { text: "Pablo Daily Summary" },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { reaction: { emoji: "+1", replyToId: "123" } } },
      },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { buttons: [[{ text: "Open task 1", callback_data: "one" }]] } },
      },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { buttons: [[{ text: "Open task 2", callback_data: "two" }]] } },
      },
    ];
    const normalizedPayloads = payloads.map(
      (payload) => telegramOutbound.normalizePayload?.({ cfg: {} as never, payload }) ?? payload,
    );
    const normalized = telegramOutbound.normalizePayloadBatch?.({
      cfg: {} as never,
      payloads: normalizedPayloads.map((payload, index) => ({ index, payload })),
    });

    expect(normalized).toEqual([
      {
        text: "Pablo Daily Summary",
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: {
          telegram: {
            buttons: [
              [{ text: "Open task 1", callback_data: "one" }],
              [{ text: "Open task 2", callback_data: "two" }],
            ],
          },
        },
      },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { reaction: { emoji: "+1", replyToId: "123" } } },
      },
      null,
      null,
    ]);
  });

  it("merges fallback buttons into a linked captioned media payload", () => {
    const payloads = [
      { text: "Pablo Daily Summary", mediaUrl: "https://example.test/report.png" },
      {
        text: "Pablo Daily Summary",
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { buttons: [[{ text: "Open task" }]] } },
      },
    ];

    expect(
      telegramOutbound.normalizePayloadBatch?.({
        cfg: {} as never,
        payloads: payloads.map((payload, index) => ({ index, payload })),
      }),
    ).toEqual([
      {
        text: "Pablo Daily Summary",
        mediaUrl: "https://example.test/report.png",
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { buttons: [[{ text: "Open task" }]] } },
      },
      null,
    ]);
  });

  it("does not merge a fallback adopter with independent media", () => {
    const payloads = [
      { text: "Pablo Daily Summary" },
      {
        text: "Pablo Daily Summary",
        mediaUrl: "https://example.test/detail.png",
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { buttons: [[{ text: "Open task" }]] } },
      },
    ];

    expect(
      telegramOutbound.normalizePayloadBatch?.({
        cfg: {} as never,
        payloads: payloads.map((payload, index) => ({ index, payload })),
      }),
    ).toEqual(payloads);
  });

  it("does not merge an adopted fallback without an explicit source link", () => {
    const payloads = [
      { text: "Pablo Daily Summary" },
      {
        text: "Pablo Daily Summary",
        fallbackText: { text: "Pablo Daily Summary" },
        channelData: { telegram: { buttons: [[{ text: "Open task" }]] } },
      },
    ];

    expect(
      telegramOutbound.normalizePayloadBatch?.({
        cfg: {} as never,
        payloads: payloads.map((payload, index) => ({ index, payload })),
      }),
    ).toEqual(payloads);
  });

  it("keeps fallback adopters with distinct quote metadata separate", () => {
    const payloads = [
      { text: "Pablo Daily Summary" },
      {
        text: "Pablo Daily Summary",
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { quoteText: "First quote" } },
      },
      {
        text: "Pablo Daily Summary",
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { quoteText: "Second quote" } },
      },
    ];

    expect(
      telegramOutbound.normalizePayloadBatch?.({
        cfg: {} as never,
        payloads: payloads.map((payload, index) => ({ index, payload })),
      }),
    ).toEqual(payloads);
  });
});
