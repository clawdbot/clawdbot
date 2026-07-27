import { finalizeEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { buildBuzzMessageTags, parseBuzzMessageEvent } from "./message-event.js";
import { parseBuzzAuthTag } from "./relay-auth.js";

const SECRET_KEY = Uint8Array.from(
  Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
);

describe("Buzz message events", () => {
  it("parses NIP-29 channel and NIP-10 thread tags", () => {
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1_700_000_000,
        content: "hello OpenClaw",
        tags: [
          ["h", "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"],
          ["e", "root-id", "", "root"],
          ["e", "reply-id", "", "reply"],
          ["p", "mentioned-pubkey"],
        ],
      },
      SECRET_KEY,
    );

    expect(parseBuzzMessageEvent(event)).toMatchObject({
      id: event.id,
      text: "hello OpenClaw",
      channelId: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
      threadId: "root-id",
      replyToId: "reply-id",
      mentionedPubkeys: ["mentioned-pubkey"],
    });
  });

  it("ignores non-channel events", () => {
    const event = finalizeEvent(
      { kind: 9, created_at: 1_700_000_000, content: "hello", tags: [] },
      SECRET_KEY,
    );
    expect(parseBuzzMessageEvent(event)).toBeNull();
  });

  it("builds direct and nested reply tags like the Buzz SDK", () => {
    expect(
      buildBuzzMessageTags({
        channelId: "channel-id",
        threadId: "root-id",
      }),
    ).toEqual([
      ["h", "channel-id"],
      ["e", "root-id", "", "reply"],
    ]);
    expect(
      buildBuzzMessageTags({
        channelId: "channel-id",
        threadId: "root-id",
        replyToId: "parent-id",
      }),
    ).toEqual([
      ["h", "channel-id"],
      ["e", "root-id", "", "root"],
      ["e", "parent-id", "", "reply"],
    ]);
  });

  it("validates the Buzz NIP-OA authentication tag shape", () => {
    expect(parseBuzzAuthTag('["auth","pubkey","kind=9","signature"]')).toEqual([
      "auth",
      "pubkey",
      "kind=9",
      "signature",
    ]);
    expect(() => parseBuzzAuthTag('["token","value"]')).toThrow("Buzz authTag must be");
  });
});
