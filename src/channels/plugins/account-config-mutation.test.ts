import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  applyPreparedChannelAccountConfiguration,
  applyPreparedChannelAccountRemoval,
  prepareChannelAccountConfiguration,
  prepareChannelAccountRemoval,
} from "./account-config-mutation.js";
import { defineChannelSetupContract } from "./setup-contract.js";
import type { ChannelPlugin } from "./types.plugin.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as never;

describe("channel account config mutations", () => {
  it("prepares, validates, applies, and reports lifecycle changes in order", async () => {
    const callOrder: string[] = [];
    const beforePersistentEffect = vi.fn(async () => {
      callOrder.push("authority");
    });
    const cfg = {
      channels: {
        "test-chat": {
          enabled: true,
          token: "old-token",
        },
      },
    } satisfies OpenClawConfig;
    const plugin = {
      ...createChannelTestPluginBase({ id: "test-chat" }),
      setup: {
        singleAccountKeysToMove: ["token"],
        prepareAccountConfigInput: ({ input }: { input: Record<string, unknown> }) => {
          callOrder.push("prepare");
          return { ...input, token: "prepared-token" };
        },
        validateInput: ({ input }: { input: Record<string, unknown> }) => {
          callOrder.push("validate");
          return input.token === "prepared-token" ? null : "input was not prepared";
        },
        applyAccountConfig: ({ cfg: inputCfg, accountId, input }) => {
          callOrder.push("apply");
          const channel = inputCfg.channels?.["test-chat"] as
            | {
                enabled?: boolean;
                accounts?: Record<string, Record<string, unknown>>;
              }
            | undefined;
          return {
            ...inputCfg,
            channels: {
              ...inputCfg.channels,
              "test-chat": {
                ...channel,
                accounts: {
                  ...channel?.accounts,
                  [accountId]: { token: (input as { token: string }).token },
                },
              },
            },
          };
        },
      },
      lifecycle: {
        onAccountConfigChanged: ({ prevCfg, nextCfg, accountId }) => {
          callOrder.push("lifecycle");
          expect(prevCfg).toBe(cfg);
          expect(accountId).toBe("work");
          expect(nextCfg.channels?.["test-chat"]).toMatchObject({
            accounts: {
              default: { token: "old-token" },
              work: { token: "prepared-token" },
            },
          });
        },
      },
    } as ChannelPlugin;

    const prepared = await prepareChannelAccountConfiguration({
      cfg,
      plugin,
      requestedAccountId: "Work",
      resolveInput: () => ({ token: "raw-token" }),
      runtime,
      beforePersistentEffect,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }

    const applied = await applyPreparedChannelAccountConfiguration({
      cfg,
      channel: "test-chat",
      prepared: prepared.value,
      runtime,
      beforePersistentEffect,
    });

    expect(callOrder).toEqual([
      "authority",
      "prepare",
      "validate",
      "apply",
      "authority",
      "lifecycle",
    ]);
    expect(applied.accountId).toBe("work");
    expect(applied.input).toEqual({ token: "prepared-token" });
  });

  it("returns channel-owned setup parse errors before config mutation", async () => {
    const applyAccountConfig = vi.fn(({ cfg }) => cfg);
    const plugin = {
      ...createChannelTestPluginBase({ id: "typed-chat" }),
      setupContract: defineChannelSetupContract({
        fields: {
          token: {
            kind: "string",
            cli: { flags: "--token <token>", description: "Bot token" },
          },
        },
        adapter: { applyAccountConfig },
      }),
    } as ChannelPlugin;

    const prepared = await prepareChannelAccountConfiguration({
      cfg: {},
      plugin,
      resolveInput: () => ({ unknownOption: true }),
      runtime,
    });

    expect(prepared).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        message: "Unsupported setup option: unknownOption",
      },
    });
    expect(applyAccountConfig).not.toHaveBeenCalled();
  });

  it("normalizes plugin-resolved account IDs only at the config mutation boundary", async () => {
    const applyAccountConfig = vi.fn(({ cfg }) => cfg);
    const onAccountConfigChanged = vi.fn();
    const plugin = {
      ...createChannelTestPluginBase({ id: "test-chat" }),
      setup: {
        resolveAccountId: () => "Work",
        applyAccountConfig,
      },
      lifecycle: { onAccountConfigChanged },
    } as ChannelPlugin;

    const prepared = await prepareChannelAccountConfiguration({
      cfg: {},
      plugin,
      requestedAccountId: "ignored",
      resolveInput: () => ({ token: "token-1" }),
      runtime,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }

    const applied = await applyPreparedChannelAccountConfiguration({
      cfg: {},
      channel: "test-chat",
      prepared: prepared.value,
      runtime,
    });

    expect(applyAccountConfig).toHaveBeenCalledWith({
      cfg: {},
      accountId: "work",
      input: { token: "token-1" },
    });
    expect(onAccountConfigChanged).toHaveBeenCalledWith({
      prevCfg: {},
      nextCfg: {},
      accountId: "Work",
      runtime,
    });
    expect(applied.accountId).toBe("Work");
  });

  it("does not resolve input when the channel has no account setup capability", async () => {
    const resolveInput = vi.fn(() => {
      throw new Error("input should stay lazy");
    });
    const plugin = createChannelTestPluginBase({ id: "read-only-chat" }) as ChannelPlugin;

    const prepared = await prepareChannelAccountConfiguration({
      cfg: {},
      plugin,
      resolveInput,
      runtime,
    });

    expect(prepared).toEqual({
      ok: false,
      error: { kind: "unsupported" },
    });
    expect(resolveInput).not.toHaveBeenCalled();
  });

  it("deletes an account and runs its owner lifecycle hook", async () => {
    const onAccountRemoved = vi.fn();
    const cfg = {
      channels: {
        "test-chat": {
          accounts: {
            default: { token: "default-token" },
            work: { token: "work-token" },
          },
        },
      },
    } satisfies OpenClawConfig;
    const plugin = {
      ...createChannelTestPluginBase({
        id: "test-chat",
        config: {
          deleteAccount: ({ cfg: inputCfg, accountId }) => {
            const channel = inputCfg.channels?.["test-chat"] as {
              accounts?: Record<string, Record<string, unknown>>;
            };
            const accounts = { ...channel.accounts };
            delete accounts[accountId];
            return {
              ...inputCfg,
              channels: {
                ...inputCfg.channels,
                "test-chat": { ...channel, accounts },
              },
            };
          },
        },
      }),
      gateway: { startAccount: vi.fn() },
      lifecycle: { onAccountRemoved },
    } as ChannelPlugin;
    const prepared = prepareChannelAccountRemoval({
      plugin,
      accountId: "Work",
      action: "delete",
    });

    expect(prepared).toMatchObject({
      accountId: "work",
      accountKey: "work",
      shouldStopRuntime: true,
    });
    const result = await applyPreparedChannelAccountRemoval({
      cfg,
      prepared,
      runtime,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nextConfig.channels?.["test-chat"]).toMatchObject({
        accounts: { default: { token: "default-token" } },
      });
    }
    expect(onAccountRemoved).toHaveBeenCalledWith({
      prevCfg: cfg,
      accountId: "work",
      runtime,
    });
  });

  it("reports unsupported removal actions without running lifecycle hooks", async () => {
    const onAccountConfigChanged = vi.fn();
    const plugin = {
      ...createChannelTestPluginBase({ id: "test-chat" }),
      lifecycle: { onAccountConfigChanged },
    } as ChannelPlugin;
    const prepared = prepareChannelAccountRemoval({
      plugin,
      accountId: "default",
      action: "disable",
    });

    const result = await applyPreparedChannelAccountRemoval({
      cfg: {},
      prepared,
      runtime,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: "unsupported-action", action: "disable" },
    });
    expect(onAccountConfigChanged).not.toHaveBeenCalled();
  });
});
