// Imessage test support covers stale-backlog age fence behavior.
import { describe, expect, it } from "vitest";
import { IMESSAGE_STALE_INBOUND_THRESHOLD_MS, isStaleIMessageBacklog } from "./inbound-dedupe.js";
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
