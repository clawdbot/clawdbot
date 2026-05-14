import { describe, expect, it } from "vitest";
import { buildTelegramInteractiveButtons, resolveTelegramInlineButtons } from "./button-types.js";

export function describeTelegramInteractiveButtonBehavior(): void {
  describe("buildTelegramInteractiveButtons", () => {
    it("maps shared buttons and selects into Telegram inline rows", () => {
      expect(
        buildTelegramInteractiveButtons({
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "approve", style: "success" },
                { label: "Docs", url: "https://example.com/docs", style: "primary" },
                { label: "Reject", value: "reject", style: "danger" },
                { label: "Launch", webApp: { url: "https://example.com/app" } },
                { label: "Later", value: "later" },
                { label: "Archive", value: "archive" },
              ],
            },
            {
              type: "select",
              options: [{ label: "Alpha", value: "alpha" }],
            },
          ],
        }),
      ).toEqual([
        [
          { text: "Approve", callback_data: "approve", style: "success" },
          { text: "Docs", url: "https://example.com/docs", style: "primary" },
          { text: "Reject", callback_data: "reject", style: "danger" },
        ],
        [
          { text: "Launch", web_app: { url: "https://example.com/app" }, style: undefined },
          { text: "Later", callback_data: "later", style: undefined },
          { text: "Archive", callback_data: "archive", style: undefined },
        ],
        [{ text: "Alpha", callback_data: "alpha", style: undefined }],
      ]);
    });
  });

  describe("resolveTelegramInlineButtons", () => {
    it("prefers explicit buttons over shared interactive blocks", () => {
      const explicit = [[{ text: "Keep", callback_data: "keep" }]] as const;

      expect(
        resolveTelegramInlineButtons({
          buttons: explicit,
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Override", value: "override" }],
              },
            ],
          },
        }),
      ).toBe(explicit);
    });

    it("derives buttons from raw interactive payloads", () => {
      expect(
        resolveTelegramInlineButtons({
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  { label: "Retry", value: "retry", style: "primary" },
                  { label: "Docs", value: "docs", url: "https://example.com/docs" },
                ],
              },
            ],
          },
        }),
      ).toEqual([
        [
          { text: "Retry", callback_data: "retry", style: "primary" },
          { text: "Docs", url: "https://example.com/docs", style: undefined },
        ],
      ]);
    });
  });
}
