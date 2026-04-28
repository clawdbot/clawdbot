import { describe, expect, it } from "vitest";
import {
  channelRouteCompactKey,
  channelRouteDedupeKey,
  channelRouteIdentityKey,
  channelRouteKey,
  channelRouteTargetsMatchExact,
  channelRouteTargetsShareConversation,
  channelRoutesMatchExact,
  channelRoutesShareConversation,
  normalizeChannelRouteRef,
  resolveChannelRouteTargetWithParser,
  stringifyRouteThreadId,
} from "./channel-route.js";

describe("plugin-sdk channel-route", () => {
  it("normalizes target, account, and thread fields", () => {
    expect(
      normalizeChannelRouteRef({
        channel: " Slack ",
        accountId: " Work ",
        rawTo: " channel:C1 ",
        to: " C1 ",
        threadId: " 171234.567 ",
      }),
    ).toEqual({
      channel: "slack",
      accountId: "work",
      target: {
        rawTo: "channel:C1",
        to: "C1",
      },
      thread: {
        id: "171234.567",
      },
    });
  });

  it("normalizes numeric thread ids for route keys", () => {
    const route = normalizeChannelRouteRef({
      channel: "telegram",
      to: "-100123",
      threadId: 42.9,
    });

    expect(stringifyRouteThreadId(route?.thread?.id)).toBe("42");
    expect(channelRouteCompactKey(route)).toBe("telegram|-100123||42");
    expect(channelRouteKey(route)).toBe(channelRouteCompactKey(route));
  });

  it("builds compact route keys from raw route-like input", () => {
    expect(
      channelRouteCompactKey({
        channel: " Slack ",
        to: " C1 ",
        accountId: " Work ",
        threadId: " 171234.567 ",
      }),
    ).toBe("slack|C1|work|171234.567");
  });

  it("builds a stable dedupe key from route-like input", () => {
    expect(
      channelRouteDedupeKey({
        channel: " Telegram ",
        to: " -100123 ",
        accountId: " Work ",
        threadId: 42.9,
      }),
    ).toBe(
      channelRouteDedupeKey({
        channel: "telegram",
        to: "-100123",
        accountId: "work",
        threadId: "42",
      }),
    );
  });

  it("keeps deprecated identity key alias wired to the dedupe key", () => {
    const input = {
      channel: "telegram",
      to: "-100123",
      accountId: "work",
      threadId: "42",
    };
    expect(channelRouteIdentityKey(input)).toBe(channelRouteDedupeKey(input));
  });

  it("matches exact routes when numeric and string thread ids are equivalent", () => {
    expect(
      channelRoutesMatchExact({
        left: normalizeChannelRouteRef({
          channel: "telegram",
          to: "-100123",
          threadId: 42,
        }),
        right: normalizeChannelRouteRef({
          channel: "telegram",
          to: "-100123",
          threadId: "42",
        }),
      }),
    ).toBe(true);
    expect(
      channelRouteTargetsMatchExact({
        left: {
          channel: "telegram",
          to: "-100123",
          threadId: 42,
        },
        right: {
          channel: "telegram",
          to: "-100123",
          threadId: "42",
        },
      }),
    ).toBe(true);
  });

  it("requires account equality for exact route matches", () => {
    expect(
      channelRouteTargetsMatchExact({
        left: {
          channel: "telegram",
          to: "-100123",
          accountId: "work",
        },
        right: {
          channel: "telegram",
          to: "-100123",
        },
      }),
    ).toBe(false);
  });

  it("shares conversation when one side is the parent route", () => {
    expect(
      channelRoutesShareConversation({
        left: normalizeChannelRouteRef({
          channel: "slack",
          to: "channel:C1",
          threadId: "171234.567",
        }),
        right: normalizeChannelRouteRef({
          channel: "slack",
          to: "channel:C1",
        }),
      }),
    ).toBe(true);
    expect(
      channelRouteTargetsShareConversation({
        left: {
          channel: "slack",
          to: "channel:C1",
          threadId: "171234.567",
        },
        right: {
          channel: "slack",
          to: "channel:C1",
        },
      }),
    ).toBe(true);
  });

  it("does not share different child threads", () => {
    expect(
      channelRoutesShareConversation({
        left: normalizeChannelRouteRef({
          channel: "matrix",
          to: "room:!abc:example.org",
          threadId: "$root-1",
        }),
        right: normalizeChannelRouteRef({
          channel: "matrix",
          to: "room:!abc:example.org",
          threadId: "$root-2",
        }),
      }),
    ).toBe(false);
  });

  it("resolves parsed route targets through an injected channel grammar", () => {
    expect(
      resolveChannelRouteTargetWithParser({
        channel: "Mock",
        rawTarget: " room-a:topic:77 ",
        fallbackThreadId: 11,
        parseExplicitTarget: (_channel, rawTarget) => {
          const match = /^(.*):topic:(\d+)$/u.exec(rawTarget);
          return match
            ? { to: match[1] ?? rawTarget, threadId: Number.parseInt(match[2] ?? "", 10) }
            : null;
        },
      }),
    ).toEqual({
      channel: "mock",
      rawTo: "room-a:topic:77",
      to: "room-a",
      threadId: 77,
      chatType: undefined,
    });
  });
});
