import { beforeEach, describe, expect, it } from "vitest";
import type { MoltbotConfig } from "../../config/config.js";

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import { resolveOutboundTarget, resolveSessionDeliveryTarget } from "./targets.js";

describe("resolveOutboundTarget", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
        { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
      ]),
    );
  });

  it("falls back to whatsapp allowFrom via config", () => {
    const cfg: MoltbotConfig = {
      channels: { whatsapp: { allowFrom: ["+1555"] } },
    };
    const res = resolveOutboundTarget({
      channel: "whatsapp",
      to: "",
      cfg,
      mode: "explicit",
    });
    expect(res).toEqual({ ok: true, to: "+1555" });
  });

  it.each([
    {
      name: "normalizes whatsapp target when provided",
      input: { channel: "whatsapp" as const, to: " (555) 123-4567 " },
      expected: { ok: true as const, to: "+5551234567" },
    },
    {
      name: "keeps whatsapp group targets",
      input: { channel: "whatsapp" as const, to: "120363401234567890@g.us" },
      expected: { ok: true as const, to: "120363401234567890@g.us" },
    },
    {
      name: "normalizes prefixed/uppercase whatsapp group targets",
      input: {
        channel: "whatsapp" as const,
        to: " WhatsApp:120363401234567890@G.US ",
      },
      expected: { ok: true as const, to: "120363401234567890@g.us" },
    },
    {
      name: "falls back to whatsapp allowFrom",
      input: { channel: "whatsapp" as const, to: "", allowFrom: ["+1555"] },
      expected: { ok: true as const, to: "+1555" },
    },
    {
      name: "normalizes whatsapp allowFrom fallback targets",
      input: {
        channel: "whatsapp" as const,
        to: "",
        allowFrom: ["whatsapp:(555) 123-4567"],
      },
      expected: { ok: true as const, to: "+5551234567" },
    },
    {
      name: "rejects invalid whatsapp target",
      input: { channel: "whatsapp" as const, to: "wat" },
      expectedErrorIncludes: "WhatsApp",
    },
    {
      name: "rejects whatsapp without to when allowFrom missing",
      input: { channel: "whatsapp" as const, to: " " },
      expectedErrorIncludes: "WhatsApp",
    },
    {
      name: "rejects whatsapp allowFrom fallback when invalid",
      input: { channel: "whatsapp" as const, to: "", allowFrom: ["wat"] },
      expectedErrorIncludes: "WhatsApp",
    },
  ])("$name", ({ input, expected, expectedErrorIncludes }) => {
    const res = resolveOutboundTarget(input);
    if (expected) {
      expect(res).toEqual(expected);
      return;
    }
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain(expectedErrorIncludes);
    }
  });

  it("rejects telegram with missing target", () => {
    const res = resolveOutboundTarget({ channel: "telegram", to: " " });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("Telegram");
    }
  });

  it("rejects webchat delivery", () => {
    const res = resolveOutboundTarget({ channel: "webchat", to: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("WebChat");
    }
  });
});

describe("resolveSessionDeliveryTarget", () => {
  it("derives implicit delivery from the last route", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        lastChannel: " whatsapp ",
        lastTo: " +1555 ",
        lastAccountId: " acct-1 ",
      },
      requestedChannel: "last",
    });

    expect(resolved).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "acct-1",
      threadId: undefined,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: "acct-1",
      lastThreadId: undefined,
    });
  });

  it("prefers explicit targets without reusing lastTo", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-2",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "telegram",
    });

    expect(resolved).toEqual({
      channel: "telegram",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("allows mismatched lastTo when configured", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-3",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "telegram",
      allowMismatchedLastTo: true,
    });

    expect(resolved).toEqual({
      channel: "telegram",
      to: "+1555",
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("falls back to a provided channel when requested is unsupported", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-4",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "webchat",
      fallbackChannel: "slack",
    });

    expect(resolved).toEqual({
      channel: "slack",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });
});
