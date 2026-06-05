// Doctor helpers for installing plugins required by configured agent runtimes.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  collectConfiguredAgentHarnessRuntimes,
  type ConfiguredAgentHarnessRuntimeOptions,
} from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";

export type ConfiguredRuntimePluginInstallCandidate = {
  /** Runtime/plugin id used in config and plugin installation records. */
  pluginId: string;
  /** Human-readable plugin label for prompts and notes. */
  label: string;
  /** npm package spec for an official runtime plugin install. */
  npmSpec?: string;
  /** ClawHub install spec when the runtime plugin is sourced from ClawHub. */
  clawhubSpec?: string;
  /** True when the install source is trusted to link official runtime support. */
  trustedSourceLinkedOfficialInstall?: boolean;
  /** Default installer choice when multiple official sources are available. */
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

/** Resolve the official install candidate for a configured runtime id. */
export function resolveConfiguredRuntimePluginInstallCandidate(
  runtimeId: string,
): ConfiguredRuntimePluginInstallCandidate | undefined {
  return CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.find(
    (candidate) => candidate.pluginId === runtimeId,
  );
}

function acpxRuntimeIsConfigured(cfg: OpenClawConfig): boolean {
  const acp = asOptionalRecord(cfg.acp);
  const backend = typeof acp?.backend === "string" ? acp.backend.trim().toLowerCase() : "";
  return (
    (backend === "acpx" ||
      acp?.enabled === true ||
      asOptionalRecord(acp?.dispatch)?.enabled === true) &&
    (!backend || backend === "acpx")
  );
}

/** Collect runtime plugin ids implied by configured harness runtimes and ACPX settings. */
export function collectConfiguredRuntimePluginIds(
  cfg: OpenClawConfig,
  options?: ConfiguredAgentHarnessRuntimeOptions,
): string[] {
  const ids = new Set(collectConfiguredAgentHarnessRuntimes(cfg, options));
  if (acpxRuntimeIsConfigured(cfg)) {
    ids.add("acpx");
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}
