// Onboard channel post-write tests cover plugin post-write hooks after channel setup.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createChannelOnboardingPostWriteHook,
  createChannelSetupTransaction,
} from "./onboard-channels.js";
import { createExitThrowingRuntime } from "./test-wizard-helpers.js";

describe("setupChannels post-write hooks", () => {
  it("collects onboarding post-write hooks and runs them against the final config", async () => {
    const afterConfigWritten = vi.fn(async () => {});
    const previousCfg = {} as OpenClawConfig;
    const cfg = {
      channels: {
        telegram: { botToken: "new-token" },
      },
    } as OpenClawConfig;
    const adapter = {
      afterConfigWritten,
    };
    const runtime = createExitThrowingRuntime();
    const transaction = createChannelSetupTransaction({ runtime });
    const hook = createChannelOnboardingPostWriteHook({
      accountId: "acct-1",
      adapter,
      channel: "telegram",
      previousCfg,
    });

    if (!hook) {
      throw new Error("expected post-write hook");
    }
    transaction.onPostWriteHook(hook);

    expect(afterConfigWritten).not.toHaveBeenCalled();

    const committed = await transaction.commit(cfg, async () => cfg);

    expect(committed).toBe(cfg);
    expect(afterConfigWritten).toHaveBeenCalledWith({
      previousCfg,
      cfg,
      accountId: "acct-1",
      runtime,
    });
  });

  it("logs onboarding post-write hook failures without aborting", async () => {
    const runtime = createExitThrowingRuntime();
    const transaction = createChannelSetupTransaction({ runtime });
    transaction.onPostWriteHook({
      channel: "telegram",
      accountId: "acct-1",
      run: async () => {
        throw new Error("hook failed");
      },
    });

    await transaction.commit({} as OpenClawConfig, async (config) => config);

    expect(runtime.error).toHaveBeenCalledWith(
      'Channel telegram post-setup warning for "acct-1": hook failed',
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("does not run hooks when config persistence fails", async () => {
    const runtime = createExitThrowingRuntime();
    const hook = vi.fn();
    const transaction = createChannelSetupTransaction({ runtime });
    transaction.onPostWriteHook({ channel: "matrix", accountId: "ops", run: hook });

    await expect(
      transaction.commit({} as OpenClawConfig, async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");

    expect(hook).not.toHaveBeenCalled();
  });
});
