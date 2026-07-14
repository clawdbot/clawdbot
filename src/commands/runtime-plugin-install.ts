/**
 * Runtime plugin install helpers for model selection.
 *
 * Model choices can require runtime plugins such as Codex or Copilot; this
 * module installs, enables, or repairs those plugins from a shared descriptor.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Static install metadata for a runtime plugin required by model selection. */
type RuntimePluginInstallDescriptor = {
  pluginId: string;
  label: string;
  npmSpec: string;
  warningLabel: string;
};

/** Result returned after ensuring a runtime plugin for a selected model. */
type RuntimePluginInstallResult = {
  cfg: OpenClawConfig;
  required: boolean;
  installed: boolean;
  status?: "installed" | "skipped" | "failed" | "timed_out";
  reason?: string;
};

/** Predicate that decides whether a config/model pair needs the runtime plugin. */
type RuntimePluginSelection = (params: {
  cfg: OpenClawConfig;
  model?: string;
  agentId?: string;
}) => boolean;

/** Parameters for installing or enabling a runtime plugin during setup. */
type RuntimePluginEnsureParams = {
  cfg: OpenClawConfig;
  model?: string;
  agentId?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
};

/** Parameters for doctor-style runtime plugin repair. */
type RuntimePluginRepairParams = {
  cfg: OpenClawConfig;
  model?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
};

/** Convenience helpers bound to one runtime plugin descriptor. */
type RuntimePluginModelSelectionHelpers = {
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

/** Ensures the runtime plugin required by the selected model is installed and enabled. */
async function ensureRuntimePluginForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  agentId?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  descriptor: RuntimePluginInstallDescriptor;
  shouldEnsure: RuntimePluginSelection;
}): Promise<RuntimePluginInstallResult> {
  if (
    !params.shouldEnsure({
      cfg: params.cfg,
      model: params.model,
      agentId: params.agentId,
    })
  ) {
    return {
      cfg: params.cfg,
      required: false,
      installed: false,
    };
  }
  const existingRecords = await loadInstalledPluginIndexInstallRecords({ env: process.env });
  if (isInstalledRecordPresentOnDisk(existingRecords[params.descriptor.pluginId], process.env)) {
    // A recorded install with package.json on disk can be repaired/enabled
    // without re-downloading the plugin during setup.
    const repair = await repairRuntimePluginInstallForModelSelection({
      cfg: params.cfg,
      model: params.model,
      agentId: params.agentId,
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
      cfg: enableResult.config,
      required: true,
      installed: enableResult.enabled,
      status: enableResult.enabled ? "installed" : "failed",
      ...(enableResult.reason ? { reason: enableResult.reason } : {}),
    };
  }
  const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install.js");
  // Defer to the onboarding plugin installer so runtime plugin installs get the
  // same trust, record, timeout, and progress handling as channel/provider setup.
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
    ...(result.error ? { reason: result.error } : {}),
  };
}

/** Repairs missing install records for runtime plugins required by model selection. */
async function repairRuntimePluginInstallForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  descriptor: RuntimePluginInstallDescriptor;
  shouldEnsure: RuntimePluginSelection;
}): Promise<{ required: boolean; changes: string[]; warnings: string[] }> {
  if (
    !params.shouldEnsure({
      cfg: params.cfg,
      model: params.model,
      agentId: params.agentId,
    })
  ) {
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
    warnings: [...result.warnings, ...(result.notices ?? [])],
  };
}

/** Creates ensure/repair helpers pre-bound to a runtime plugin descriptor. */
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
