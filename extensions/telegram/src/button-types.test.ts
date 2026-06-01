import { describe, expect, it } from "vitest";
import {
  buildTelegramInteractiveButtons,
  buildTelegramPresentationButtons,
} from "./button-types.js";
import { describeTelegramInteractiveButtonBehavior } from "./button-types.test-helpers.js";
import {
  buildTelegramOpaqueCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";

describeTelegramInteractiveButtonBehavior();

describe("buildTelegramInteractiveButtons callback limits", () => {
  it("drops buttons whose callback payload exceeds Telegram limits", () => {
    expect(
      buildTelegramInteractiveButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Keep", value: "ok" },
              { label: "Drop", value: `x${"y".repeat(80)}` },
            ],
          },
        ],
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

  it("keeps typed approval commands on the compact approval bypass path", () => {
    const approvalId = `plugin:${"a".repeat(36)}`;
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow",
                action: { type: "command", command: `/approve ${approvalId} allow-always` },
              },
            ],
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
});
