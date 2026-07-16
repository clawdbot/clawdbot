// Telegram tests cover button types plugin behavior.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { describe, expect, it } from "vitest";
import { parseTelegramApprovalCallbackData } from "./approval-callback-data.js";
import { buildTelegramPresentationButtons, resolveTelegramInlineButtons } from "./button-types.js";
import { describeTelegramInteractiveButtonBehavior } from "./button-types.test-helpers.js";
import {
  buildTelegramOpaqueCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";

describeTelegramInteractiveButtonBehavior();

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
      buildTelegramPresentationButtons({
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
      }),
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
