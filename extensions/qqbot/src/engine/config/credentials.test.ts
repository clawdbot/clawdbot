import { describe, expect, it } from "vitest";
import { clearAccountCredentials } from "./credentials.js";
import { DEFAULT_ACCOUNT_ID } from "./resolve.js";

describe("engine/config/credentials", () => {
  it("ignores inherited account entries when clearing named-account credentials", () => {
    const inheritedAccount = { clientSecret: "secret", clientSecretFile: "/tmp/secret" };
    const accounts = Object.create({ bot2: inheritedAccount }) as Record<string, unknown>;
    const cfg = {
      channels: {
        qqbot: {
          accounts,
        },
      },
    } satisfies Record<string, unknown>;

    const result = clearAccountCredentials(cfg, "bot2");

    expect(result.cleared).toBe(false);
    expect(result.changed).toBe(false);
    expect(Object.hasOwn(accounts, "bot2")).toBe(false);
    expect(inheritedAccount).toEqual({
      clientSecret: "secret",
      clientSecretFile: "/tmp/secret",
    });
  });

  it("ignores inherited credential properties on an own account entry", () => {
    const account = Object.assign(
      Object.create({
        clientSecret: "secret",
        clientSecretFile: "/tmp/secret",
      }),
      { appId: "app-id" },
    );
    const cfg = {
      channels: {
        qqbot: {
          accounts: { bot2: account },
        },
      },
    } satisfies Record<string, unknown>;

    const result = clearAccountCredentials(cfg, "bot2");

    expect(result.cleared).toBe(false);
    expect(result.changed).toBe(false);
    expect(account).toEqual({ appId: "app-id" });
    expect(account.clientSecret).toBe("secret");
    expect(account.clientSecretFile).toBe("/tmp/secret");
  });

  it("clears own named-account credential properties and drops empty entries", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: {
              clientSecret: "secret",
              clientSecretFile: "/tmp/secret",
            },
          },
        },
      },
    } satisfies Record<string, unknown>;

    const result = clearAccountCredentials(cfg, "bot2");
    const nextAccounts = (
      (result.nextCfg.channels as Record<string, unknown>).qqbot as Record<string, unknown>
    ).accounts as Record<string, unknown>;

    expect(result.cleared).toBe(true);
    expect(result.changed).toBe(true);
    expect(nextAccounts.bot2).toBeUndefined();
  });

  it("clears own default-account credential properties", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "app-id",
          clientSecret: "",
          clientSecretFile: "",
        },
      },
    } satisfies Record<string, unknown>;

    const result = clearAccountCredentials(cfg, DEFAULT_ACCOUNT_ID);
    const nextQQBot = (result.nextCfg.channels as Record<string, unknown>).qqbot as Record<
      string,
      unknown
    >;

    expect(result.cleared).toBe(true);
    expect(result.changed).toBe(true);
    expect(Object.hasOwn(nextQQBot, "clientSecret")).toBe(false);
    expect(Object.hasOwn(nextQQBot, "clientSecretFile")).toBe(false);
  });
});
