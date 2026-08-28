// Line tests cover escaped separators inside card option values.
import type { messagingApi } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { registerLineCardCommand } from "./card-command.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData } from "./types.js";

async function runCardCommand(args: string): Promise<LineChannelData> {
  let result: unknown;
  registerLineCardCommand({
    registerCommand(command: unknown) {
      const { handler } = command as {
        handler: (ctx: { args: string; channel: string }) => Promise<unknown>;
      };
      result = handler({ channel: "line", args });
    },
  } as never);
  const payload = (await result) as { channelData: { line: LineChannelData } };
  return payload.channelData.line;
}

function cardActions(line: LineChannelData): messagingApi.Action[] {
  const flex = expectDefined(line.flexMessage, "LINE flex-message payload");
  const contents = flex.contents as messagingApi.FlexContainer;
  if (contents.type !== "bubble") {
    throw new Error("Expected the card to render a bubble");
  }
  const footer = expectDefined(contents.footer, "LINE flex-message footer");
  return footer.contents.map((component) => {
    if (component.type !== "button") {
      throw new Error("Expected the card footer to contain buttons");
    }
    return component.action;
  });
}

function cardAltText(line: LineChannelData): string {
  return expectDefined(line.flexMessage, "LINE flex-message payload").altText;
}

describe("line card option separators", () => {
  it.each([
    {
      kind: "an escaped comma inside a link",
      actions: String.raw`Open|https://example.test/a\,b`,
      expected: [{ type: "uri", label: "Open", uri: "https://example.test/a,b" }],
    },
    {
      kind: "an escaped comma inside callback data",
      actions: String.raw`Save|k=a\,b`,
      expected: [{ type: "postback", label: "Save", data: "k=a,b", displayText: "Save" }],
    },
    {
      kind: "an escaped pipe inside a label",
      actions: String.raw`A\|B|/status`,
      expected: [{ type: "message", label: "A|B", text: "/status" }],
    },
    {
      kind: "an escaped pipe inside action data",
      actions: String.raw`Open|left\|right`,
      expected: [{ type: "message", label: "Open", text: "left|right" }],
    },
    {
      kind: "an unescaped comma between two actions",
      actions: "One|/a,Two|/b",
      expected: [
        { type: "message", label: "One", text: "/a" },
        { type: "message", label: "Two", text: "/b" },
      ],
    },
    {
      kind: "a backslash that protects nothing",
      actions: String.raw`Path|C:\temp`,
      expected: [{ type: "message", label: "Path", text: String.raw`C:\temp` }],
    },
    {
      kind: "a literal backslash pair, which no option splits on",
      actions: String.raw`Path|\\server\share`,
      expected: [{ type: "message", label: "Path", text: String.raw`\\server\share` }],
    },
    {
      kind: "a literal backslash before an escaped comma",
      actions: String.raw`Path|\\,tail`,
      expected: [{ type: "message", label: "Path", text: String.raw`\,tail` }],
    },
    {
      kind: "a backslash before a colon, which actions do not split on",
      actions: String.raw`Path|C\:\temp`,
      expected: [{ type: "message", label: "Path", text: String.raw`C\:\temp` }],
    },
  ])("resolves $kind into the authored card actions", async ({ actions, expected }) => {
    expect(
      cardActions(await runCardCommand(`action "Menu" "Body" --actions "${actions}"`)),
    ).toEqual(expected);
  });

  it("keeps an escaped comma inside a buttons template action", async () => {
    const line = await runCardCommand(
      String.raw`buttons "Menu" "Body" --actions "Open|https://example.test/a\,b"`,
    );
    const message = expectDefined(
      buildTemplateMessageFromPayload(
        expectDefined(line.templateMessage, "LINE template-message payload"),
      ),
      "LINE buttons template message",
    );
    if (message.type !== "template" || message.template.type !== "buttons") {
      throw new Error("Expected a LINE buttons template");
    }

    expect(message.template.actions).toEqual([
      { type: "uri", label: "Open", uri: "https://example.test/a,b" },
    ]);
  });

  it("keeps an escaped comma inside a list item title", async () => {
    const line = await runCardCommand(String.raw`list "List" "Coffee\, large|Hot,Tea|Iced"`);
    expect(cardAltText(line)).toBe("List: Coffee, large, Tea");
  });

  it("keeps an escaped comma in a receipt name and still splits at the last colon", async () => {
    const line = await runCardCommand(
      String.raw`receipt "Receipt" "Coffee\, large:$10,Time: 10:30:$5,Window:10\:30" --total "$15"`,
    );
    expect(cardAltText(line)).toBe("Receipt: Coffee, large $10, Time: 10:30 $5, Window 10:30");
  });

  it("keeps a backslashed pipe literal in a receipt name, which receipts do not split on", async () => {
    const line = await runCardCommand(String.raw`receipt "Receipt" "A\|B:$10" --total "$10"`);
    expect(cardAltText(line)).toBe(String.raw`Receipt: A\|B $10`);
  });

  it("keeps a backslashed comma literal in a confirm label, which confirm does not split on", async () => {
    const line = await runCardCommand(
      String.raw`confirm "Ship it?" --yes "Yes\,now|go" --no "No|stop"`,
    );
    expect(line.templateMessage).toMatchObject({ confirmLabel: String.raw`Yes\,now` });
  });

  it("keeps an escaped pipe inside a confirm button label", async () => {
    const line = await runCardCommand(
      String.raw`confirm "Ship it?" --yes "Yes\|now|go" --no "No|stop"`,
    );
    expect(line.templateMessage).toEqual({
      type: "confirm",
      text: "Ship it?",
      altText: "Ship it?",
      confirmLabel: "Yes|now",
      confirmData: "go",
      cancelLabel: "No",
      cancelData: "stop",
    });
  });
});
