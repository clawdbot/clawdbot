import { describe, expect, it } from "vitest";
import { resolveClickClackAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("ClickClack account resolution", () => {
  it("resolves env SecretRefs at runtime", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            service: {
              token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(
      resolveClickClackAccount({
        cfg,
        accountId: "service",
        env: { CLICKCLACK_SERVICE_TOKEN: "  ccb_live  " },
      }),
    ).toMatchObject({
      accountId: "service",
      configured: true,
      token: "ccb_live",
    });
  });

  it("resolves model-mode bot account policy", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            peter: {
              token: "ccb_peter",
              agentId: "peter-bot",
              replyMode: "model",
              model: "openai/gpt-5.4-mini",
              toolsAllow: ["web_search"],
              senderIsOwner: true,
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg, accountId: "peter" })).toMatchObject({
      accountId: "peter",
      agentId: "peter-bot",
      replyMode: "model",
      model: "openai/gpt-5.4-mini",
      senderIsOwner: true,
      toolsAllow: ["web_search"],
    });
  });
});
