// Delivery context tests cover context normalization for channel delivery.
import { describe, expect, it } from "vitest";
import {
  deliveryContextKey,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "./delivery-context.js";
import {
  normalizeSessionDeliveryState,
  projectSessionDeliveryFields,
} from "./delivery-context.shared.js";

describe("delivery context helpers", () => {
  it("normalizes channel/to/accountId and drops empty contexts", () => {
    expect(
      normalizeDeliveryContext({
        channel: " demo-channel ",
        to: " +1555 ",
        accountId: " acct-1 ",
      }),
    ).toEqual({
      channel: "demo-channel",
      to: "+1555",
      accountId: "acct-1",
    });

    expect(normalizeDeliveryContext({ channel: "  " })).toBeUndefined();
  });

  it("does not inherit route fields from fallback when channels conflict", () => {
    const merged = mergeDeliveryContext(
      { channel: "demo-primary" },
      { channel: "demo-fallback", to: "channel:def", accountId: "acct", threadId: "99" },
    );

    expect(merged).toEqual({
      channel: "demo-primary",
      to: undefined,
      accountId: undefined,
    });
    expect(merged?.threadId).toBeUndefined();
  });

  it("inherits missing route fields when channels match", () => {
    const merged = mergeDeliveryContext(
      { channel: "demo-channel" },
      { channel: "demo-channel", to: "123", accountId: "acct", threadId: "99" },
    );

    expect(merged).toEqual({
      channel: "demo-channel",
      to: "123",
      accountId: "acct",
      threadId: "99",
    });
  });

  it("does not inherit route fields from a different account on the same channel", () => {
    const merged = mergeDeliveryContext(
      { channel: "telegram", accountId: "bot-a" },
      { channel: "telegram", to: "123", accountId: "bot-b", threadId: "99" },
    );

    expect(merged).toEqual({
      channel: "telegram",
      to: undefined,
      accountId: "bot-a",
    });
    expect(merged?.threadId).toBeUndefined();

    expect(
      mergeDeliveryContext(
        { accountId: "bot-a" },
        { channel: "telegram", to: "123", accountId: "bot-b", threadId: "99" },
      ),
    ).toEqual({
      channel: undefined,
      to: undefined,
      accountId: "bot-a",
    });
  });

  it("uses fallback route fields when fallback has no channel", () => {
    const merged = mergeDeliveryContext(
      { channel: "demo-channel" },
      { to: "123", accountId: "acct", threadId: "99" },
    );

    expect(merged).toEqual({
      channel: "demo-channel",
      to: "123",
      accountId: "acct",
      threadId: "99",
    });
  });

  it("builds stable keys only when channel and to are present", () => {
    expect(deliveryContextKey({ channel: "demo-channel", to: "+1555" })).toBe(
      "demo-channel|+1555||",
    );
    expect(deliveryContextKey({ channel: "demo-channel" })).toBeUndefined();
    expect(deliveryContextKey({ channel: "demo-channel", to: "+1555", accountId: "acct-1" })).toBe(
      "demo-channel|+1555|acct-1|",
    );
    expect(
      deliveryContextKey({ channel: "demo-channel", to: "channel:C1", threadId: "123.456" }),
    ).toBe("demo-channel|channel:C1||123.456");
    expect(deliveryContextKey({ channel: "telegram", to: "-100123", threadId: 42.9 })).toBe(
      "telegram|-100123||42",
    );
  });

  it("derives delivery context from a session entry", () => {
    const delivery = normalizeSessionDeliveryState({
      route: {
        channel: "slack",
        accountId: "work",
        target: { to: "channel:C123" },
        thread: { id: "177000.123" },
      },
    });
    expect(deliveryContextFromSession({ delivery })).toEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: "177000.123",
    });
  });

  it("does not reconstruct delivery from retired session fields at runtime", () => {
    expect(
      deliveryContextFromSession({
        route: {
          channel: "slack",
          target: { to: "channel:C123" },
        },
        lastChannel: "slack",
        lastTo: "channel:C123",
      } as unknown as { delivery?: never }),
    ).toBeUndefined();
  });

  it("normalizes the closed none, internal, and external states", () => {
    expect(normalizeSessionDeliveryState()).toEqual({ kind: "none" });
    expect(
      normalizeSessionDeliveryState({ context: { channel: "webchat", to: "dashboard" } }),
    ).toEqual({ kind: "internal" });

    expect(
      normalizeSessionDeliveryState({
        route: {
          channel: "Slack",
          accountId: " work ",
          target: { to: " channel:C123 ", rawTo: " slack://C123 ", chatType: "channel" },
          thread: { id: " 177000.123 ", kind: "thread", source: "target" },
        },
        context: { channel: "discord", to: "channel:old" },
        origin: { label: "Support" },
      }),
    ).toEqual({
      kind: "external",
      route: {
        channel: "slack",
        accountId: "work",
        target: { to: "channel:C123", rawTo: "slack://C123", chatType: "channel" },
        thread: { id: "177000.123", kind: "thread", source: "target" },
      },
      context: {
        channel: "slack",
        to: "channel:C123",
        accountId: "work",
        threadId: "177000.123",
      },
      origin: {
        label: "Support",
        provider: "slack",
        to: "channel:C123",
        accountId: "work",
        threadId: "177000.123",
        chatType: "channel",
      },
    });
  });

  it("projects compatibility fields without duplicating them in the session row", () => {
    const delivery = normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "-1001", accountId: "bot", threadId: 42 },
      origin: { label: "Ops" },
    });
    const expectedProjection = {
      route: {
        channel: "telegram",
        accountId: "bot",
        target: { to: "-1001" },
        thread: { id: 42 },
      },
      deliveryContext: {
        channel: "telegram",
        to: "-1001",
        accountId: "bot",
        threadId: 42,
      },
      origin: {
        label: "Ops",
        provider: "telegram",
        to: "-1001",
        accountId: "bot",
        threadId: 42,
      },
      channel: "telegram",
      lastChannel: "telegram",
      lastTo: "-1001",
      lastAccountId: "bot",
      lastThreadId: 42,
    };
    const projection = projectSessionDeliveryFields(delivery);
    expect(projection).toEqual(expectedProjection);
    expect(JSON.stringify(projection)).toBe(JSON.stringify(expectedProjection));
  });
});
