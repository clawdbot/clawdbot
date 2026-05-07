import { modelSelectionShouldEnsureCodexPlugin } from "../agents/openai-codex-routing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const CODEX_RUNTIME_PLUGIN_ID = "codex";
const CODEX_RUNTIME_PLUGIN_LABEL = "Codex";
const CODEX_RUNTIME_PLUGIN_NPM_SPEC = "@openclaw/codex";

export type CodexRuntimePluginInstallResult = {
  cfg: OpenClawConfig;
  required: boolean;
  installed: boolean;
  status?: "installed" | "skipped" | "failed" | "timed_out";
};

export function selectedModelShouldEnsureCodexRuntimePlugin(params: {
  cfg: OpenClawConfig;
  model?: string;
}): boolean {
  return modelSelectionShouldEnsureCodexPlugin({
    config: params.cfg,
    model: params.model,
  });
}

export async function ensureCodexRuntimePluginForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<CodexRuntimePluginInstallResult> {
  if (!selectedModelShouldEnsureCodexRuntimePlugin({ cfg: params.cfg, model: params.model })) {
    return { cfg: params.cfg, required: false, installed: false };
  }
  const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install.js");
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: {
      pluginId: CODEX_RUNTIME_PLUGIN_ID,
      label: CODEX_RUNTIME_PLUGIN_LABEL,
      install: {
        npmSpec: CODEX_RUNTIME_PLUGIN_NPM_SPEC,
        defaultChoice: "npm",
      },
      trustedSourceLinkedOfficialInstall: true,
    },
    prompter: params.prompter,
    runtime: params.runtime,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    promptInstall: false,
    autoConfirmSingleSource: true,
  });
  return {
    cfg: result.cfg,
    required: true,
    installed: result.installed,
    status: result.status,
  };
}

export async function repairCodexRuntimePluginInstallForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ required: boolean; changes: string[]; warnings: string[] }> {
  if (!selectedModelShouldEnsureCodexRuntimePlugin({ cfg: params.cfg, model: params.model })) {
    return { required: false, changes: [], warnings: [] };
  }
  const { repairMissingPluginInstallsForIds } =
    await import("./doctor/shared/missing-configured-plugin-install.js");
  const result = await repairMissingPluginInstallsForIds({
    cfg: params.cfg,
    pluginIds: [CODEX_RUNTIME_PLUGIN_ID],
    ...(params.env !== undefined ? { env: params.env } : {}),
  });
  return {
    required: true,
    changes: result.changes,
    warnings: result.warnings,
  };
}
