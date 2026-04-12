import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../shared/entry-status.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { CONFIG_DIR } from "../utils.js";
import { hasBinary, isConfigPathTruthy } from "./config.js";
import {
  resolveHookConfig,
  resolveHookEnableState,
  resolveHookEntries,
  type HookEnableStateReason,
} from "./policy.js";
import type { HookEligibilityContext, HookEntry, HookInstallSpec } from "./types.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

export type HookStatusConfigCheck = RequirementConfigCheck;

export type HookInstallOption = {
  id: string;
  kind: HookInstallSpec["kind"];
  label: string;
  bins: string[];
};

export type HookStatusEntry = {
  name: string;
  description: string;
  source: string;
  pluginId?: string;
  filePath: string;
  baseDir: string;
  handlerPath: string;
  hookKey: string;
  emoji?: string;
  homepage?: string;
  events: string[];
  always: boolean;
  enabledByConfig: boolean;
  requirementsSatisfied: boolean;
  loadable: boolean;
  blockedReason?: HookEnableStateReason | "missing requirements";
  managedByPlugin: boolean;
  requirements: Requirements;
  missing: Requirements;
  configChecks: HookStatusConfigCheck[];
  install: HookInstallOption[];
};

export type HookStatusReport = {
  workspaceDir: string;
  managedHooksDir: string;
  hooks: HookStatusEntry[];
};

function resolveHookKey(entry: HookEntry): string {
  return entry.metadata?.hookKey ?? entry.hook.name;
}

function normalizeInstallOptions(entry: HookEntry): HookInstallOption[] {
  const install = entry.metadata?.install ?? [];
  if (install.length === 0) {
    return [];
  }

  // For hooks, we just list all install options
  return install.map((spec, index) => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();

    if (!label) {
      if (spec.kind === "bundled") {
        label = "Bundled with OpenClaw";
      } else if (spec.kind === "npm" && spec.package) {
        label = `Install ${spec.package} (npm)`;
      } else if (spec.kind === "git" && spec.repository) {
        label = `Install from ${spec.repository}`;
      } else {
        label = "Run installer";
      }
    }

    return { id, kind: spec.kind, label, bins };
  });
}

function buildHookStatus(
  entry: HookEntry,
  config?: OpenClawConfig,
  eligibility?: HookEligibilityContext,
): HookStatusEntry {
  const hookKey = resolveHookKey(entry);
  const hookConfig = resolveHookConfig(config, hookKey);
  const managedByPlugin = entry.hook.source === "openclaw-plugin";
  const enableState = resolveHookEnableState({ entry, config, hookConfig });
  const always = entry.metadata?.always === true;
  const events = entry.metadata?.events ?? [];
  const isEnvSatisfied = (envName: string) =>
    Boolean(process.env[envName] || hookConfig?.env?.[envName]);
  const isConfigSatisfied = (pathStr: string) => isConfigPathTruthy(config, pathStr);

  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryRequirementsForCurrentPlatform({
      always,
      entry,
      hasLocalBin: hasBinary,
      remote: eligibility?.remote,
      isEnvSatisfied,
      isConfigSatisfied,
    });

  const enabledByConfig = enableState.enabled;
  const loadable = enabledByConfig && requirementsSatisfied;
  const blockedReason =
    enableState.reason ?? (requirementsSatisfied ? undefined : "missing requirements");

  return {
    name: entry.hook.name,
    description: entry.hook.description,
    source: entry.hook.source,
    pluginId: entry.hook.pluginId,
    filePath: entry.hook.filePath,
    baseDir: entry.hook.baseDir,
    handlerPath: entry.hook.handlerPath,
    hookKey,
    emoji,
    homepage,
    events,
    always,
    enabledByConfig,
    requirementsSatisfied,
    loadable,
    blockedReason,
    managedByPlugin,
    requirements: required,
    missing,
    configChecks,
    install: normalizeInstallOptions(entry),
  };
}

export function buildWorkspaceHookStatus(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedHooksDir?: string;
    entries?: HookEntry[];
    eligibility?: HookEligibilityContext;
  },
): HookStatusReport {
  const managedHooksDir = opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks");
  const hookEntries = resolveHookEntries(
    opts?.entries ?? loadWorkspaceHookEntries(workspaceDir, opts),
  );

  return {
    workspaceDir,
    managedHooksDir,
    hooks: hookEntries.map((entry) => buildHookStatus(entry, opts?.config, opts?.eligibility)),
  };
}
