import { describe, expect, it } from "vitest";
import {
  isWhatsAppGroupJid,
  looksLikeWhatsAppTargetId,
  isWhatsAppUserTarget,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";

describe("normalizeWhatsAppTarget", () => {
  it("preserves group JIDs", () => {
    expect(normalizeWhatsAppTarget("120363401234567890@g.us")).toBe("120363401234567890@g.us");
    expect(normalizeWhatsAppTarget("123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
    expect(normalizeWhatsAppTarget("whatsapp:120363401234567890@g.us")).toBe(
      "120363401234567890@g.us",
    );
  });

  it("normalizes direct JIDs to E.164", () => {
    expect(normalizeWhatsAppTarget("1555123@s.whatsapp.net")).toBe("+1555123");
  });

  it("normalizes user JIDs with device suffix to E.164", () => {
    expect(normalizeWhatsAppTarget("41796666864:0@s.whatsapp.net")).toBe("+41796666864");
    expect(normalizeWhatsAppTarget("1234567890:123@s.whatsapp.net")).toBe("+1234567890");
    expect(normalizeWhatsAppTarget("41796666864@s.whatsapp.net")).toBe("+41796666864");
  });

  it("normalizes LID JIDs to E.164", () => {
    expect(normalizeWhatsAppTarget("123456789@lid")).toBe("+123456789");
    expect(normalizeWhatsAppTarget("123456789@LID")).toBe("+123456789");
  });

  it("rejects invalid targets", () => {
    expect(normalizeWhatsAppTarget("wat")).toBeNull();
    expect(normalizeWhatsAppTarget("whatsapp:")).toBeNull();
    expect(normalizeWhatsAppTarget("@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget("whatsapp:group:@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget("whatsapp:group:120363401234567890@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget("group:123456789-987654321@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget(" WhatsApp:Group:123456789-987654321@G.US ")).toBeNull();
    expect(normalizeWhatsAppTarget("abc@s.whatsapp.net")).toBeNull();
  });

  it("rejects non-WhatsApp provider-prefixed phone-like targets", () => {
    expect(normalizeWhatsAppTarget("telegram:1234567890")).toBeNull();
    expect(normalizeWhatsAppTarget("tg:1234567890")).toBeNull();
    expect(normalizeWhatsAppTarget("sms:+15551234567")).toBeNull();
    expect(looksLikeWhatsAppTargetId("telegram:1234567890")).toBe(false);
  });

  it("handles repeated prefixes", () => {
    expect(normalizeWhatsAppTarget("whatsapp:whatsapp:+1555")).toBe("+1555");
    expect(normalizeWhatsAppTarget("group:group:120@g.us")).toBeNull();
  });
});

describe("isWhatsAppUserTarget", () => {
  it("detects user JIDs with various formats", () => {
    expect(isWhatsAppUserTarget("41796666864:0@s.whatsapp.net")).toBe(true);
    expect(isWhatsAppUserTarget("1234567890@s.whatsapp.net")).toBe(true);
    expect(isWhatsAppUserTarget("123456789@lid")).toBe(true);
    expect(isWhatsAppUserTarget("123456789@LID")).toBe(true);
    expect(isWhatsAppUserTarget("123@lid:0")).toBe(false);
    expect(isWhatsAppUserTarget("abc@s.whatsapp.net")).toBe(false);
    expect(isWhatsAppUserTarget("123456789-987654321@g.us")).toBe(false);
    expect(isWhatsAppUserTarget("+1555123")).toBe(false);
  });
});

describe("isWhatsAppGroupJid", () => {
  it("detects group JIDs with or without prefixes", () => {
    expect(isWhatsAppGroupJid("120363401234567890@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("123456789-987654321@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:120363401234567890@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:group:120363401234567890@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("x@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("120@g.usx")).toBe(false);
    expect(isWhatsAppGroupJid("+1555123")).toBe(false);
  });
});

describe("normalizeWhatsAppMessagingTarget", () => {
  it("normalizes blank inputs to undefined", () => {
    expect(normalizeWhatsAppMessagingTarget("   ")).toBeUndefined();
  });
});

describe("looksLikeWhatsAppTargetId", () => {
  it("detects common WhatsApp target forms", () => {
    expect(looksLikeWhatsAppTargetId("whatsapp:+15555550123")).toBe(true);
    expect(looksLikeWhatsAppTargetId("15555550123@c.us")).toBe(true);
    expect(looksLikeWhatsAppTargetId("+15555550123")).toBe(true);
    expect(looksLikeWhatsAppTargetId("")).toBe(false);
  });
});
