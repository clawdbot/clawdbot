import { describe, expect, it } from "vitest";
import { buildTelegramInteractiveButtons } from "./button-types.js";
import { describeTelegramInteractiveButtonBehavior } from "./button-types.test-helpers.js";

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
