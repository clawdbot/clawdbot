import { describe, expect, it } from "vitest";
import {
  formatAllowFromLowercase,
  formatNormalizedAllowFromEntries,
  isAllowedParsedChatSender,
  isNormalizedSenderAllowed,
  mapAllowlistResolutionInputs,
} from "./allow-from.js";

function parseAllowTarget(
  entry: string,
):
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string } {
  const trimmed = entry.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("chat_id:")) {
    return { kind: "chat_id", chatId: Number.parseInt(trimmed.slice("chat_id:".length), 10) };
  }
  if (lower.startsWith("chat_guid:")) {
    return { kind: "chat_guid", chatGuid: trimmed.slice("chat_guid:".length) };
  }
  if (lower.startsWith("chat_identifier:")) {
    return {
      kind: "chat_identifier",
      chatIdentifier: trimmed.slice("chat_identifier:".length),
    };
  }
  return { kind: "handle", handle: lower };
}

describe("isAllowedParsedChatSender", () => {
  it.each([
    {
      name: "denies when allowFrom is empty",
      input: {
        allowFrom: [],
        sender: "+15551234567",
        normalizeSender: (sender: string) => sender,
        parseAllowTarget,
      },
      expected: false,
    },
    {
      name: "allows wildcard entries",
      input: {
        allowFrom: ["*"],
        sender: "user@example.com",
        normalizeSender: (sender: string) => sender.toLowerCase(),
        parseAllowTarget,
      },
      expected: true,
    },
    {
      name: "matches normalized handles",
      input: {
        allowFrom: ["User@Example.com"],
        sender: "user@example.com",
        normalizeSender: (sender: string) => sender.toLowerCase(),
        parseAllowTarget,
      },
      expected: true,
    },
    {
      name: "does not match conversation targets by default",
      input: [
        {
          allowFrom: ["chat_id:42"],
          sender: "+15551234567",
          chatId: 42,
          normalizeSender: (sender: string) => sender,
          parseAllowTarget,
        },
        {
          allowFrom: ["chat_guid:thread-42"],
          sender: "+15551234567",
          chatGuid: "thread-42",
          normalizeSender: (sender: string) => sender,
          parseAllowTarget,
        },
        {
          allowFrom: ["chat_identifier:team"],
          sender: "+15551234567",
          chatIdentifier: "team",
          normalizeSender: (sender: string) => sender,
          parseAllowTarget,
        },
      ],
      expected: [false, false, false],
    },
    {
      name: "matches conversation targets when they are enabled",
      input: [
        {
          allowFrom: ["chat_id:42"],
          sender: "+15551234567",
          chatId: 42,
          allowConversationTargets: true,
          normalizeSender: (sender: string) => sender,
          parseAllowTarget,
        },
        {
          allowFrom: ["chat_guid:thread-42"],
          sender: "+15551234567",
          chatGuid: "thread-42",
          allowConversationTargets: true,
          normalizeSender: (sender: string) => sender,
          parseAllowTarget,
        },
        {
          allowFrom: ["chat_identifier:team"],
          sender: "+15551234567",
          chatIdentifier: "team",
          allowConversationTargets: true,
          normalizeSender: (sender: string) => sender,
          parseAllowTarget,
        },
      ],
      expected: [true, true, true],
    },
  ])("$name", ({ input, expected }) => {
    if (Array.isArray(input)) {
      expect(input.map((entry) => isAllowedParsedChatSender(entry))).toEqual(expected);
      return;
    }
    expect(isAllowedParsedChatSender(input)).toBe(expected);
  });
});

describe("isNormalizedSenderAllowed", () => {
  it.each([
    {
      name: "allows wildcard",
      input: {
        senderId: "attacker",
        allowFrom: ["*"],
      },
      expected: true,
    },
    {
      name: "normalizes case and strips prefixes",
      input: {
        senderId: "12345",
        allowFrom: ["ZALO:12345", "zl:777"],
        stripPrefixRe: /^(zalo|zl):/i,
      },
      expected: true,
    },
    {
      name: "rejects when sender is missing",
      input: {
        senderId: "999",
        allowFrom: ["zl:12345"],
        stripPrefixRe: /^(zalo|zl):/i,
      },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(isNormalizedSenderAllowed(input)).toBe(expected);
  });
});

describe("formatAllowFromLowercase", () => {
  it("trims, strips prefixes, and lowercases entries", () => {
    expect(
      formatAllowFromLowercase({
        allowFrom: [" Telegram:UserA ", "tg:UserB", "  "],
        stripPrefixRe: /^(telegram|tg):/i,
      }),
    ).toEqual(["usera", "userb"]);
  });
});

describe("formatNormalizedAllowFromEntries", () => {
  it.each([
    {
      name: "applies custom normalization after trimming",
      input: {
        allowFrom: ["  @Alice ", "", " @Bob "],
        normalizeEntry: (entry: string) => entry.replace(/^@/, "").toLowerCase(),
      },
      expected: ["alice", "bob"],
    },
    {
      name: "filters empty normalized entries",
      input: {
        allowFrom: ["@", "valid"],
        normalizeEntry: (entry: string) => entry.replace(/^@$/, ""),
      },
      expected: ["valid"],
    },
  ])("$name", ({ input, expected }) => {
    expect(formatNormalizedAllowFromEntries(input)).toEqual(expected);
  });
});

describe("mapAllowlistResolutionInputs", () => {
  it("maps inputs sequentially and preserves order", async () => {
    const visited: string[] = [];
    const result = await mapAllowlistResolutionInputs({
      inputs: ["one", "two", "three"],
      mapInput: async (input) => {
        visited.push(input);
        return input.toUpperCase();
      },
    });

    expect(visited).toEqual(["one", "two", "three"]);
    expect(result).toEqual(["ONE", "TWO", "THREE"]);
  });
});
