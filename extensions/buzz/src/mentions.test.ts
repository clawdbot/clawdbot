import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  inspectBuzzMentionSyntax,
  resolveBuzzMessageMentions,
  type BuzzMentionMember,
} from "./mentions.js";

const BOT_PUBLIC_KEY = "a".repeat(64);
const ALICE_PUBLIC_KEY = "b".repeat(64);
const SECOND_ALICE_PUBLIC_KEY = "c".repeat(64);
const BOB_PUBLIC_KEY = "d".repeat(64);

function members(...values: BuzzMentionMember[]): BuzzMentionMember[] {
  return [{ publicKey: BOT_PUBLIC_KEY, displayName: "OpenClaw" }, ...values];
}

describe("Buzz outbound mentions", () => {
  it("resolves unique room-member names and preserves multi-word matching", () => {
    expect(
      resolveBuzzMessageMentions({
        text: "Thanks @Alice Example, please review.",
        members: members({ publicKey: ALICE_PUBLIC_KEY, displayName: "Alice Example" }),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([ALICE_PUBLIC_KEY]);
  });

  it("resolves a known non-ASCII room-member name without treating emails as mentions", () => {
    expect(inspectBuzzMentionSyntax("Hello @Élodie").hasAtMention).toBe(true);
    expect(
      resolveBuzzMessageMentions({
        text: "Hello @Élodie",
        members: members({ publicKey: ALICE_PUBLIC_KEY, displayName: "Élodie" }),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([ALICE_PUBLIC_KEY]);
    expect(inspectBuzzMentionSyntax("mail user@example.com")).toEqual({
      hasAtMention: false,
      hasExplicitIdentity: false,
    });
  });

  it("rejects unknown non-ASCII mention text instead of publishing it without a tag", () => {
    expect(() =>
      resolveBuzzMessageMentions({
        text: "Hello @不存在",
        members: members({ publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" }),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow("Buzz mention does not match a current room member");
  });

  it("rejects unknown and ambiguous names without an explicit identity", () => {
    expect(() =>
      resolveBuzzMessageMentions({
        text: "Hello @Missing",
        members: members({ publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" }),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow('Buzz mention "@missing" does not match a current room member');

    expect(() =>
      resolveBuzzMessageMentions({
        text: "Hello @Alice",
        members: members(
          { publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" },
          { publicKey: SECOND_ALICE_PUBLIC_KEY, displayName: "Alice" },
        ),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow(nip19.npubEncode(ALICE_PUBLIC_KEY));
  });

  it("accepts explicit NIP-27 identities and ignores presentation-only ambiguous names", () => {
    const explicit = nip19.npubEncode(ALICE_PUBLIC_KEY);
    expect(
      resolveBuzzMessageMentions({
        text: `Hello @Alice (nostr:${explicit})`,
        members: members(
          { publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" },
          { publicKey: SECOND_ALICE_PUBLIC_KEY, displayName: "Alice" },
        ),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([ALICE_PUBLIC_KEY]);
  });

  it("allows unresolved labels as presentation text when an explicit identity is present", () => {
    const explicitBob = nip19.npubEncode(BOB_PUBLIC_KEY);
    const roomMembers = members(
      { publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" },
      { publicKey: SECOND_ALICE_PUBLIC_KEY, displayName: "Alice" },
      { publicKey: BOB_PUBLIC_KEY, displayName: "Bob" },
    );

    expect(
      resolveBuzzMessageMentions({
        text: `Hello @Missing (nostr:${explicitBob})`,
        members: roomMembers,
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([BOB_PUBLIC_KEY]);

    expect(
      resolveBuzzMessageMentions({
        text: `Hello @Alice (nostr:${explicitBob})`,
        members: roomMembers,
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([BOB_PUBLIC_KEY]);
  });

  it("bounds ambiguous-member guidance", () => {
    const duplicateMembers = Array.from({ length: 8 }, (_, index) => ({
      publicKey: (index + 1).toString(16).repeat(64),
      displayName: "Alice",
    }));

    expect(() =>
      resolveBuzzMessageMentions({
        text: "Hello @Alice",
        members: members(...duplicateMembers),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow(
      `candidates: ${duplicateMembers
        .slice(0, 5)
        .map((member) => nip19.npubEncode(member.publicKey))
        .join(", ")}, and 3 more.`,
    );
  });

  it("rejects explicit identities outside the room and excludes the bot identity", () => {
    const outsider = "d".repeat(64);
    expect(() =>
      resolveBuzzMessageMentions({
        text: `nostr:${nip19.npubEncode(outsider)}`,
        members: members({ publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" }),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow("is not a current room member");

    expect(
      resolveBuzzMessageMentions({
        text: `nostr:${nip19.npubEncode(BOT_PUBLIC_KEY)}`,
        members: members(),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([]);
  });

  it("does not resolve mention-like text inside Markdown code regions", () => {
    expect(
      resolveBuzzMessageMentions({
        text: "`@Alice`\n```\nnostr:npub1invalid\n```",
        members: undefined,
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([]);
  });

  it("rejects messages above the native mention limit", () => {
    const mentionedMembers = Array.from({ length: 51 }, (_, index) => {
      const publicKey = (index + 1).toString(16).padStart(64, "0");
      return {
        publicKey,
        displayName: `Member${index + 1}`,
      };
    });

    expect(() =>
      resolveBuzzMessageMentions({
        text: mentionedMembers.map((member) => `@${member.displayName}`).join(" "),
        members: members(...mentionedMembers),
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toThrow("Buzz messages support at most 50 mentions");
  });
});
