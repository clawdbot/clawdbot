import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";

const webAppPresentation = {
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
};

describe("Telegram outbound web app presentation", () => {
  it.each(["-1001234567890", "@channelname"])(
    "falls back to a link for non-DM target %s",
    async (to) => {
      const rendered = await telegramOutbound.renderPresentation?.({
        payload: { text: "Open app:" },
        presentation: webAppPresentation,
        ctx: { to } as never,
      });

      expect(rendered).toEqual({
        text: "Open app:\n\n- Launch: https://example.com/app",
      });
    },
  );
});
