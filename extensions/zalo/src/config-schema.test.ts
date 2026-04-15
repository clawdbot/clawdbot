import { describe, expect, it } from "vitest";
import { ZaloConfigSchema } from "./config-schema.js";

describe("ZaloConfigSchema SecretInput", () => {
  it("accepts SecretRef botToken and webhookSecret at top-level", () => {
    const result = ZaloConfigSchema.safeParse({
      botToken: { source: "env", provider: "default", id: "ZALO_BOT_TOKEN" },
      webhookUrl: "https://example.com/zalo",
      webhookSecret: { source: "env", provider: "default", id: "ZALO_WEBHOOK_SECRET" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botToken and webhookSecret on account", () => {
    const result = ZaloConfigSchema.safeParse({
      accounts: {
        work: {
          botToken: { source: "env", provider: "default", id: "ZALO_WORK_BOT_TOKEN" },
          webhookUrl: "https://example.com/zalo/work",
          webhookSecret: {
            source: "env",
            provider: "default",
            id: "ZALO_WORK_WEBHOOK_SECRET",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
