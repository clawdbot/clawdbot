import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";

describe("resolveCommandAuthorization", () => {
  it("falls back from empty SenderId to SenderE164", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+123"] } },
    } as ClawdbotConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+999",
      SenderId: "",
      SenderE164: "+123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+123");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("falls back from whitespace SenderId to SenderE164", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+123"] } },
    } as ClawdbotConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+999",
      SenderId: "   ",
      SenderE164: "+123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+123");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("falls back to From when SenderId and SenderE164 are whitespace", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+999"] } },
    } as ClawdbotConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+999",
      SenderId: "   ",
      SenderE164: "   ",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+999");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("falls back from un-normalizable SenderId to SenderE164", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+123"] } },
    } as ClawdbotConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+999",
      SenderId: "wat",
      SenderE164: "+123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+123");
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("prefers SenderE164 when SenderId does not match allowFrom", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+41796666864"] } },
    } as ClawdbotConfig;

    const ctx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:120363401234567890@g.us",
      SenderId: "123@lid",
      SenderE164: "+41796666864",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderId).toBe("+41796666864");
    expect(auth.isAuthorizedSender).toBe(true);
  });
});
