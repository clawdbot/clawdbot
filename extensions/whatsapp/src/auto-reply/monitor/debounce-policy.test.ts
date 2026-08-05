import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { resolveWhatsAppConversationDebounceMs } from "./debounce-policy.js";

function resolve(cfg: OpenClawConfig, kind: "direct" | "group", id: string): number {
  return resolveWhatsAppConversationDebounceMs({
    cfg,
    msg: createTestWebInboundMessage({ admission: { conversation: { kind, id } } }),
  });
}

describe("resolveWhatsAppConversationDebounceMs", () => {
  it.each([
    ["exact direct", "direct", "+15551234567", 0],
    ["wildcard direct", "direct", "+15550001111", 750],
    ["exact group", "group", "456@g.us", 1200],
    ["wildcard group", "group", "789@g.us", 1500],
  ] as const)("uses the %s override", (_label, kind, id, expected) => {
    const cfg: OpenClawConfig = {
      messages: { inbound: { byChannel: { whatsapp: 3000 } } },
      channels: {
        whatsapp: {
          direct: {
            "+15551234567": { debounceMs: 0 },
            "*": { debounceMs: 750 },
          },
          groups: {
            "456@g.us": { debounceMs: 1200 },
            "*": { debounceMs: 1500 },
          },
        },
      },
    };

    expect(resolve(cfg, kind, id)).toBe(expected);
  });

  it("reads the current channel fallback when no conversation entry matches", () => {
    const cfg: OpenClawConfig = {
      messages: { inbound: { byChannel: { whatsapp: 444 } } },
      channels: { whatsapp: { direct: {} } },
    };

    expect(resolve(cfg, "direct", "+15550001111")).toBe(444);
    cfg.messages!.inbound!.byChannel!.whatsapp = 222;
    expect(resolve(cfg, "direct", "+15550001111")).toBe(222);
  });
});
