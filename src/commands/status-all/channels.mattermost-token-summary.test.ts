import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  summarizeTokenConfig,
  type ChannelAccountTokenSummaryRow,
} from "./channels-token-summary.js";

function tokenRow(params: {
  account: Record<string, unknown>;
  snapshot?: Partial<ChannelAccountSnapshot>;
  enabled?: boolean;
}): ChannelAccountTokenSummaryRow {
  return {
    account: params.account,
    enabled: params.enabled ?? true,
    snapshot: {
      accountId: "primary",
      ...params.snapshot,
    } as ChannelAccountSnapshot,
  };
}

function summarize(accounts: ChannelAccountTokenSummaryRow[]) {
  return summarizeTokenConfig({ accounts, showSecrets: false });
}

describe("summarizeTokenConfig", () => {
  it("does not require appToken for bot-token-only channels", () => {
    const summary = summarize([
      tokenRow({
        account: {
          botToken: "bot-token-value",
          baseUrl: "https://mm.example.com",
        },
        snapshot: { botTokenSource: "config" },
      }),
    ]);

    expect(summary.state).toBe("ok");
    expect(summary.detail).toContain("bot token config");
    expect(summary.detail).not.toContain("need bot+app");
  });

  it("keeps bot+app requirement when both fields exist", () => {
    const summary = summarize([
      tokenRow({
        account: {
          botToken: "bot-token",
          appToken: "",
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("need bot+app");
  });

  it("reports configured-but-unavailable Slack credentials as warn", () => {
    const summary = summarize([
      tokenRow({
        account: {
          configured: true,
          botToken: "",
          appToken: "",
          botTokenSource: "config",
          appTokenSource: "config",
          botTokenStatus: "configured_unavailable",
          appTokenStatus: "configured_unavailable",
        },
        snapshot: {
          botTokenSource: "config",
          appTokenSource: "config",
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("unavailable in this command path");
  });

  it("treats status-only available HTTP credentials as resolved", () => {
    const summary = summarize([
      tokenRow({
        account: {
          mode: "http",
          botToken: "",
          signingSecret: "", // pragma: allowlist secret
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
          botTokenStatus: "available",
          signingSecretStatus: "available", // pragma: allowlist secret
        },
        snapshot: {
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
        },
      }),
    ]);

    expect(summary.state).toBe("ok");
    expect(summary.detail).toContain("credentials ok");
  });

  it("treats Slack HTTP signing-secret availability as required config", () => {
    const summary = summarize([
      tokenRow({
        account: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: "", // pragma: allowlist secret
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
          botTokenStatus: "available",
          signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
        },
        snapshot: {
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("configured http credentials unavailable");
  });

  it("still reports single-token channels as ok", () => {
    const summary = summarize([
      tokenRow({
        account: {
          token: "token-value",
          tokenSource: "config",
        },
        snapshot: { tokenSource: "config" },
      }),
    ]);

    expect(summary.state).toBe("ok");
    expect(summary.detail).toContain("token config");
  });
});
