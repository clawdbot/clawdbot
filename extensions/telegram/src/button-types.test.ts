// Telegram tests cover button types plugin behavior.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { describe, expect, it } from "vitest";
import { parseTelegramApprovalCallbackData } from "./approval-callback-data.js";
import {
  buildTelegramPresentationButtons,
  resolveTelegramInlineButtons,
  type TelegramButtonBuildOptions,
} from "./button-types.js";
import { describeTelegramInteractiveButtonBehavior } from "./button-types.test-helpers.js";
import {
  buildTelegramOpaqueCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";

describeTelegramInteractiveButtonBehavior();

function questionButtonOptions(
  questions: ReadonlyArray<{ questionId: string; optionValues: readonly string[] }>,
): TelegramButtonBuildOptions {
  return {
    questionOptionIndices: new Map(
      questions.map(
        ({ questionId, optionValues }) =>
          [
            questionId,
            new Map(
              optionValues.map((value, index) => [value.trim().toLowerCase(), index] as const),
            ),
          ] as const,
      ),
    ),
  };
}

describe("buildTelegramInteractiveButtons callback limits", () => {
  it("drops buttons whose callback payload exceeds Telegram limits", () => {
    expect(
      resolveTelegramInlineButtons({
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Keep", value: "ok" },
                { label: "Drop", value: `x${"y".repeat(80)}` },
              ],
            },
          ],
        },
      }),
    ).toEqual([[{ text: "Keep", callback_data: "ok", style: undefined }]]);
  });
});

describe("resolveTelegramInlineButtons precedence", () => {
  it("returns explicit buttons without reading lower-priority payloads", () => {
    const buttons = [[{ text: "Explicit", callback_data: "explicit" }]];
    const params = {
      buttons,
      get interactive(): never {
        throw new Error("unexpected interactive normalization");
      },
      get presentation(): never {
        throw new Error("unexpected presentation normalization");
      },
    };

    expect(resolveTelegramInlineButtons(params)).toBe(buttons);
  });

  it.each([
    {
      description: "the legacy payload contains only text",
      interactive: { blocks: [{ type: "text", text: "Legacy heading" }] },
      expectedDropped: [],
    },
    {
      description: "every legacy callback exceeds the Telegram byte limit",
      interactive: {
        blocks: [{ type: "buttons", buttons: [{ label: "Oversized", value: "x".repeat(65) }] }],
      },
      expectedDropped: [
        { label: "Oversized", reason: "callback_data_too_long", callbackDataBytes: 65 },
      ],
    },
  ])("falls back to presentation buttons when $description", ({ interactive, expectedDropped }) => {
    const dropped: Array<{ label: string; reason: string; callbackDataBytes?: number }> = [];

    expect(
      resolveTelegramInlineButtons(
        {
          interactive,
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "Fallback", value: "fallback" }] }],
          },
        },
        { onDroppedControl: (control) => dropped.push(control) },
      ),
    ).toEqual([[{ text: "Fallback", callback_data: "fallback", style: undefined }]]);
    expect(dropped).toEqual(expectedDropped);
  });
});

describe("buildTelegramPresentationButtons", () => {
  it("builds inline buttons from presentation blocks", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          { type: "text", text: "Choose" },
          {
            type: "buttons",
            buttons: [{ label: "Approve", value: "/approve req-1 allow-once", style: "success" }],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Approve",
          callback_data: "/approve req-1 allow-once",
          style: "success",
        },
      ],
    ]);
  });

  it("encodes question buttons by record id and option index", () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    expect(
      buildTelegramPresentationButtons(
        {
          blocks: [
            {
              type: "buttons",
              buttons: ["Staging", "Production"].map((label) => ({
                label,
                action: { type: "question" as const, questionId, optionValue: label },
              })),
            },
          ],
        },
        questionButtonOptions([{ questionId, optionValues: ["Staging", "Production"] }]),
      ),
    ).toEqual([
      [
        { text: "Staging", callback_data: `tgq1:${questionId}:0`, style: undefined },
        { text: "Production", callback_data: `tgq1:${questionId}:1`, style: undefined },
      ],
    ]);
  });

  it("drops question buttons when authoritative Gateway option order is unavailable", () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Production",
                action: {
                  type: "question" as const,
                  questionId,
                  optionValue: "Production",
                },
              },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("keeps question option indices independent and stable across presentation blocks", () => {
    const firstQuestionId = "ask_0123456789abcdef0123456789abcdef";
    const secondQuestionId = "ask_fedcba9876543210fedcba9876543210";
    const questionButton = (questionId: string, optionValue: string) => ({
      label: optionValue,
      action: { type: "question" as const, questionId, optionValue },
    });

    const rows = buildTelegramPresentationButtons(
      {
        blocks: [
          {
            type: "buttons",
            buttons: [
              questionButton(firstQuestionId, "東京"),
              questionButton(firstQuestionId, "Déployer"),
            ],
          },
          {
            type: "buttons",
            buttons: [
              questionButton(secondQuestionId, "東京"),
              questionButton(secondQuestionId, "Production"),
            ],
          },
          {
            type: "buttons",
            buttons: [
              questionButton(firstQuestionId, "東京"),
              questionButton(firstQuestionId, "Production 🚀"),
            ],
          },
        ],
      },
      questionButtonOptions([
        {
          questionId: firstQuestionId,
          optionValues: ["東京", "Déployer", "Production 🚀"],
        },
        { questionId: secondQuestionId, optionValues: ["東京", "Production"] },
      ]),
    );

    expect(rows?.map((row) => row.map((button) => button.callback_data))).toEqual([
      [`tgq1:${firstQuestionId}:0`, `tgq1:${firstQuestionId}:1`],
      [`tgq1:${secondQuestionId}:0`, `tgq1:${secondQuestionId}:1`],
      [`tgq1:${firstQuestionId}:0`, `tgq1:${firstQuestionId}:2`],
    ]);
  });

  it("maps repeated rendered question values to their canonical Gateway option indices", () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const button = (label: string) => ({
      label,
      action: { type: "question" as const, questionId, optionValue: label },
    });

    const rows = buildTelegramPresentationButtons(
      {
        blocks: [
          { type: "buttons", buttons: [button("A"), button("A")] },
          { type: "buttons", buttons: [button("B"), button("C")] },
        ],
      },
      questionButtonOptions([{ questionId, optionValues: ["A", "B", "C"] }]),
    );

    expect(rows?.flatMap((row) => row.map((entry) => entry.callback_data))).toEqual([
      `tgq1:${questionId}:0`,
      `tgq1:${questionId}:0`,
      `tgq1:${questionId}:1`,
      `tgq1:${questionId}:2`,
    ]);
  });

  it("normalizes repeated question values with the Gateway trim and lowercase contract", () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const questionButton = (optionValue: string) => ({
      label: optionValue,
      action: { type: "question" as const, questionId, optionValue },
    });

    const rows = buildTelegramPresentationButtons(
      {
        blocks: [
          { type: "buttons", buttons: [questionButton(" Deploy "), questionButton("deploy")] },
          { type: "buttons", buttons: [questionButton("Production")] },
        ],
      },
      questionButtonOptions([{ questionId, optionValues: [" Deploy ", "Production"] }]),
    );

    expect(rows?.flatMap((row) => row.map((entry) => entry.callback_data))).toEqual([
      `tgq1:${questionId}:0`,
      `tgq1:${questionId}:0`,
      `tgq1:${questionId}:1`,
    ]);
  });

  it("does not consume a question option position when callback encoding fails", () => {
    const validQuestionId = "ask_0123456789abcdef0123456789abcdef";
    const invalidQuestionId = "not-a-gateway-question";
    const rows = buildTelegramPresentationButtons(
      {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Invalid",
                action: {
                  type: "question" as const,
                  questionId: invalidQuestionId,
                  optionValue: "Invalid",
                },
              },
              {
                label: "Valid",
                action: {
                  type: "question" as const,
                  questionId: validQuestionId,
                  optionValue: "Valid",
                },
              },
            ],
          },
        ],
      },
      questionButtonOptions([{ questionId: validQuestionId, optionValues: ["Valid", "Other"] }]),
    );

    expect(rows).toEqual([
      [{ text: "Valid", callback_data: `tgq1:${validQuestionId}:0`, style: undefined }],
    ]);
  });

  it("drops presentation buttons whose callback payload exceeds Telegram limits", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Keep",
                action: { type: "command", command: "/codex plugins menu" },
              },
              {
                label: "Drop",
                action: {
                  type: "command",
                  command: `/codex plugins enable ${"x".repeat(80)}`,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Keep",
          callback_data: "tgcmd:/codex plugins menu",
          style: undefined,
        },
      ],
    ]);
  });

  it("keeps legacy raw slash-valued callbacks as callbacks", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Raw", value: "/not-a-native-command" }],
          },
        ],
      }),
    ).toEqual([[{ text: "Raw", callback_data: "/not-a-native-command", style: undefined }]]);
  });

  it("marks typed callbacks as opaque callback data", () => {
    const callbackData = buildTelegramOpaqueCallbackData("/not-a-native-command");

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Raw", action: { type: "callback", value: "/not-a-native-command" } },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Raw", callback_data: callbackData, style: undefined }]]);
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe("/not-a-native-command");
  });

  it("keeps legacy values that look like opaque callback prefixes raw", () => {
    expect(parseTelegramOpaqueCallbackData("tgcb1:inspect:123")).toBeNull();
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Raw", value: "tgcb1:inspect:123" }],
          },
        ],
      }),
    ).toEqual([[{ text: "Raw", callback_data: "tgcb1:inspect:123", style: undefined }]]);
  });

  it("keeps transport-private approval callback prefixes opaque for legacy values", () => {
    const value = "tga1:e:x:not-a-typed-action";
    const callbackData = buildTelegramOpaqueCallbackData(value);

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Plugin", value }],
          },
        ],
      }),
    ).toEqual([[{ text: "Plugin", callback_data: callbackData, style: undefined }]]);
    expect(parseTelegramApprovalCallbackData(callbackData)).toBeNull();
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe(value);
  });

  it("keeps transport-private question callback prefixes opaque for legacy values", () => {
    const value = "tgq1:ask_0123456789abcdef0123456789abcdef:0";
    const callbackData = buildTelegramOpaqueCallbackData(value);

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Plugin", value }],
          },
        ],
      }),
    ).toEqual([[{ text: "Plugin", callback_data: callbackData, style: undefined }]]);
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe(value);
  });

  it("keeps trimmed transport-private question prefixes opaque", () => {
    const value = " tgq1:ask_0123456789abcdef0123456789abcdef:0 ";
    const callbackData = buildTelegramOpaqueCallbackData(value);

    expect(
      buildTelegramPresentationButtons({
        blocks: [{ type: "buttons", buttons: [{ label: "Plugin", value }] }],
      }),
    ).toEqual([[{ text: "Plugin", callback_data: callbackData, style: undefined }]]);
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe(value);
  });

  it("keeps shortened plugin approval callbacks on the approval bypass path", () => {
    const approvalId = `plugin:${"a".repeat(36)}`;
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Allow", value: `/approve ${approvalId} allow-always` }],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Allow",
          callback_data: `/approve ${approvalId} always`,
          style: undefined,
        },
      ],
    ]);
  });

  it("keeps typed commands distinct from typed approval callbacks", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow",
                action: { type: "command", command: "/approve req-1 allow-once" },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Allow",
          callback_data: "tgcmd:/approve req-1 allow-once",
          style: undefined,
        },
      ],
    ]);
  });

  it("shortens legacy allow-always before prefixing and retains the approval overflow path", () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const approvalId = `plugin:${"a".repeat(36)}`;

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Always",
                action: {
                  type: "command",
                  command: `/approve ${uuid} allow-always`,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Always",
          callback_data: `tgcmd:/approve ${uuid} always`,
          style: undefined,
        },
      ],
    ]);
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Always",
                action: {
                  type: "command",
                  command: `/approve ${approvalId} allow-always`,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Always",
          callback_data: `/approve ${approvalId} always`,
          style: undefined,
        },
      ],
    ]);
  });

  it("keeps approval-shaped typed callbacks opaque", () => {
    const callbackData = buildTelegramOpaqueCallbackData("/approve plugin:123 allow-once");

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Plugin",
                action: { type: "callback", value: "/approve plugin:123 allow-once" },
              },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Plugin", callback_data: callbackData, style: undefined }]]);
  });

  it("encodes typed approvals with explicit kind, decision, and exact id", () => {
    const buttons = buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow",
              action: {
                type: "approval",
                approvalId: "plugin:id/with:delimiters",
                approvalKind: "exec",
                decision: "allow-always",
              },
              style: "success",
            },
          ],
        },
      ],
    });

    expect(buttons).toEqual([
      [
        {
          text: "Allow",
          callback_data: "tga1:e:a:plugin:id/with:delimiters",
          style: "success",
        },
      ],
    ]);
    expect(parseTelegramApprovalCallbackData(buttons?.[0]?.[0]?.callback_data)).toEqual({
      type: "approval",
      approvalId: "plugin:id/with:delimiters",
      approvalKind: "exec",
      decision: "allow-always",
    });
  });

  it("compacts an overlong approval callback and keeps the Review URL", () => {
    const approvalId = "x".repeat(56);
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow",
                action: {
                  type: "approval",
                  approvalId,
                  approvalKind: "exec",
                  decision: "allow-once",
                },
              },
              {
                label: "Review",
                action: { type: "url", url: "https://gateway.example/approve/long-id" },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Allow",
          callback_data: `tga1:e:o:${buildApprovalResolutionRef({ approvalId, approvalKind: "exec" })}`,
          style: undefined,
        },
        {
          text: "Review",
          url: "https://gateway.example/approve/long-id",
          style: undefined,
        },
      ],
    ]);
  });

  it("renders typed and legacy URL and Web App actions natively", () => {
    expect(
      buildTelegramPresentationButtons(
        {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Typed URL", action: { type: "url", url: "https://example.com/typed" } },
                {
                  label: "Typed App",
                  action: { type: "web-app", url: "https://example.com/app" },
                },
                { label: "Legacy URL", url: "https://example.com/legacy" },
                { label: "Legacy App", webApp: { url: "https://example.com/legacy-app" } },
              ],
            },
          ],
        },
        { allowWebAppButtons: true },
      ),
    ).toEqual([
      [
        { text: "Typed URL", url: "https://example.com/typed", style: undefined },
        {
          text: "Typed App",
          web_app: { url: "https://example.com/app" },
          style: undefined,
        },
        { text: "Legacy URL", url: "https://example.com/legacy", style: undefined },
      ],
      [
        {
          text: "Legacy App",
          web_app: { url: "https://example.com/legacy-app" },
          style: undefined,
        },
      ],
    ]);
  });

  it("skips Web App actions unless a direct target was confirmed", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "App", action: { type: "web-app", url: "https://example.com/app" } },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("records Web App gating separately from callback overflow", () => {
    const dropped: Array<{ reason: string; callbackDataBytes?: number }> = [];
    buildTelegramPresentationButtons(
      {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "App", action: { type: "web-app", url: "https://example.com/app" } },
            ],
          },
        ],
      },
      { onDroppedControl: (control) => dropped.push(control) },
    );

    expect(dropped).toEqual([{ label: "App", reason: "web_app_unavailable" }]);
  });

  it("skips hosted widget actions without a Telegram web app URL", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Hosted widget",
                action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
              },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("lets canonical typed actions override deprecated button fields", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Open",
                action: { type: "url", url: "https://example.com/canonical" },
                value: "legacy-callback",
                url: "https://example.com/legacy",
              },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Open", url: "https://example.com/canonical", style: undefined }]]);
  });
});
