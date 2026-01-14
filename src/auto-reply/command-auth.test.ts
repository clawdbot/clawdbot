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
      whatsapp: { allowFrom: ["+123"] },
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
      whatsapp: { allowFrom: ["+999"] },
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
});
