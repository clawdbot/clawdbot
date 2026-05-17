import {
  collectConfiguredAgentHarnessRuntimes,
  type ConfiguredAgentHarnessRuntimeOptions,
} from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";

export type ConfiguredRuntimePluginInstallCandidate = {
  pluginId: string;
  label: string;
  npmSpec?: string;
  clawhubSpec?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
  defaultChoice?: PluginPackageInstall["defaultChoice"];
};

export const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES: readonly ConfiguredRuntimePluginInstallCandidate[] =
  [
    {
      pluginId: "acpx",
      label: "ACPX Runtime",
      npmSpec: "@openclaw/acpx",
      trustedSourceLinkedOfficialInstall: true,
    },
    // Runtime-only configs do not have a provider/channel integration catalog entry.
    {
      pluginId: "codex",
      label: "Codex",
      npmSpec: "@openclaw/codex",
      trustedSourceLinkedOfficialInstall: true,
    },
  ];

export function resolveConfiguredRuntimePluginInstallCandidate(
  runtimeId: string,
): ConfiguredRuntimePluginInstallCandidate | undefined {
  return CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.find(
    (candidate) => candidate.pluginId === runtimeId,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function acpxRuntimeIsConfigured(cfg: OpenClawConfig): boolean {
  const acp = asRecord(cfg.acp);
  const backend = typeof acp?.backend === "string" ? acp.backend.trim().toLowerCase() : "";
  return (
    (backend === "acpx" || acp?.enabled === true || asRecord(acp?.dispatch)?.enabled === true) &&
    (!backend || backend === "acpx")
  );
}

export function collectConfiguredRuntimePluginIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options?: ConfiguredAgentHarnessRuntimeOptions,
): string[] {
  const ids = new Set(collectConfiguredAgentHarnessRuntimes(cfg, env, options));
  if (acpxRuntimeIsConfigured(cfg)) {
    ids.add("acpx");
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}
