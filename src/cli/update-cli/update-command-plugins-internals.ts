import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { pathExists } from "../../infra/fs-safe.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../../plugins/config-state.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "../../plugins/official-external-install-records.js";
import { resolveUserPath } from "../../utils.js";
import {
  hasNativePackageInstallPayload,
  resolveBundleInstallRecordPayload,
  validateBundleInstallRecordPayload,
} from "./plugin-payload-validation.js";

export type PostCorePluginUpdateResult = NonNullable<
  NonNullable<UpdateRunResult["postUpdate"]>["plugins"]
>;

export type MissingPluginInstallPayload = {
  pluginId: string;
  installPath?: string;
  reason: "missing-install-path" | "missing-package-dir" | "missing-package-json";
};

export function resolvePostSyncPluginUpdateSkipIds(params: {
  switchedToClawHub: readonly string[];
  switchedToNpm: readonly string[];
  repairedMissingPayloadIds: ReadonlySet<string>;
}): Set<string> {
  return new Set([
    ...params.switchedToClawHub,
    ...params.switchedToNpm,
    ...params.repairedMissingPayloadIds,
  ]);
}

function isTrackedPackageInstallRecord(record: PluginInstallRecord): boolean {
  return (
    record.source === "npm" ||
    record.source === "clawhub" ||
    record.source === "git" ||
    record.source === "marketplace"
  );
}

export async function collectMissingPluginInstallPayloads(params: {
  records: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
  skipDisabledPlugins?: boolean;
  syncOfficialPluginInstalls?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<MissingPluginInstallPayload[]> {
  const env = params.env ?? process.env;
  const normalizedPluginConfig =
    params.skipDisabledPlugins && params.config
      ? normalizePluginsConfig(params.config.plugins)
      : undefined;
  const missing: MissingPluginInstallPayload[] = [];
  for (const [pluginId, record] of Object.entries(params.records).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isTrackedPackageInstallRecord(record)) {
      continue;
    }
    const officialNpmSpec = params.syncOfficialPluginInstalls
      ? resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId, record })
      : undefined;
    const officialClawHubSpec = params.syncOfficialPluginInstalls
      ? resolveTrustedSourceLinkedOfficialClawHubSpec({ pluginId, record })
      : undefined;
    if (normalizedPluginConfig && params.config) {
      const enableState = resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.config,
      });
      if (!enableState.enabled && !officialNpmSpec && !officialClawHubSpec) {
        continue;
      }
    }
    const rawInstallPath = normalizeOptionalString(record.installPath);
    if (!rawInstallPath) {
      missing.push({ pluginId, reason: "missing-install-path" });
      continue;
    }
    const installPath = resolveUserPath(rawInstallPath, env);
    if (!(await pathExists(installPath))) {
      missing.push({ pluginId, installPath, reason: "missing-package-dir" });
      continue;
    }
    const bundlePayload = resolveBundleInstallRecordPayload({ record, installPath });
    if (bundlePayload.isBundlePayload) {
      if (await hasNativePackageInstallPayload(installPath)) {
        continue;
      }
      const bundleFailure = validateBundleInstallRecordPayload({
        pluginId,
        installPath,
        record,
        bundleFormat: bundlePayload.bundleFormat,
      });
      if (bundleFailure) {
        missing.push({ pluginId, installPath, reason: "missing-package-json" });
      }
      continue;
    }
    const packageJsonPath = path.join(installPath, "package.json");
    if (!(await pathExists(packageJsonPath))) {
      missing.push({ pluginId, installPath, reason: "missing-package-json" });
    }
  }
  return missing;
}

/**
 * Build the post-core-update result we return when the active config cannot
 * even be parsed. Mandatory post-core convergence requires a parseable
 * config to know which plugins are configured; if one isn't available, we
 * refuse to restart the gateway and surface this as a hard error so the
 * existing `status === "error"` => `exit 1` pre-restart gate fires.
 */
export function buildInvalidConfigPostCoreUpdateResult(): {
  message: string;
  guidance: string[];
  result: PostCorePluginUpdateResult;
} {
  const guidance = [
    "Run `openclaw doctor` to inspect the config validation errors.",
    "Once the config parses, rerun `openclaw update repair`.",
  ];
  const message =
    "Plugin post-update convergence skipped because the config is invalid; refusing to restart the gateway with an unverified plugin set.";
  return {
    message,
    guidance,
    result: {
      status: "error",
      reason: "invalid-config",
      changed: false,
      sync: {
        changed: false,
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
      npm: {
        changed: false,
        outcomes: [],
      },
      integrityDrifts: [],
      warnings: [{ reason: "invalid-config", message, guidance }],
    },
  };
}
