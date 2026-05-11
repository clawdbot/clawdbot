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
    ).toEqual({
      allowFrom: ["*"],
      accountId: "service",
      baseUrl: "https://app.clickclack.chat",
      config: {
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
        workspace: "wsp_1",
      },
      configured: true,
      defaultTo: "channel:general",
      enabled: true,
      reconnectMs: 1_500,
      replyMode: "agent",
      senderIsOwner: false,
      token: "ccb_live",
      workspace: "wsp_1",
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

    expect(resolveClickClackAccount({ cfg, accountId: "peter" })).toEqual({
      allowFrom: ["*"],
      accountId: "peter",
      agentId: "peter-bot",
      baseUrl: "https://app.clickclack.chat",
      config: {
        agentId: "peter-bot",
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        model: "openai/gpt-5.4-mini",
        replyMode: "model",
        senderIsOwner: true,
        token: "ccb_peter",
        toolsAllow: ["web_search"],
        workspace: "wsp_1",
      },
      configured: true,
      defaultTo: "channel:general",
      enabled: true,
      model: "openai/gpt-5.4-mini",
      reconnectMs: 1_500,
      replyMode: "model",
      senderIsOwner: true,
      token: "ccb_peter",
      toolsAllow: ["web_search"],
      workspace: "wsp_1",
    });
  });
});
