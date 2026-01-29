import { describe, it, expect } from "vitest";
import {
  resolveZoomAllowlistMatch,
  resolveZoomReplyPolicy,
  isZoomGroupAllowed,
} from "./policy.js";

describe("resolveZoomAllowlistMatch", () => {
  it("returns allowed=false for empty allowFrom", () => {
    const result = resolveZoomAllowlistMatch({
      allowFrom: [],
      senderId: "user@xmpp.zoom.us",
    });
    expect(result.allowed).toBe(false);
  });

  it("matches wildcard", () => {
    const result = resolveZoomAllowlistMatch({
      allowFrom: ["*"],
      senderId: "user@xmpp.zoom.us",
    });
    expect(result).toEqual({
      allowed: true,
      matchKey: "*",
      matchSource: "wildcard",
    });
  });

  it("matches by sender id", () => {
    const result = resolveZoomAllowlistMatch({
      allowFrom: ["user@xmpp.zoom.us"],
      senderId: "user@xmpp.zoom.us",
    });
    expect(result).toEqual({
      allowed: true,
      matchKey: "user@xmpp.zoom.us",
      matchSource: "id",
    });
  });

  it("matches by sender id case-insensitively", () => {
    const result = resolveZoomAllowlistMatch({
      allowFrom: ["USER@XMPP.ZOOM.US"],
      senderId: "user@xmpp.zoom.us",
    });
    expect(result).toEqual({
      allowed: true,
      matchKey: "user@xmpp.zoom.us",
      matchSource: "id",
    });
  });

  it("matches by sender name", () => {
    const result = resolveZoomAllowlistMatch({
      allowFrom: ["John Doe"],
      senderId: "user@xmpp.zoom.us",
      senderName: "John Doe",
    });
    expect(result).toEqual({
      allowed: true,
      matchKey: "john doe",
      matchSource: "name",
    });
  });

  it("matches by sender email", () => {
    const result = resolveZoomAllowlistMatch({
      allowFrom: ["john@example.com"],
      senderId: "user@xmpp.zoom.us",
      senderEmail: "john@example.com",
    });
    expect(result).toEqual({
      allowed: true,
      matchKey: "john@example.com",
      matchSource: "email",
    });
  });

  it("returns allowed=false when no match", () => {
    const result = resolveZoomAllowlistMatch({
      allowFrom: ["other@xmpp.zoom.us"],
      senderId: "user@xmpp.zoom.us",
      senderName: "John Doe",
      senderEmail: "john@example.com",
    });
    expect(result.allowed).toBe(false);
  });

  it("handles numeric entries in allowFrom", () => {
    const result = resolveZoomAllowlistMatch({
      allowFrom: [12345],
      senderId: "12345",
    });
    expect(result.allowed).toBe(true);
  });
});

describe("resolveZoomReplyPolicy", () => {
  it("returns requireMention=false for DMs", () => {
    const result = resolveZoomReplyPolicy({
      isDirectMessage: true,
      globalConfig: { requireMention: true },
    });
    expect(result.requireMention).toBe(false);
  });

  it("defaults to requireMention=true for channels", () => {
    const result = resolveZoomReplyPolicy({
      isDirectMessage: false,
    });
    expect(result.requireMention).toBe(true);
  });

  it("respects global config requireMention", () => {
    const result = resolveZoomReplyPolicy({
      isDirectMessage: false,
      globalConfig: { requireMention: false },
    });
    expect(result.requireMention).toBe(false);
  });

  it("channel config overrides global config", () => {
    const result = resolveZoomReplyPolicy({
      isDirectMessage: false,
      globalConfig: { requireMention: true },
      channelConfig: { requireMention: false },
    });
    expect(result.requireMention).toBe(false);
  });
});

describe("isZoomGroupAllowed", () => {
  it("returns false when groupPolicy is disabled", () => {
    const result = isZoomGroupAllowed({
      groupPolicy: "disabled",
      allowFrom: ["*"],
      senderId: "user@xmpp.zoom.us",
    });
    expect(result).toBe(false);
  });

  it("returns true when groupPolicy is open", () => {
    const result = isZoomGroupAllowed({
      groupPolicy: "open",
      allowFrom: [],
      senderId: "user@xmpp.zoom.us",
    });
    expect(result).toBe(true);
  });

  it("checks allowlist when groupPolicy is allowlist", () => {
    expect(
      isZoomGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: ["user@xmpp.zoom.us"],
        senderId: "user@xmpp.zoom.us",
      }),
    ).toBe(true);

    expect(
      isZoomGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: ["other@xmpp.zoom.us"],
        senderId: "user@xmpp.zoom.us",
      }),
    ).toBe(false);
  });

  it("supports wildcard in allowlist", () => {
    const result = isZoomGroupAllowed({
      groupPolicy: "allowlist",
      allowFrom: ["*"],
      senderId: "anyone@xmpp.zoom.us",
    });
    expect(result).toBe(true);
  });
});
