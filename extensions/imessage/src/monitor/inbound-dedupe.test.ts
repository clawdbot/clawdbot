// Imessage tests cover inbound dedupe + stale-backlog age fence behavior.
import { describe, expect, it } from "vitest";
import {
  buildIMessageInboundReplayKey,
  IMESSAGE_STALE_INBOUND_THRESHOLD_MS,
  isStaleIMessageBacklog,
} from "./inbound-dedupe.js";
import type { IMessagePayload } from "./types.js";

function payload(overrides: Partial<IMessagePayload> = {}): IMessagePayload {
  return {
    id: 1,
    guid: "GUID-1",
    sender: "+15550001111",
    chat_id: 42,
    text: "hello",
    created_at: "2026-05-30T05:23:00.000Z",
    ...overrides,
  } as IMessagePayload;
}

describe("buildIMessageInboundReplayKey", () => {
  it("prefers the GUID", () => {
    expect(buildIMessageInboundReplayKey({ accountId: "default", message: payload() })).toBe(
      "default:guid:GUID-1",
    );
  });

  it("falls back to a bounded composite key when the GUID is absent", () => {
    const key = buildIMessageInboundReplayKey({
      accountId: "default",
      message: payload({ guid: undefined }),
    });
    // Hashed composite: account-scoped prefix + 32-hex digest, length-bounded
    // regardless of message text length.
    expect(key).toMatch(/^default:c:[0-9a-f]{32}$/);
  });

  it("keeps the composite key bounded for very long text", () => {
    const key = buildIMessageInboundReplayKey({
      accountId: "default",
      message: payload({ guid: undefined, text: "x".repeat(20_000) }),
    });
    expect(key).toMatch(/^default:c:[0-9a-f]{32}$/);
    expect((key ?? "").length).toBeLessThan(60);
  });

  it("derives distinct composite keys for distinct GUID-less rows", () => {
    const a = buildIMessageInboundReplayKey({
      accountId: "default",
      message: payload({ guid: undefined, text: "hello" }),
    });
    const b = buildIMessageInboundReplayKey({
      accountId: "default",
      message: payload({ guid: undefined, text: "world" }),
    });
    expect(a).not.toBe(b);
  });

  it("returns null (fail open) when the message cannot be identified", () => {
    expect(
      buildIMessageInboundReplayKey({
        accountId: "default",
        message: payload({ guid: undefined, sender: undefined }),
      }),
    ).toBeNull();
  });

  it("scopes keys by account so two accounts never collide on the same GUID", () => {
    const a = buildIMessageInboundReplayKey({ accountId: "work", message: payload() });
    const b = buildIMessageInboundReplayKey({ accountId: "home", message: payload() });
    expect(a).not.toBe(b);
  });
});

describe("isStaleIMessageBacklog", () => {
  const now = Date.parse("2026-05-30T05:23:18.000Z");

  it("suppresses a row whose send date is well past the threshold", () => {
    expect(isStaleIMessageBacklog(payload({ created_at: "2023-08-09T03:45:59.000Z" }), now)).toBe(
      true,
    );
  });

  it("passes a fresh live row", () => {
    expect(isStaleIMessageBacklog(payload({ created_at: "2026-05-30T05:23:00.000Z" }), now)).toBe(
      false,
    );
  });

  it("uses the threshold boundary (older-than, not equal)", () => {
    const atThreshold = new Date(now - IMESSAGE_STALE_INBOUND_THRESHOLD_MS).toISOString();
    expect(isStaleIMessageBacklog(payload({ created_at: atThreshold }), now)).toBe(false);
    const pastThreshold = new Date(now - IMESSAGE_STALE_INBOUND_THRESHOLD_MS - 1).toISOString();
    expect(isStaleIMessageBacklog(payload({ created_at: pastThreshold }), now)).toBe(true);
  });

  it("fails open when the send date is missing or unparseable", () => {
    expect(isStaleIMessageBacklog(payload({ created_at: undefined }), now)).toBe(false);
    expect(isStaleIMessageBacklog(payload({ created_at: "not-a-date" }), now)).toBe(false);
  });
});
