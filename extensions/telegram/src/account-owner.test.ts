import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";

describe("resolveTelegramAccountOwnerAgentId", () => {
  it("resolves distinct routed owners for Telegram accounts", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, research: {} },
      },
      channels: {
        telegram: {
          accounts: {
            primary: { botToken: "123456:primary" },
            alerts: { botToken: "123456:alerts" },
          },
        },
      },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "primary" } },
        { agentId: "ops", match: { channel: "telegram", accountId: "alerts" } },
      ],
    } as OpenClawConfig;

    expect(resolveTelegramAccountOwnerAgentId({ cfg, accountId: "primary" })).toBe("main");
    expect(resolveTelegramAccountOwnerAgentId({ cfg, accountId: "alerts" })).toBe("ops");
  });

  it("rejects explicit multi-agent ownership without an account route", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {} },
      },
    } as OpenClawConfig;

    expect(() => resolveTelegramAccountOwnerAgentId({ cfg, accountId: "default" })).toThrow(
      /Add a channel-wide binding for telegram:default/,
    );
  });
});
