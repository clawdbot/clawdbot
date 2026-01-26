import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isSenderTrustedForDeliveryContext,
  isDeliveryContextExpired,
  createDeliveryContext,
  normalizeDeliveryContext,
  DEFAULT_DELIVERY_CONTEXT_TTL_MS,
} from "./delivery-context.js";

describe("isSenderTrustedForDeliveryContext", () => {
  it("returns true when trustAll is set", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "+1999999999",
      allowFrom: ["+1555000001"],
      trustAll: true,
    });
    expect(result).toBe(true);
  });

  it("returns true when allowFrom is empty (open policy)", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "+1999999999",
      allowFrom: [],
    });
    expect(result).toBe(true);
  });

  it("returns true when allowFrom is undefined (open policy)", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "+1999999999",
    });
    expect(result).toBe(true);
  });

  it("returns true when allowFrom has wildcard", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "+1999999999",
      allowFrom: ["*", "+1555000001"],
    });
    expect(result).toBe(true);
  });

  it("returns true when sender is in allowFrom", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "+1555000001",
      allowFrom: ["+1555000001", "+1555000002"],
    });
    expect(result).toBe(true);
  });

  it("returns false when sender is not in allowFrom", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "+1999999999",
      allowFrom: ["+1555000001", "+1555000002"],
    });
    expect(result).toBe(false);
  });

  it("returns false when sender is null/undefined", () => {
    expect(
      isSenderTrustedForDeliveryContext({
        sender: null,
        allowFrom: ["+1555000001"],
      }),
    ).toBe(false);

    expect(
      isSenderTrustedForDeliveryContext({
        sender: undefined,
        allowFrom: ["+1555000001"],
      }),
    ).toBe(false);
  });

  it("returns false when sender is empty string", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "  ",
      allowFrom: ["+1555000001"],
    });
    expect(result).toBe(false);
  });

  it("handles number entries in allowFrom", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "123456789",
      allowFrom: [123456789, "+1555000001"],
    });
    expect(result).toBe(true);
  });

  it("trims sender and allowFrom entries for matching", () => {
    const result = isSenderTrustedForDeliveryContext({
      sender: "  +1555000001  ",
      allowFrom: ["  +1555000001  "],
    });
    expect(result).toBe(true);
  });
});

describe("isDeliveryContextExpired", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true for undefined context", () => {
    expect(isDeliveryContextExpired(undefined)).toBe(true);
  });

  it("returns false for context without updatedAt (backwards compatible)", () => {
    // Contexts without timestamps are considered valid (not expired) for backwards compatibility
    expect(isDeliveryContextExpired({ channel: "whatsapp", to: "+1555000001" })).toBe(false);
  });

  it("returns false for fresh context within TTL", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const context = {
      channel: "whatsapp",
      to: "+1555000001",
      updatedAt: now - 1000, // 1 second ago
    };
    expect(isDeliveryContextExpired(context)).toBe(false);
  });

  it("returns true for context older than default TTL (24 hours)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const context = {
      channel: "whatsapp",
      to: "+1555000001",
      updatedAt: now - DEFAULT_DELIVERY_CONTEXT_TTL_MS - 1000, // Just over 24 hours ago
    };
    expect(isDeliveryContextExpired(context)).toBe(true);
  });

  it("respects custom TTL parameter", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const oneHourMs = 60 * 60 * 1000;
    const context = {
      channel: "whatsapp",
      to: "+1555000001",
      updatedAt: now - oneHourMs - 1000, // Just over 1 hour ago
    };
    // With default TTL (24h), this should not be expired
    expect(isDeliveryContextExpired(context)).toBe(false);
    // With 1 hour TTL, this should be expired
    expect(isDeliveryContextExpired(context, oneHourMs)).toBe(true);
  });
});

describe("createDeliveryContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates context with current timestamp", () => {
    const now = 1700000000000;
    vi.setSystemTime(now);
    const context = createDeliveryContext({
      channel: "whatsapp",
      to: "+1555000001",
    });
    expect(context.channel).toBe("whatsapp");
    expect(context.to).toBe("+1555000001");
    expect(context.updatedAt).toBe(now);
  });
});

describe("normalizeDeliveryContext", () => {
  it("preserves updatedAt timestamp", () => {
    const context = normalizeDeliveryContext({
      channel: "whatsapp",
      to: "+1555000001",
      updatedAt: 1700000000000,
    });
    expect(context?.updatedAt).toBe(1700000000000);
  });

  it("handles invalid updatedAt values", () => {
    const context = normalizeDeliveryContext({
      channel: "whatsapp",
      to: "+1555000001",
      updatedAt: NaN,
    });
    expect(context?.updatedAt).toBeUndefined();
  });
});
