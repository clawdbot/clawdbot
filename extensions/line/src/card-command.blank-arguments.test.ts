// Line tests cover blank /card arguments, which LINE rejects atomically.
import type { messagingApi } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { handleLineCardCommand } from "./card-command.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData } from "./types.js";

async function runCardCommand(args: string): Promise<LineChannelData> {
  const payload = (await handleLineCardCommand(args)) as { channelData: { line: LineChannelData } };
  return payload.channelData.line;
}

/**
 * Every `text` LINE requires to be non-empty in the rendered message: Flex text
 * components, a template's own text, and an action's message text. A Flex text
 * carrying styled `contents` spans instead is exempt.
 */
function requiredTextFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(requiredTextFields);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const own = typeof record.text === "string" && record.contents === undefined ? [record.text] : [];
  return [...own, ...Object.values(record).flatMap(requiredTextFields)];
}

async function renderedMessage(
  args: string,
): Promise<messagingApi.FlexMessage | messagingApi.TemplateMessage> {
  const line = await runCardCommand(args);
  if (line.flexMessage) {
    return {
      type: "flex",
      altText: line.flexMessage.altText,
      contents: line.flexMessage.contents as messagingApi.FlexContainer,
    };
  }
  const template = expectDefined(line.templateMessage, "LINE template-message payload");
  return expectDefined(buildTemplateMessageFromPayload(template), "built template message");
}

// LINE rejects the whole push when any of these is blank, so the reply is lost
// rather than degraded. Blank arguments are the reachable way to produce one.
const BLANK_ARGUMENT_INPUTS = [
  'info "Welcome"',
  "info",
  'info "" ""',
  'info "Welcome" ""',
  'action "Menu" "" --actions "Order|/order"',
  'receipt "R" "Item:"',
  'confirm ""',
  'buttons "" "" --actions "A|a"',
];

describe("/card with blank arguments", () => {
  it.each(BLANK_ARGUMENT_INPUTS)(
    "keeps every LINE-required field non-blank: /card %s",
    async (args) => {
      const message = await renderedMessage(args);

      expect(message.altText.trim()).not.toBe("");
      const texts = requiredTextFields(message);
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.filter((text) => text.trim() === "")).toEqual([]);
    },
  );

  it("renders a title-only info card when the body is omitted", async () => {
    const line = await runCardCommand('info "Welcome"');
    const flex = expectDefined(line.flexMessage, "LINE flex-message payload");

    expect(flex.altText).toBe("Welcome");
    expect(requiredTextFields(flex.contents)).toEqual(["Welcome"]);
  });

  it("treats a blank quoted argument as omitted so the defaults apply", async () => {
    const line = await runCardCommand('confirm ""');
    const template = expectDefined(line.templateMessage, "LINE template-message payload");

    expect(template).toMatchObject({ type: "confirm", text: "Confirm?", altText: "Confirm?" });
  });

  it("keeps a receipt row whose value is missing", async () => {
    const line = await runCardCommand('receipt "R" "Item:"');

    expect(requiredTextFields(expectDefined(line.flexMessage, "flex").contents)).toContain("Item");
  });

  it("still renders both parts when they are present", async () => {
    const line = await runCardCommand('info "Welcome" "Thanks for joining!"');
    const flex = expectDefined(line.flexMessage, "LINE flex-message payload");

    expect(flex.altText).toBe("Welcome: Thanks for joining!");
    expect(requiredTextFields(flex.contents)).toEqual(["Welcome", "Thanks for joining!"]);
  });
});
