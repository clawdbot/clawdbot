import { describe, expect, it } from "vitest";
import { resolveFeishuToolAccount } from "./tool-account.js";

describe("resolveFeishuToolAccount", () => {
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: "ops",
        appId: "base-app-id",
        appSecret: "base-app-secret", // pragma: allowlist secret
        accounts: {
          ops: {
            enabled: true,
            appId: "ops-app-id",
            appSecret: "ops-app-secret", // pragma: allowlist secret
          },
          work: {
            enabled: true,
            appId: "work-app-id",
            appSecret: "work-app-secret", // pragma: allowlist secret
          },
        },
      },
    },
  };

  it("prefers the active contextual account over configured defaultAccount", () => {
    const resolved = resolveFeishuToolAccount({
      api: { config: cfg },
      defaultAccountId: "work",
    });

    expect(resolved.accountId).toBe("work");
  });

  it("falls back to configured defaultAccount when there is no contextual account", () => {
    const resolved = resolveFeishuToolAccount({
      api: { config: cfg },
    });

    expect(resolved.accountId).toBe("ops");
  });
});
