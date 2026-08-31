// The account key the host must reproduce to address WhatsApp's durable ingress rows.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "../channel.js";
import { resolveWhatsAppDurableAccountKey } from "./durable-account-key.js";

describe("whatsapp durable account key", () => {
  it("is the hash the ingress queue is opened under, not the configured id", () => {
    const accountId = "work";
    const stored = resolveWhatsAppDurableAccountKey(accountId);

    expect(stored).not.toBe(accountId);
    // Pinned against the construction `createWhatsAppDurableInboundQueue` passes, so a
    // change to either side that is not made to both turns this red rather than
    // silently stranding every stored row.
    expect(stored).toBe(createHash("sha256").update(accountId).digest("hex").slice(0, 24));
  });

  it("is declared to the host, so account removal can select those rows", () => {
    // Without this declaration `channels remove --delete` addresses the configured id,
    // matches nothing, and reports zero discarded while every row survives.
    const declared = whatsappPlugin.config.resolveDurableAccountKey;

    expect(declared).toBeDefined();
    expect(declared?.("work")).toBe(resolveWhatsAppDurableAccountKey("work"));
  });
});
