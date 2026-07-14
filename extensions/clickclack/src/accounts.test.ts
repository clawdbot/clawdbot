// Clickclack tests cover accounts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  listClickClackAccountIds,
  resolveClickClackAccount,
  resolveDefaultClickClackAccountId,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("ClickClack account resolution", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: "test-token-placeholder",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("default");
    expect(resolveClickClackAccount({ cfg }).token).toBe("test-token-placeholder");
  });

  it("does not synthesize a partial top-level default account from inherited credentials", () => {
    const cfg = {
      channels: {
        clickclack: {
          token: "test-auth-token",
          accounts: {
            work: {
              baseUrl: "https://app.clickclack.chat",
              workspace: "wsp_1",
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("work");
  });

  it("does not synthesize a default account from blank top-level credentials", () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_default",
          token: "   ",
          accounts: {
            work: {
              baseUrl: "https://app.clickclack.chat",
              workspace: "wsp_1",
              token: "gateway-token",
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("work");
  });

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
        env: { CLICKCLACK_SERVICE_TOKEN: "  test-token-placeholder  " },
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
      agentId: undefined,
      botUserId: undefined,
      defaultTo: "channel:general",
      enabled: true,
      agentActivity: false,
      model: undefined,
      name: undefined,
      reconnectMs: 1_500,
      replyMode: "agent",
      systemPrompt: undefined,
      token: "test-token-placeholder",
      timeoutSeconds: undefined,
      toolsAllow: undefined,
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
              token: "token-oversized",
              agentId: "peter-bot",
              replyMode: "model",
              model: "openai/gpt-5.4-mini",
              toolsAllow: ["web_search"],
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
        token: "token-oversized",
        toolsAllow: ["web_search"],
        workspace: "wsp_1",
      },
      configured: true,
      botUserId: undefined,
      defaultTo: "channel:general",
      enabled: true,
      agentActivity: false,
      model: "openai/gpt-5.4-mini",
      name: undefined,
      reconnectMs: 1_500,
      replyMode: "model",
      systemPrompt: undefined,
      token: "token-oversized",
      timeoutSeconds: undefined,
      toolsAllow: ["web_search"],
      workspace: "wsp_1",
    });
  });

  it("resolves the agent activity opt-in only when explicitly enabled", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: "test-token-placeholder",
          accounts: {
            bridge: {
              token: "clawrouter-e2e-secret",
              agentActivity: true,
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg }).agentActivity).toBe(false);
    expect(resolveClickClackAccount({ cfg, accountId: "bridge" }).agentActivity).toBe(true);
  });

  it("normalizes reconnect intervals to the public config bounds", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          token: "very-long-browser-token-0123456789",
          workspace: "wsp_1",
          reconnectMs: 1,
          accounts: {
            slow: {
              reconnectMs: 1_000_000,
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg }).reconnectMs).toBe(100);
    expect(resolveClickClackAccount({ cfg, accountId: "slow" }).reconnectMs).toBe(60_000);
  });
});
