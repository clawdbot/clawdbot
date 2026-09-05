import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildChannelAccountSnapshotFromAccount,
  buildReadOnlySourceChannelAccountSnapshot,
  resolveChannelAccountSnapshot,
} from "./status.js";
import type { ChannelPlugin } from "./types.plugin.js";

describe("buildChannelAccountSnapshotFromAccount", () => {
  it("keeps omitted inspection configuration unknown without invoking runtime hooks", async () => {
    const runtimeOnly = vi.fn(() => {
      throw new Error("runtime account unavailable");
    });
    const plugin = {
      id: "external-inspector",
      config: {
        inspectAccount: () => ({ enabled: true, name: "External account" }),
        resolveAccount: runtimeOnly,
        isConfigured: runtimeOnly,
      },
    } as unknown as ChannelPlugin;

    const snapshot = await resolveChannelAccountSnapshot({ plugin, cfg: {}, accountId: "default" });
    expect(snapshot.configured).toBeUndefined();
    expect(snapshot.stateReason).toBe("configuration status unavailable");
    expect(snapshot.running).toBe(false);
    expect(runtimeOnly).not.toHaveBeenCalled();
  });

  it.each([
    { inspected: {}, enabled: false, configured: true, stateReason: "disabled" },
    {
      inspected: { enabled: true, configured: false },
      enabled: true,
      configured: false,
      stateReason: "not configured",
    },
  ])("preserves runtime facts unless the inspector supplies them: $stateReason", async (entry) => {
    const runtimeOnly = vi.fn(() => {
      throw new Error("runtime account unavailable");
    });
    const plugin = {
      id: "external-inspector",
      config: {
        inspectAccount: () => ({ name: "External account", ...entry.inspected }),
        resolveAccount: runtimeOnly,
        isConfigured: runtimeOnly,
      },
    } as unknown as ChannelPlugin;

    await expect(
      resolveChannelAccountSnapshot({
        plugin,
        cfg: {},
        accountId: "default",
        runtime: {
          accountId: "default",
          enabled: false,
          configured: true,
          running: false,
          lastError: "recorded failure",
        },
      }),
    ).resolves.toMatchObject({
      enabled: entry.enabled,
      configured: entry.configured,
      running: false,
      stateReason: entry.stateReason,
      lastError: "recorded failure",
    });
    expect(runtimeOnly).not.toHaveBeenCalled();
  });

  it.each([resolveChannelAccountSnapshot, buildReadOnlySourceChannelAccountSnapshot])(
    "%s projects summary-only inspection without invoking runtime account hooks",
    async (buildSnapshot) => {
      const runtimeOnly = vi.fn(() => {
        throw new Error("runtime hook received an inspection summary");
      });
      const plugin = {
        id: "inspection-fixture",
        config: {
          inspectAccount: () => ({
            accountId: "primary",
            enabled: true,
            configured: true,
            tokenStatus: "available",
            name: "Configured account",
          }),
          resolveAccount: runtimeOnly,
          isEnabled: runtimeOnly,
          isConfigured: runtimeOnly,
          describeAccount: runtimeOnly,
        },
        status: { buildAccountSnapshot: runtimeOnly },
      } as unknown as ChannelPlugin;

      await expect(
        buildSnapshot({
          plugin,
          cfg: {},
          accountId: "requested-alias",
          runtime: { accountId: "primary", running: true, lifecycle: "ready" },
        }),
      ).resolves.toMatchObject({
        accountId: "primary",
        name: "Configured account",
        enabled: true,
        configured: true,
        tokenStatus: "available",
        running: true,
        lifecycle: "ready",
      });
      expect(runtimeOnly).not.toHaveBeenCalled();
    },
  );

  it.each([true, undefined])(
    "preserves prepared runtime metadata while filtering raw inspection with configured=%s",
    async (configured) => {
      const runtimeOnly = vi.fn(() => {
        throw new Error("runtime hook received inspection metadata");
      });
      const plugin = {
        id: "inspection-fixture",
        config: {
          inspectAccount: () => ({
            enabled: true,
            configured,
            botToken: "raw-inspection-token",
            publicKey: "raw-inspection-key",
            application: { privateCredential: "raw-inspection-value" },
          }),
          resolveAccount: runtimeOnly,
        },
        status: { buildAccountSnapshot: runtimeOnly },
      } as unknown as ChannelPlugin;
      const cachedProbe = { ok: true, source: "recorded" };
      const freshProbe = configured ? { ok: false, source: "requested" } : undefined;
      const runtime = Object.freeze({
        accountId: "primary",
        running: true,
        application: { intents: { messageContent: "disabled" } },
        bot: { username: "recorded-bot" },
        audit: { unresolvedChannels: 1 },
        probe: cachedProbe,
        baseUrl: ["https://", "user", ":", "pass", "@chat.example.test/?token=", "secret"].join(""),
      });

      const snapshot = await resolveChannelAccountSnapshot({
        plugin,
        cfg: {},
        accountId: "primary",
        runtime,
        probe: freshProbe,
      });

      expect(snapshot).toMatchObject({
        configured,
        running: true,
        application: runtime.application,
        bot: runtime.bot,
        audit: runtime.audit,
        probe: freshProbe ?? cachedProbe,
        baseUrl: "https://chat.example.test/?token=***",
      });
      expect(snapshot).not.toHaveProperty("botToken");
      expect(snapshot).not.toHaveProperty("publicKey");
      expect(JSON.stringify(snapshot)).not.toContain("raw-inspection");
      expect(runtime.baseUrl).toContain("user:pass@");
      expect(runtime.probe).toBe(cachedProbe);
      expect(runtimeOnly).not.toHaveBeenCalled();
    },
  );

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
