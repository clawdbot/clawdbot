import {
  resolveOnboardingWorkspaceConflict,
  type OnboardingWorkspaceConflict,
} from "../commands/onboard-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shortenHomePath } from "../utils.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

/** Resolves a proposed setup workspace without silently remapping an existing fleet. */
export async function resolveSetupWorkspaceSelection(params: {
  baseConfig: OpenClawConfig;
  requestedWorkspaceDir: string;
  prompter: WizardPrompter;
  canConfirmMove?: boolean;
}): Promise<{
  workspaceDir: string;
  allowWorkspaceChange: boolean;
  conflict?: OnboardingWorkspaceConflict;
}> {
  const conflict = resolveOnboardingWorkspaceConflict(
    params.baseConfig,
    params.requestedWorkspaceDir,
  );
  if (!conflict) {
    return { workspaceDir: params.requestedWorkspaceDir, allowWorkspaceChange: false };
  }
  await params.prompter.note(
    t("wizard.setup.workspaceConflictNotice", {
      current: shortenHomePath(conflict.currentWorkspaceDir),
      requested: shortenHomePath(conflict.requestedWorkspaceDir),
    }),
    t("wizard.setup.workspaceConflictTitle"),
  );
  const allowWorkspaceChange =
    params.canConfirmMove !== false &&
    (await params.prompter.confirm({
      message: t("wizard.setup.workspaceConflictConfirm"),
      initialValue: false,
    }));
  return {
    workspaceDir: allowWorkspaceChange
      ? params.requestedWorkspaceDir
      : conflict.currentWorkspaceDir,
    allowWorkspaceChange,
    conflict,
  };
}
