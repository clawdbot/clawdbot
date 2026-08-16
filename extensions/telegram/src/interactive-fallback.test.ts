import { describe, expect, it, vi } from "vitest";
import { handleTelegramQuestionCallback } from "./bot-handlers.callback-actions.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import { parseTelegramQuestionCallbackData } from "./question-callback-data.js";

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

  it("preserves the fourth question option after Telegram splits its button rows", () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const optionValues = ["Staging", "Déployer", "東京", "Production 🚀"];
    const result = canonicalizeTelegramPresentationPayload({
      channelData: { askUser: { questionId, optionValues } },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: optionValues.map((optionValue) => ({
              label: optionValue,
              action: { type: "question" as const, questionId, optionValue },
            })),
          },
        ],
      },
    });
    const telegram = result.channelData?.telegram as
      | { buttons?: ReadonlyArray<ReadonlyArray<{ callback_data?: string }>> }
      | undefined;
    const rows = telegram?.buttons;

    expect(rows?.map((row) => row.length)).toEqual([3, 1]);
    expect(rows?.flatMap((row) => row.map((button) => button.callback_data))).toEqual(
      optionValues.map((_, optionIndex) => `tgq1:${questionId}:${optionIndex}`),
    );
    expect(parseTelegramQuestionCallbackData(rows?.[1]?.[0]?.callback_data)).toEqual({
      questionId,
      optionIndex: 3,
    });
  });

  it("resolves canonical option C when rendered option A repeats across blocks", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const canonicalOptionValues = ["A", "B", "C"];
    const questionButton = (optionValue: string) => ({
      label: optionValue,
      action: { type: "question" as const, questionId, optionValue },
    });
    const result = canonicalizeTelegramPresentationPayload({
      channelData: { askUser: { questionId, optionValues: canonicalOptionValues } },
      presentation: {
        blocks: [
          { type: "buttons", buttons: [questionButton("A"), questionButton("A")] },
          { type: "buttons", buttons: [questionButton("B"), questionButton("C")] },
        ],
      },
    });
    const telegram = result.channelData?.telegram as
      | { buttons?: ReadonlyArray<ReadonlyArray<{ callback_data?: string }>> }
      | undefined;
    const rows = telegram?.buttons;

    expect(rows?.map((row) => row.length)).toEqual([2, 2]);
    expect(rows?.flatMap((row) => row.map((button) => button.callback_data))).toEqual([
      `tgq1:${questionId}:0`,
      `tgq1:${questionId}:0`,
      `tgq1:${questionId}:1`,
      `tgq1:${questionId}:2`,
    ]);
    const callback = parseTelegramQuestionCallbackData(rows?.[1]?.[1]?.callback_data);
    expect(callback).toEqual({
      questionId,
      optionIndex: 2,
    });
    if (!callback) {
      throw new Error("expected canonical Telegram option C callback data");
    }
    const resolveQuestion = vi.fn(async (params: { optionIndex?: number }) => ({
      status: "answered" as const,
      questionId: "destination",
      optionValue: canonicalOptionValues[params.optionIndex ?? -1] ?? "",
    }));
    const feedback = vi.fn(async () => undefined);

    await handleTelegramQuestionCallback({
      callback,
      cfg: {},
      senderId: "42",
      feedback,
      resolveQuestion,
    });

    expect(resolveQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ questionId, optionIndex: 2 }),
    );
    await expect(resolveQuestion.mock.results[0]?.value).resolves.toMatchObject({
      status: "answered",
      questionId: "destination",
      optionValue: "C",
    });
    expect(feedback).toHaveBeenCalledWith("Answer submitted.", true);
  });

  it.each([
    {
      label: "reordered options",
      optionValues: ["A", "B", "C"],
      renderedValues: ["C", "A"],
      expectedIndices: [2, 0],
    },
    {
      label: "a filtered subset",
      optionValues: ["A", "B", "C", "D"],
      renderedValues: ["D", "B"],
      expectedIndices: [3, 1],
    },
    {
      label: "normalized and Unicode values",
      optionValues: [" Deploy ", "東京", "Production 🚀"],
      renderedValues: ["production 🚀", "東京", "deploy"],
      expectedIndices: [2, 1, 0],
    },
  ])(
    "uses authoritative Gateway indices for $label",
    ({ optionValues, renderedValues, expectedIndices }) => {
      const questionId = "ask_0123456789abcdef0123456789abcdef";
      const result = canonicalizeTelegramPresentationPayload({
        channelData: { askUser: { questionId, optionValues } },
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: renderedValues.map((optionValue) => ({
                label: optionValue,
                action: { type: "question" as const, questionId, optionValue },
              })),
            },
          ],
        },
      });
      const telegram = result.channelData?.telegram as
        | { buttons?: ReadonlyArray<ReadonlyArray<{ callback_data?: string }>> }
        | undefined;

      expect(
        telegram?.buttons?.flatMap((row) => row.map((button) => button.callback_data)),
      ).toEqual(expectedIndices.map((optionIndex) => `tgq1:${questionId}:${optionIndex}`));
    },
  );

  it.each([
    { label: "missing", askUser: undefined },
    {
      label: "wrong question",
      askUser: {
        questionId: "ask_fedcba9876543210fedcba9876543210",
        optionValues: ["A", "C"],
      },
    },
    {
      label: "ambiguous",
      askUser: {
        questionId: "ask_0123456789abcdef0123456789abcdef",
        optionValues: [" A ", "a"],
      },
    },
    {
      label: "unmatched",
      askUser: {
        questionId: "ask_0123456789abcdef0123456789abcdef",
        optionValues: ["A", "B"],
      },
    },
    {
      label: "oversized",
      askUser: {
        questionId: "ask_0123456789abcdef0123456789abcdef",
        optionValues: ["A", "B", "C", "D", "E"],
      },
    },
  ])("visibly falls back when canonical question metadata is $label", ({ askUser }) => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const result = canonicalizeTelegramPresentationPayload({
      text: "Choose:",
      ...(askUser ? { channelData: { askUser } } : {}),
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "C",
                action: { type: "question" as const, questionId, optionValue: "C" },
              },
            ],
          },
        ],
      },
    });

    expect(result.text).toContain("C");
    expect(result.channelData?.telegram).toBeUndefined();
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

  it("renders table blocks as native table islands for rich accounts", () => {
    const result = canonicalizeTelegramPresentationPayload(
      {
        text: "Summary",
        presentation: {
          title: "FY25 outlook",
          blocks: [
            {
              type: "table",
              caption: "Pipeline",
              headers: ["Account", "Stage"],
              rows: [
                ["Acme", "Won"],
                ["Cells & <tags>", "Review"],
              ],
              rowHeaderColumnIndex: 0,
            },
            { type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] },
          ],
        },
      },
      { richTables: true },
    );

    const text = result.text ?? "";
    expect(text).toContain("**FY25 outlook**");
    expect(text).toContain("<caption>Pipeline</caption>");
    expect(text).toContain("<thead><tr><th>Account</th><th>Stage</th></tr></thead>");
    expect(text).toContain("<tr><th>Acme</th><td>Won</td></tr>");
    expect(text).toContain("<tr><th>Cells &amp; &lt;tags&gt;</th><td>Review</td></tr>");
    expect(text).not.toContain("Pipeline (table)");
    expect(result.channelData?.telegram).toMatchObject({
      buttons: [[{ text: "Refresh", callback_data: expect.any(String) }]],
    });
  });

  it("renders context blocks in italics for rich accounts", () => {
    const result = canonicalizeTelegramPresentationPayload(
      {
        presentation: {
          blocks: [
            { type: "context", text: "Uptime: gateway 12s" },
            { type: "context", text: "already _emphasized_ line" },
          ],
        },
      },
      { richTables: true },
    );

    expect(result.text).toContain("_Uptime: gateway 12s_");
    expect(result.text).toContain("already _emphasized_ line");
  });

  it("replaces authored fallback text with the rich rendering when text is marked fallback", () => {
    const result = canonicalizeTelegramPresentationPayload(
      {
        text: "Plain fallback body",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Pipeline",
              headers: ["Account"],
              rows: [["Acme"]],
            },
          ],
        },
      },
      { richTables: true },
    );

    expect(result.text).toContain("<th>Account</th>");
    expect(result.text).not.toContain("Plain fallback body");
    expect(result.presentationTextMode).toBeUndefined();
  });

  it("keeps authored fallback text on plain accounts instead of the generic flatten", () => {
    const result = canonicalizeTelegramPresentationPayload({
      text: "Plain fallback body",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Pipeline",
            headers: ["Account"],
            rows: [["Acme"]],
          },
        ],
      },
    });

    expect(result.text).toBe("Plain fallback body");
    expect(result.presentation).toBeUndefined();
  });
});
