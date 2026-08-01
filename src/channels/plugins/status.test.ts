import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelAccountSnapshotFromAccount } from "./status.js";
import type { ChannelPlugin } from "./types.plugin.js";

describe("buildChannelAccountSnapshotFromAccount", () => {
  it("redacts a custom status snapshot baseUrl without mutating the resolved account", async () => {
    const rawBaseUrl = [
      "https://",
      "user",
      ":",
      "pass",
      "@",
      "chat.example.test/?token=",
      "secret",
    ].join("");
    const account = Object.freeze({
      baseUrl: rawBaseUrl,
    });
    let receivedAccount: unknown;
    const plugin = {
      config: {},
      status: {
        buildAccountSnapshot: ({ account: hookAccount }: { account: unknown }) => {
          receivedAccount = hookAccount;
          return {
            accountId: "custom",
            baseUrl: (hookAccount as { baseUrl: string }).baseUrl,
          };
        },
      },
    } as unknown as ChannelPlugin<typeof account>;

    const snapshot = await buildChannelAccountSnapshotFromAccount({
      plugin,
      cfg: {} as OpenClawConfig,
      accountId: "default",
      account,
    });

    expect(receivedAccount).toBe(account);
    expect(snapshot.baseUrl).toBe("https://chat.example.test/?token=***");
    expect(account.baseUrl).toBe(rawBaseUrl);
  });

  it("preserves lifecycle fields computed by a custom status adapter", async () => {
    const account = { enabled: true, configured: true };
    const plugin = {
      config: {},
      status: {
        buildAccountSnapshot: () => ({
          accountId: "default",
          linked: true,
          running: false,
          connected: false,
          lastError: "probe failed",
        }),
      },
    } as unknown as ChannelPlugin<typeof account>;

    await expect(
      buildChannelAccountSnapshotFromAccount({
        plugin,
        cfg: {} as OpenClawConfig,
        accountId: "default",
        account,
      }),
    ).resolves.toMatchObject({
      configured: true,
      linked: true,
      running: false,
      connected: false,
      lastError: "probe failed",
    });
  });

  it("uses descriptor linkage when no live link resolver exists", async () => {
    const account = { enabled: true, configured: true };
    const plugin = {
      config: {
        describeAccount: () => ({ accountId: "default", configured: true, linked: false }),
      },
    } as unknown as ChannelPlugin<typeof account>;

    await expect(
      buildChannelAccountSnapshotFromAccount({
        plugin,
        cfg: {} as OpenClawConfig,
        accountId: "default",
        account,
      }),
    ).resolves.toMatchObject({
      configured: true,
      linked: false,
      running: false,
      stateReason: "not linked",
      lastError: null,
    });
  });

  it("does not inspect linkage when the account is unconfigured", async () => {
    const isLinked = vi.fn(() => {
      throw new Error("linkage unavailable");
    });
    const account = { enabled: true, configured: false };
    const plugin = {
      config: { isConfigured: () => false, isLinked },
    } as unknown as ChannelPlugin<typeof account>;

    await expect(
      buildChannelAccountSnapshotFromAccount({
        plugin,
        cfg: {} as OpenClawConfig,
        accountId: "default",
        account,
      }),
    ).resolves.toMatchObject({
      configured: false,
      stateReason: "not configured",
      lastError: null,
    });
    expect(isLinked).not.toHaveBeenCalled();
  });
});
