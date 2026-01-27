import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { hasControlCommand, hasInlineCommandTokens } from "./command-detection.js";
import { listChatCommands } from "./commands-registry.js";
import { parseActivationCommand } from "./group-activation.js";
import { parseSendPolicyCommand } from "./send-policy.js";
import type { MsgContext } from "./templating.js";

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("resolveCommandAuthorization", () => {
  it("falls back from empty SenderId to SenderE164", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+123"] } },
    } as MoltbotConfig;

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
    } as MoltbotConfig;

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
    } as MoltbotConfig;

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
    } as MoltbotConfig;

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
    } as MoltbotConfig;

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

describe("control command parsing", () => {
  it("requires slash for send policy", () => {
    expect(parseSendPolicyCommand("/send on")).toEqual({
      hasCommand: true,
      mode: "allow",
    });
    expect(parseSendPolicyCommand("/send: on")).toEqual({
      hasCommand: true,
      mode: "allow",
    });
    expect(parseSendPolicyCommand("/send")).toEqual({ hasCommand: true });
    expect(parseSendPolicyCommand("/send:")).toEqual({ hasCommand: true });
    expect(parseSendPolicyCommand("send on")).toEqual({ hasCommand: false });
    expect(parseSendPolicyCommand("send")).toEqual({ hasCommand: false });
  });

  it("requires slash for activation", () => {
    expect(parseActivationCommand("/activation mention")).toEqual({
      hasCommand: true,
      mode: "mention",
    });
    expect(parseActivationCommand("/activation: mention")).toEqual({
      hasCommand: true,
      mode: "mention",
    });
    expect(parseActivationCommand("/activation:")).toEqual({
      hasCommand: true,
    });
    expect(parseActivationCommand("activation mention")).toEqual({
      hasCommand: false,
    });
  });

  it("treats bare commands as non-control", () => {
    expect(hasControlCommand("send")).toBe(false);
    expect(hasControlCommand("help")).toBe(false);
    expect(hasControlCommand("/commands")).toBe(true);
    expect(hasControlCommand("/commands:")).toBe(true);
    expect(hasControlCommand("commands")).toBe(false);
    expect(hasControlCommand("/status")).toBe(true);
    expect(hasControlCommand("/status:")).toBe(true);
    expect(hasControlCommand("status")).toBe(false);
    expect(hasControlCommand("usage")).toBe(false);

    for (const command of listChatCommands()) {
      for (const alias of command.textAliases) {
        expect(hasControlCommand(alias)).toBe(true);
        expect(hasControlCommand(`${alias}:`)).toBe(true);
      }
    }
    expect(hasControlCommand("/compact")).toBe(true);
    expect(hasControlCommand("/compact:")).toBe(true);
    expect(hasControlCommand("compact")).toBe(false);
  });

  it("respects disabled config/debug commands", () => {
    const cfg = { commands: { config: false, debug: false } };
    expect(hasControlCommand("/config show", cfg)).toBe(false);
    expect(hasControlCommand("/debug show", cfg)).toBe(false);
  });

  it("requires commands to be the full message", () => {
    expect(hasControlCommand("hello /status")).toBe(false);
    expect(hasControlCommand("/status please")).toBe(false);
    expect(hasControlCommand("prefix /send on")).toBe(false);
    expect(hasControlCommand("/send on")).toBe(true);
  });

  it("detects inline command tokens", () => {
    expect(hasInlineCommandTokens("hello /status")).toBe(true);
    expect(hasInlineCommandTokens("hey /think high")).toBe(true);
    expect(hasInlineCommandTokens("plain text")).toBe(false);
    expect(hasInlineCommandTokens("http://example.com/path")).toBe(false);
    expect(hasInlineCommandTokens("stop")).toBe(false);
  });

  it("ignores telegram commands addressed to other bots", () => {
    expect(
      hasControlCommand("/help@otherbot", undefined, {
        botUsername: "moltbot",
      }),
    ).toBe(false);
    expect(
      hasControlCommand("/help@moltbot", undefined, {
        botUsername: "moltbot",
      }),
    ).toBe(true);
  });
});
