import { describe, expect, it } from "vitest";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";

describe("canonicalizeTelegramPresentationPayload", () => {
  it("preserves mixed presentation order while moving controls to Telegram buttons", () => {
    const result = canonicalizeTelegramPresentationPayload({
      text: "Top-level summary",
      presentation: {
        title: "FY25 outlook",
        blocks: [
          { type: "text", text: "Before table" },
          {
            type: "table",
            caption: "Pipeline",
            headers: ["Account", "Stage"],
            rows: [
              ["Acme", "Won"],
              ["Globex", "Review"],
            ],
          },
          { type: "context", text: "After table" },
          { type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] },
        ],
      },
    });

    const text = result.text ?? "";
    const orderedMarkers = [
      "Top-level summary",
      "FY25 outlook",
      "Before table",
      "Pipeline (table)",
      "- Account: Acme; Stage: Won",
      "- Account: Globex; Stage: Review",
      "After table",
    ];
    for (const [index, marker] of orderedMarkers.entries()) {
      expect(text.indexOf(marker)).toBeGreaterThan(
        index === 0 ? -1 : text.indexOf(orderedMarkers[index - 1]!),
      );
    }
    expect(text).not.toContain("Refresh");
    expect(result.presentation).toBeUndefined();
    expect(result.channelData?.telegram).toEqual({
      buttons: [[{ text: "Refresh", callback_data: "refresh" }]],
    });
  });

  it("keeps control-only payloads deliverable without duplicating their labels", () => {
    const result = canonicalizeTelegramPresentationPayload({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
      },
    });

    expect(result).toMatchObject({
      text: "Choose an option.",
      channelData: {
        telegram: { buttons: [[{ text: "Retry", callback_data: "retry" }]] },
      },
    });
    expect(result.text).not.toContain("Retry");
    expect(result.presentation).toBeUndefined();
  });

  it("keeps native Telegram button-only payloads deliverable", () => {
    const buttons = [[{ text: "Retry", callback_data: "retry" }]];
    const result = canonicalizeTelegramPresentationPayload({
      channelData: { telegram: { buttons } },
    });

    expect(result).toEqual({
      text: "Choose an option.",
      channelData: { telegram: { buttons } },
    });
  });

  it("preserves select prompts and maps option labels only to native buttons", () => {
    const result = canonicalizeTelegramPresentationPayload({
      presentation: {
        blocks: [
          {
            type: "select",
            placeholder: "Choose an environment",
            options: [
              { label: "Production", value: "prod" },
              { label: "Staging", value: "staging" },
            ],
          },
        ],
      },
    });

    expect(result.text).toBe("Choose an environment");
    expect(result.text).not.toContain("Production");
    expect(result.channelData?.telegram).toEqual({
      buttons: [
        [
          { text: "Production", callback_data: "prod" },
          { text: "Staging", callback_data: "staging" },
        ],
      ],
    });
  });

  it("falls back only controls that Telegram cannot encode", () => {
    const result = canonicalizeTelegramPresentationPayload({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Retry", value: "retry" },
              { label: "Copy manually", value: "x".repeat(65) },
            ],
          },
        ],
      },
    });

    expect(result.text).toBe("- Copy manually");
    expect(result.text).not.toContain("Retry");
    expect(result.channelData?.telegram).toEqual({
      buttons: [[{ text: "Retry", callback_data: "retry" }]],
    });
  });

  it("uses native web_app only for a confirmed direct target", () => {
    const payload = {
      text: "Open app:",
      presentation: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "Launch",
                action: { type: "web-app" as const, url: "https://example.com/app" },
              },
            ],
          },
        ],
      },
    };

    expect(
      canonicalizeTelegramPresentationPayload(payload, { allowWebAppButtons: true }),
    ).toMatchObject({
      text: "Open app:",
      channelData: {
        telegram: {
          buttons: [[{ text: "Launch", web_app: { url: "https://example.com/app" } }]],
        },
      },
    });
    expect(canonicalizeTelegramPresentationPayload(payload, { allowWebAppButtons: false })).toEqual(
      {
        text: "Open app:\n\n- Launch: https://example.com/app",
      },
    );
  });

  it("falls back presentation controls when explicit Telegram buttons take precedence", () => {
    const nativeButtons = [[{ text: "Native", callback_data: "native" }]];
    const result = canonicalizeTelegramPresentationPayload({
      text: "Use the available action",
      channelData: { telegram: { buttons: nativeButtons } },
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Generic", value: "generic" }] }],
      },
    });

    expect(result.text).toBe("Use the available action\n\n- Generic");
    expect(result.channelData?.telegram).toEqual({ buttons: nativeButtons });
    expect(result.presentation).toBeUndefined();
  });

  it("does not duplicate an already-materialized full fallback", () => {
    const presentation = {
      blocks: [
        { type: "text" as const, text: "Summary" },
        {
          type: "table" as const,
          caption: "Pipeline",
          headers: ["Account"],
          rows: [["Acme"]],
        },
      ],
    };
    const first = canonicalizeTelegramPresentationPayload({ presentation });
    const second = canonicalizeTelegramPresentationPayload({
      text: first.text,
      presentation,
    });

    expect(second.text).toBe(first.text);
  });
});
