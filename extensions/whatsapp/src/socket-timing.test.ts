import { describe, expect, it } from "vitest";
import { DEFAULT_WHATSAPP_SOCKET_TIMING, resolveWhatsAppSocketTiming } from "./socket-timing.js";

describe("resolveWhatsAppSocketTiming", () => {
  it("uses OpenClaw's explicit WhatsApp Web socket defaults", () => {
    expect(resolveWhatsAppSocketTiming({})).toEqual(DEFAULT_WHATSAPP_SOCKET_TIMING);
  });

  it("reads Baileys timing values from web.whatsapp config", () => {
    expect(
      resolveWhatsAppSocketTiming({
        web: {
          whatsapp: {
            keepAliveIntervalMs: 10_000,
            connectTimeoutMs: 90_000,
            defaultQueryTimeoutMs: 120_000,
          },
        },
      }),
    ).toEqual({
      keepAliveIntervalMs: 10_000,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 120_000,
    });
  });

  it("lets call-site overrides take precedence over config", () => {
    expect(
      resolveWhatsAppSocketTiming(
        {
          web: {
            whatsapp: {
              keepAliveIntervalMs: 10_000,
              connectTimeoutMs: 90_000,
              defaultQueryTimeoutMs: 120_000,
            },
          },
        },
        {
          keepAliveIntervalMs: 20_000,
        },
      ),
    ).toEqual({
      keepAliveIntervalMs: 20_000,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 120_000,
    });
  });
});
