// Setup completion helpers render completion instructions after onboarding.
import { CLI_NAME } from "../cli/cli-name.js";
import {
  findCompletionProfileWriteError,
  formatCompletionReloadCommand,
  installCompletion,
  resolveCompletionProfileHint,
  resolveCompletionProfilePath,
} from "../cli/completion-runtime.js";
import type {
  CompletionCacheGenerationOptions,
  ShellCompletionStatus,
} from "../commands/doctor-completion.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../commands/doctor-completion.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import type { WizardFlow } from "./setup.types.js";

type CompletionDeps = {
  resolveCliName: () => string;
  checkShellCompletionStatus: (binName: string) => Promise<ShellCompletionStatus>;
  ensureCompletionCacheExists: (
    binName: string,
    options: CompletionCacheGenerationOptions,
  ) => Promise<boolean>;
  installCompletion: (shell: string, yes: boolean, binName?: string) => Promise<void>;
};

export async function setupWizardShellCompletion(params: {
  flow: WizardFlow;
  prompter: Pick<WizardPrompter, "confirm" | "note">;
  deps?: Partial<CompletionDeps>;
}): Promise<void> {
  const deps: CompletionDeps = {
    resolveCliName: () => CLI_NAME,
    checkShellCompletionStatus,
    ensureCompletionCacheExists,
    installCompletion,
    ...params.deps,
  };

  const cliName = deps.resolveCliName();
  const completionStatus = await deps.checkShellCompletionStatus(cliName);
  const installCompletionForSetup = async (): Promise<boolean> => {
    try {
      await deps.installCompletion(completionStatus.shell, true, cliName);
      return true;
    } catch (error) {
      const writeError = findCompletionProfileWriteError(error);
      if (!writeError) {
        throw error;
      }
      await params.prompter.note(
        t("wizard.completion.profileNotWritable", {
          profile: writeError.path ?? resolveCompletionProfilePath(completionStatus.shell),
          shell: completionStatus.shell,
          command: formatCompletionReloadCommand(
            completionStatus.shell,
            completionStatus.cachePath,
          ),
        }),
        t("wizard.completion.title"),
      );
      return false;
    }
  };
  const generationOptions = { generationMode: "full" } as const;
  const ensureCompletionCache = async (): Promise<boolean> => {
    const cacheGenerated = await deps.ensureCompletionCacheExists(cliName, generationOptions);
    if (!cacheGenerated) {
      await params.prompter.note(
        t("wizard.completion.cacheFailed", {
          command: `${cliName} completion --write-state --install`,
        }),
        t("wizard.completion.title"),
      );
    }
    return cacheGenerated;
  };

  if (completionStatus.usesSlowPattern) {
    // Case 1: Profile uses slow dynamic pattern - silently upgrade to cached version
    const cacheGenerated = await ensureCompletionCache();
    if (cacheGenerated) {
      await installCompletionForSetup();
    }
    return;
  }

  if (completionStatus.profileInstalled && !completionStatus.cacheExists) {
    // Case 2: Profile has completion but no cache - auto-fix silently
    await ensureCompletionCache();
    return;
  }

  if (!completionStatus.profileInstalled) {
    // Case 3: No completion at all
    const shouldInstall =
      params.flow === "quickstart"
        ? true
        : await params.prompter.confirm({
            message: t("wizard.completion.enable", {
              shell: completionStatus.shell,
              cli: cliName,
            }),
            initialValue: true,
          });

    if (!shouldInstall) {
      return;
    }

    // Generate cache first (required for fast shell startup)
    const cacheGenerated = await ensureCompletionCache();
    if (!cacheGenerated) {
      return;
    }

    // Install to shell profile
    const completionInstalled = await installCompletionForSetup();
    if (!completionInstalled) {
      return;
    }

    const shell = completionStatus.shell;
    const command = formatCompletionReloadCommand(shell, resolveCompletionProfileHint(shell));
    const reloadHint =
      shell === "powershell"
        ? t("wizard.completion.reloadPowerShell", { command })
        : t("wizard.completion.reloadShell", { profile: command.slice("source ".length) });
    await params.prompter.note(
      t("wizard.completion.installed", { reloadHint }),
      t("wizard.completion.title"),
    );
  }
  // Case 4: Both profile and cache exist (using cached version) - all good, nothing to do
}
