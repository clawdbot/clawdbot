import { ensureOnboardingPluginInstalled } from "../commands/onboarding-plugin-install.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginPackageInstall } from "../plugins/manifest.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../plugins/official-external-plugin-catalog.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

const SKIP_VALUE = "__skip__";

export type OfficialPluginOnboardingInstallEntry = {
  pluginId: string;
  label: string;
  description?: string;
  install: PluginPackageInstall;
  trustedSourceLinkedOfficialInstall?: boolean;
};

function isInstalledOrConfigured(config: OpenClawConfig, pluginId: string): boolean {
  return Boolean(config.plugins?.entries?.[pluginId] || config.plugins?.installs?.[pluginId]);
}

function isGenericOfficialPluginEntry(entry: { source?: string; kind?: string }): boolean {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    entry.source === "official" &&
    entry.kind === "plugin" &&
    Boolean(manifest?.plugin?.id) &&
    !manifest?.channel &&
    (manifest?.providers?.length ?? 0) === 0 &&
    (manifest?.webSearchProviders?.length ?? 0) === 0
  );
}

function formatInstallHint(install: PluginPackageInstall): string {
  if (install.clawhubSpec && install.npmSpec) {
    return install.defaultChoice === "clawhub"
      ? "ClawHub, with npm fallback"
      : "npm, with ClawHub fallback";
  }
  if (install.clawhubSpec) {
    return "ClawHub";
  }
  if (install.npmSpec) {
    return "npm";
  }
  if (install.localPath) {
    return "local path";
  }
  return "install source";
}

export const __testing = {
  formatInstallHint,
};

export function resolveOfficialPluginOnboardingInstallEntries(params: {
  config: OpenClawConfig;
}): OfficialPluginOnboardingInstallEntry[] {
  const entries: OfficialPluginOnboardingInstallEntry[] = [];
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    if (!isGenericOfficialPluginEntry(entry)) {
      continue;
    }
    const pluginId = resolveOfficialExternalPluginId(entry);
    const install = resolveOfficialExternalPluginInstall(entry);
    if (!pluginId || !install || isInstalledOrConfigured(params.config, pluginId)) {
      continue;
    }
    entries.push({
      pluginId,
      label: resolveOfficialExternalPluginLabel(entry),
      ...(entry.description ? { description: entry.description } : {}),
      install,
      trustedSourceLinkedOfficialInstall: true,
    });
  }
  return entries.toSorted((left, right) => left.label.localeCompare(right.label));
}

export async function setupOfficialPluginInstalls(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<OpenClawConfig> {
  const installEntries = resolveOfficialPluginOnboardingInstallEntries({
    config: params.config,
  });
  if (installEntries.length === 0) {
    return params.config;
  }

  const selected = await params.prompter.multiselect({
    message: "Install optional plugins",
    options: [
      {
        value: SKIP_VALUE,
        label: "Skip for now",
        hint: "Continue without installing optional plugins",
      },
      ...installEntries.map((entry) => ({
        value: entry.pluginId,
        label: entry.label,
        hint: entry.description ?? formatInstallHint(entry.install),
      })),
    ],
  });

  let next = params.config;
  for (const pluginId of selected.filter((value) => value !== SKIP_VALUE)) {
    const entry = installEntries.find((candidate) => candidate.pluginId === pluginId);
    if (!entry) {
      continue;
    }
    const result = await ensureOnboardingPluginInstalled({
      cfg: next,
      entry,
      prompter: params.prompter,
      runtime: params.runtime,
      workspaceDir: params.workspaceDir,
      promptInstall: false,
    });
    next = result.cfg;
  }
  return next;
}
