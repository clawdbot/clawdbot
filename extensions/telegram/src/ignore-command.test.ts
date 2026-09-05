import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { resolveTelegramIgnoreDisposition } from "./ignore-command.js";

function commandMessage(text: string, overrides: Partial<Message> = {}): Message {
  const token = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/.exec(text)?.[0];
  return {
    chat: { id: 42, type: "group", title: "Ops" },
    message_id: 1,
    date: 1_736_371_600,
    from: { id: 7, is_bot: false, first_name: "Ada" },
    text,
    entities: token ? [{ type: "bot_command", offset: 0, length: token.length }] : [],
    ...overrides,
  } as Message;
}

describe("resolveTelegramIgnoreDisposition", () => {
  it.each([
    ["/ignore keep this out", "OurBot", "drop"],
    ["/ignore", "OurBot", "help"],
    ["/ignore@OurBot hidden", "OurBot", "drop"],
    ["/ignore@OtherBot hidden", "OurBot", "keep"],
    ["/ignoreme", "OurBot", "keep"],
  ] as const)("classifies %s", (text, botUsername, expected) => {
    expect(resolveTelegramIgnoreDisposition(commandMessage(text), botUsername)).toBe(expected);
  });

  it("supports caption commands", () => {
    const msg = commandMessage("", {
      text: undefined,
      entities: undefined,
      caption: "/ignore hidden photo",
      caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
    });
    expect(resolveTelegramIgnoreDisposition(msg, "OurBot")).toBe("drop");
  });

  it("keeps text without a leading command entity", () => {
    expect(
      resolveTelegramIgnoreDisposition(
        commandMessage("/ignore hidden", { entities: [] }),
        "OurBot",
      ),
    ).toBe("keep");
  });

  it("keeps forwarded command-shaped content", () => {
    const msg = commandMessage("/ignore hidden", {
      forward_origin: {
        type: "user",
        date: 1_736_371_000,
        sender_user: { id: 9, is_bot: false, first_name: "Nora" },
      },
    });
    expect(resolveTelegramIgnoreDisposition(msg, "OurBot")).toBe("keep");
  });
});
