// Feishu tests cover tool account plugin behavior.
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
          disabled: {
            enabled: false,
            appId: "disabled-app-id",
            appSecret: "disabled-app-secret", // pragma: allowlist secret
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

  it("allows an explicit configured account", () => {
    const resolved = resolveFeishuToolAccount({
      api: { config: cfg },
      executeParams: { accountId: "WORK" },
    });

    expect(resolved.accountId).toBe("work");
  });

  it("allows the explicit unlisted default backed by top-level credentials", () => {
    const resolved = resolveFeishuToolAccount({
      api: {
        config: {
          channels: {
            feishu: {
              defaultAccount: "ops",
              appId: "base-app-id",
              appSecret: "base-app-secret", // pragma: allowlist secret
            },
          },
        },
      },
      executeParams: { accountId: "OPS" },
    });

    expect(resolved.accountId).toBe("ops");
    expect(resolved.configured).toBe(true);
  });

  it.each([
    { name: "malformed", accountId: "!!!", error: "Invalid Feishu account ID" },
    { name: "unknown", accountId: "missing", error: "Unknown Feishu account" },
    { name: "disabled", accountId: "disabled", error: "is disabled" },
  ])("rejects an explicit $name account", (testCase) => {
    expect(() =>
      resolveFeishuToolAccount({
        api: { config: cfg },
        executeParams: { accountId: testCase.accountId },
      }),
    ).toThrow(testCase.error);
  });
});
