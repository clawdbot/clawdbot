import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createExitThrowingRuntime } from "../../test/helpers/auth-wizard.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeWizardConfigFile } from "../wizard/setup.shared.js";
import {
  createChannelOnboardingPostWriteHook,
  createChannelSetupHooks,
} from "./onboard-channels.js";

describe("setupChannels post-write hooks", () => {
  it.each(["plugin", "wizard"] as const)(
    "resolves the exact %s commit after config selection changes",
    async (writer) => {
      await withOpenClawTestState(
        {
          label: "post-write-config",
          layout: "split",
          env: { SETUP_REPLY_PREFIX: "resolved prefix" },
        },
        async (state) => {
          await state.writeConfig({ messages: { responsePrefix: "${SETUP_REPLY_PREFIX}" } });
          const before = await readConfigFileSnapshot();
          const next = { ...before.sourceConfig, gateway: { port: 19001 } };
          const runtime = createExitThrowingRuntime();
          const afterConfigWritten = vi.fn(async () => {});
          const hooks = createChannelSetupHooks({ runtime });
          hooks.onPostWriteHook(
            createChannelOnboardingPostWriteHook({
              channel: "matrix",
              accountId: "ops",
              previousCfg: before.sourceConfig,
              adapter: { afterConfigWritten },
            })!,
          );
          const committed =
            writer === "plugin"
              ? await commitConfigWithPendingPluginInstalls({
                  sourceConfig: next,
                  baseHash: before.hash,
                })
              : await writeWizardConfigFile(next, { baseHash: before.hash });
          expect(afterConfigWritten).not.toHaveBeenCalled();
          expect(committed.nextConfig.messages?.responsePrefix).toBe("${SETUP_REPLY_PREFIX}");
          const decoy = state.path("decoy.json");
          await fs.writeFile(decoy, JSON.stringify({ messages: { responsePrefix: "wrong file" } }));
          process.env.OPENCLAW_CONFIG_PATH = decoy;

          await hooks.runPostWriteHooks(committed.path);

          expect(afterConfigWritten).toHaveBeenCalledWith(
            expect.objectContaining({
              cfg: expect.objectContaining({
                messages: expect.objectContaining({ responsePrefix: "resolved prefix" }),
                gateway: expect.objectContaining({ port: 19001 }),
              }),
              previousCfg: before.sourceConfig,
              accountId: "ops",
            }),
          );
          expect(runtime.error).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("deduplicates accounts, continues after a hook warning, and clears completed hooks", async () => {
    await withOpenClawTestState(
      { label: "post-write-hook-lifecycle", scenario: "minimal" },
      async (state) => {
        const runtime = createExitThrowingRuntime();
        const hooks = createChannelSetupHooks({ runtime });
        const replaced = vi.fn();
        const failing = vi.fn(async () => {
          throw new Error("hook failed");
        });
        const succeeding = vi.fn();
        hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: replaced });
        hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: failing });
        hooks.onPostWriteHook({ channel: "telegram", accountId: "ops", run: succeeding });

        await hooks.runPostWriteHooks(state.configPath);
        await hooks.runPostWriteHooks(state.path("missing-after-completion.json"));

        expect(replaced).not.toHaveBeenCalled();
        expect(failing).toHaveBeenCalledOnce();
        expect(succeeding).toHaveBeenCalledOnce();
        expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
          'Channel matrix post-setup warning for "ops": hook failed',
        );
      },
    );
  });

  it("rechecks authority after the awaited read and retains rejected hooks", async () => {
    await withOpenClawTestState(
      { label: "post-write-authority", scenario: "minimal" },
      async (state) => {
        let active = true;
        const hook = vi.fn();
        const runtime = createExitThrowingRuntime();
        const hooks = createChannelSetupHooks({
          runtime,
          beforePersistentEffect: async () => {
            if (!active) {
              throw new Error("owner revoked");
            }
          },
        });
        hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: hook });
        const pending = hooks.runPostWriteHooks(state.configPath);
        active = false;

        await expect(pending).rejects.toThrow("owner revoked");
        expect(hook).not.toHaveBeenCalled();
        expect(runtime.error).not.toHaveBeenCalled();
        active = true;
        await hooks.runPostWriteHooks(state.configPath);
        expect(hook).toHaveBeenCalledOnce();
      },
    );
  });
});
