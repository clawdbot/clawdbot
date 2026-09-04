import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultActionOptions,
  discordConfig,
  expectDiscordActionCall,
  handleDiscordActionMock,
  handleDiscordMessageAction,
} from "./handle-action.test-support.js";

describe("handleDiscordMessageAction presentations", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("downgrades chart-only presentations to Discord component text", async () => {
    const cfg = discordConfig();

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "bar",
              title: "Revenue",
              categories: ["Q1", "Q2"],
              series: [{ name: "USD", values: [12, 18] }],
            },
          ],
        },
      },
      cfg,
    });

    expectDiscordActionCall({
      payload: {
        action: "sendMessage",
        accountId: undefined,
        to: "channel:123",
        content: "",
        mediaUrl: undefined,
        filename: undefined,
        replyTo: undefined,
        components: {
          blocks: [
            {
              type: "text",
              text: "-# Revenue (bar chart)\n- USD: Q1: 12; Q2: 18",
            },
          ],
        },
        embeds: undefined,
        asVoice: false,
        silent: false,
        __sessionKey: undefined,
        __agentId: undefined,
      },
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("downgrades oversized table presentations to complete text", async () => {
    const cfg = discordConfig();
    const authoredText = `${"x".repeat(1997)}AUTHORED_TAIL`;

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        presentation: {
          title: authoredText,
          blocks: [
            { type: "text", text: authoredText },
            { type: "context", text: authoredText },
            {
              type: "buttons",
              buttons: [{ label: `${"x".repeat(80)}LABEL_TAIL`, value: "choice" }],
            },
            {
              type: "table",
              caption: "Large pipeline",
              headers: ["Account", "Stage"],
              rows: Array.from({ length: 900 }, (_entry, index) => [
                `account-${String(index)}-${"x".repeat(80)}`,
                "Review",
              ]),
            },
          ],
        },
      },
      cfg,
    });

    const [call] = handleDiscordActionMock.mock.calls;
    const payload = call?.[0] as Record<string, unknown> | undefined;
    expect(payload?.components).toBeUndefined();
    expect(payload?.content).toEqual(expect.stringContaining("account-0-"));
    expect(payload?.content).toEqual(expect.stringContaining("account-899-"));
    expect(String(payload?.content).split("AUTHORED_TAIL")).toHaveLength(4);
    expect(payload?.content).toEqual(expect.stringContaining("LABEL_TAIL"));
  });
});
