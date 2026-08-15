import type { SetupChannelsOptions } from "../channels/plugins/setup-wizard-types.js";
import { ensureChannelSetupPluginInstalled } from "../commands/channel-setup/plugin-install.js";
import { runWizardWithPromptNavigationScope } from "../wizard/navigation-prompter.js";
import type { WizardPrompter } from "../wizard/prompts.js";

type ScopedChannelStepParams<T> = {
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  runner: (prompter: WizardPrompter, options: SetupChannelsOptions) => Promise<T>;
  onPersistentEffect?: () => void;
};

export async function runScopedChannelStep<T>(params: ScopedChannelStepParams<T>) {
  return await runWizardWithPromptNavigationScope(params.prompter, async (scopedPrompter) =>
    params.runner(scopedPrompter, {
      ...params.options,
      beforePersistentEffect: async () => {
        params.onPersistentEffect?.();
        scopedPrompter.disableBackNavigation?.();
        await params.options?.beforePersistentEffect?.();
      },
    }),
  );
}

type ChannelPluginInstallParams = Omit<
  Parameters<typeof ensureChannelSetupPluginInstalled>[0],
  "prompter" | "beforePersistentEffect"
>;

export async function ensureChannelSetupPluginInstalledWithNavigation(params: {
  install: ChannelPluginInstallParams;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
}) {
  let persistentEffectStarted = false;
  const outcome = await runScopedChannelStep({
    prompter: params.prompter,
    options: params.options,
    runner: async (scopedPrompter, scopedOptions) =>
      await ensureChannelSetupPluginInstalled({
        ...params.install,
        prompter: scopedPrompter,
        beforePersistentEffect: scopedOptions.beforePersistentEffect,
      }),
    onPersistentEffect: () => {
      persistentEffectStarted = true;
    },
  });
  return { ...outcome, persistentEffectStarted };
}
