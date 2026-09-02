import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getSlackClient,
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
} from "./monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./monitor/provider.js");
const { replyMock } = getSlackTestState();

beforeEach(() => {
  resetInboundDedupe();
  resetSlackTestState();
});

describe("Slack inbound native mentions", () => {
  const mentionSection = {
    type: "rich_text_section",
    elements: [
      { type: "text", text: "Ask " },
      { type: "user", user_id: "UTARGET" },
      { type: "text", text: " now" },
    ],
  };

  it.each([
    { name: "text-only message", text: "Ask <@UTARGET> now", blocks: undefined },
    {
      name: "mirrored rich-text message",
      text: "Ask <@UTARGET> now",
      blocks: [{ type: "rich_text", elements: [mentionSection] }],
    },
    {
      name: "rich-text message with truncated fallback",
      text: "Ask",
      blocks: [{ type: "rich_text", elements: [mentionSection] }],
    },
    {
      name: "nested rich-text list",
      text: "Ask",
      blocks: [
        {
          type: "rich_text",
          elements: [{ type: "rich_text_list", style: "bullet", elements: [mentionSection] }],
        },
      ],
    },
    {
      name: "literal mention-shaped rich text",
      text: "Ask",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "Ask <@UTARGET> now" }],
            },
          ],
        },
      ],
      expected: "Ask &lt;@UTARGET&gt; now",
    },
  ])(
    "preserves mention semantics for $name before model dispatch",
    async ({ text, blocks, expected }) => {
      getSlackClient().users.info.mockResolvedValue({
        user: { profile: { display_name: "Target Person" } },
      });
      await runSlackMessageOnce(
        monitorSlackProvider,
        {
          event: {
            type: "message",
            channel: "D12345678",
            channel_type: "im",
            user: "USENDER",
            ts: "1787800000.000100",
            text,
            blocks,
          },
        },
        { awaitDispatch: true },
      );

      expect(replyMock).toHaveBeenCalledTimes(1);
      expect(replyMock.mock.calls[0]?.[0]).toMatchObject({
        RawBody: expected ?? "Ask <@UTARGET> (Target Person) now",
      });
    },
  );
});
