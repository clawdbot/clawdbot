// The account key the host must reproduce to address WhatsApp's durable ingress rows.
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "../channel.js";
import { setWhatsAppRuntime } from "../runtime.js";
import { resolveWhatsAppDurableAccountKey } from "./durable-account-key.js";
import { createWhatsAppDurableInboundQueue } from "./durable-receive.js";

describe("whatsapp durable account key", () => {
  it("is the id the ingress queue is actually opened under", () => {
    // Assert through the opener rather than re-deriving the hash here. A test that only
    // recomputed `sha256(...).slice(0, 24)` would stay green if the opener were changed
    // to hash differently, and every stored row would be stranded with nothing red.
    let openedWith: string | undefined;
    setWhatsAppRuntime({
      state: {
        resolveStateDir: () => "/tmp/whatsapp-account-key",
        openChannelIngressQueue: (options?: { accountId?: string }) => {
          openedWith = options?.accountId;
          return {} as never;
        },
      },
    } as never);

    createWhatsAppDurableInboundQueue("work");

    expect(openedWith).toBe(resolveWhatsAppDurableAccountKey("work"));
    expect(openedWith).not.toBe("work");
  });

  it("is declared to the host, so account removal can select those rows", () => {
    // Without this declaration `channels remove --delete` addresses the configured id,
    // matches nothing, and reports zero discarded while every row survives.
    const declared = whatsappPlugin.config.resolveDurableAccountKey;

    expect(declared).toBeDefined();
    expect(declared?.("work")).toBe(resolveWhatsAppDurableAccountKey("work"));
  });
});
