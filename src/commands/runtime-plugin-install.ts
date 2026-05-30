import { existsSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export type RuntimePluginInstallDescriptor = {
  pluginId: string;
  label: string;
  npmSpec: string;
  warningLabel: string;
};

export type RuntimePluginInstallResult = {
  cfg: OpenClawConfig;
  required: boolean;
  installed: boolean;
  status?: "installed" | "skipped" | "failed" | "timed_out";
};

export type RuntimePluginSelection = (params: { cfg: OpenClawConfig; model?: string }) => boolean;

export type RuntimePluginEnsureParams = {
  cfg: OpenClawConfig;
  model?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
};

export type RuntimePluginRepairParams = {
  cfg: OpenClawConfig;
  model?: string;
  env?: NodeJS.ProcessEnv;
};

export type RuntimePluginModelSelectionHelpers = {
  ensure: (params: RuntimePluginEnsureParams) => Promise<RuntimePluginInstallResult>;
  repair: (
    params: RuntimePluginRepairParams,
  ) => Promise<{ required: boolean; changes: string[]; warnings: string[] }>;
};

function isInstalledRecordPresentOnDisk(
  record: PluginInstallRecord | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const installPath = record?.installPath?.trim();
  if (!installPath) {
    return false;
  }
  return existsSync(path.join(resolveUserPath(installPath, env), "package.json"));
}

export async function ensureRuntimePluginForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  descriptor: RuntimePluginInstallDescriptor;
  shouldEnsure: RuntimePluginSelection;
}): Promise<RuntimePluginInstallResult> {
  if (!params.shouldEnsure({ cfg: params.cfg, model: params.model })) {
    return {
      cfg: params.cfg,
      required: false,
      installed: false,
    };
  }
  const existingRecords = await loadInstalledPluginIndexInstallRecords({ env: process.env });
  if (isInstalledRecordPresentOnDisk(existingRecords[params.descriptor.pluginId], process.env)) {
    const repair = await repairRuntimePluginInstallForModelSelection({
      cfg: params.cfg,
      model: params.model,
      env: process.env,
      descriptor: params.descriptor,
      shouldEnsure: params.shouldEnsure,
    });
    for (const change of repair.changes) {
      params.runtime.log?.(change);
    }
    for (const warning of repair.warnings) {
      params.runtime.log?.(`${params.descriptor.warningLabel} update warning: ${warning}`);
    }
    const enableResult = enablePluginInConfig(params.cfg, params.descriptor.pluginId);
    return {
      cfg: enableResult.enabled ? enableResult.config : params.cfg,
      required: true,
      installed: true,
      status: "installed",
    };
  }
  const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install.js");
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: {
      pluginId: params.descriptor.pluginId,
      label: params.descriptor.label,
      install: {
        npmSpec: params.descriptor.npmSpec,
        defaultChoice: "npm",
      },
      trustedSourceLinkedOfficialInstall: true,
      preferRemoteInstall: true,
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

export async function repairRuntimePluginInstallForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  env?: NodeJS.ProcessEnv;
  descriptor: RuntimePluginInstallDescriptor;
  shouldEnsure: RuntimePluginSelection;
}): Promise<{ required: boolean; changes: string[]; warnings: string[] }> {
  if (!params.shouldEnsure({ cfg: params.cfg, model: params.model })) {
    return { required: false, changes: [], warnings: [] };
  }
  const { repairMissingPluginInstallsForIds } =
    await import("./doctor/shared/missing-configured-plugin-install.js");
  const result = await repairMissingPluginInstallsForIds({
    cfg: params.cfg,
    pluginIds: [params.descriptor.pluginId],
    ...(params.env !== undefined ? { env: params.env } : {}),
  });
  return {
    required: true,
    changes: result.changes,
    warnings: result.warnings,
  };
}

export function createRuntimePluginModelSelectionHelpers(params: {
  descriptor: RuntimePluginInstallDescriptor;
  shouldEnsure: RuntimePluginSelection;
}): RuntimePluginModelSelectionHelpers {
  return {
    ensure: (ensureParams) =>
      ensureRuntimePluginForModelSelection({
        ...ensureParams,
        descriptor: params.descriptor,
        shouldEnsure: params.shouldEnsure,
      }),
    repair: (repairParams) =>
      repairRuntimePluginInstallForModelSelection({
        ...repairParams,
        descriptor: params.descriptor,
        shouldEnsure: params.shouldEnsure,
      }),
  };
}
