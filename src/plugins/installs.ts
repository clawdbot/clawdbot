// Normalizes installed plugin config and install records.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";

/** Plugin install record update with the target plugin id attached. */
export type PluginInstallUpdate = PluginInstallRecord & { pluginId: string };

const CLAWHUB_TRUST_INSTALL_RECORD_FIELDS = [
  "clawhubTrustDisposition",
  "clawhubTrustScanStatus",
  "clawhubTrustModerationState",
  "clawhubTrustReasons",
  "clawhubTrustPending",
  "clawhubTrustStale",
  "clawhubTrustCheckedAt",
  "clawhubTrustAcknowledgedAt",
] as const satisfies readonly (keyof PluginInstallRecord)[];

/** Builds install record fields from resolved npm package metadata. */
export function buildNpmResolutionInstallFields(
  resolution?: NpmSpecResolution,
): Pick<
  PluginInstallRecord,
  "resolvedName" | "resolvedVersion" | "resolvedSpec" | "integrity" | "shasum" | "resolvedAt"
> {
  return buildNpmResolutionFields(resolution);
}

function isExactRegistryNpmSpec(spec: string | undefined): spec is string {
  const parsed = spec ? parseRegistryNpmSpec(spec) : null;
  return parsed?.selectorKind === "exact-version";
}

export function resolveNpmInstallRecordSpec(params: {
  requestedSpec?: string;
  resolution?: NpmSpecResolution;
  pinResolvedRegistrySpec?: boolean;
}): string | undefined {
  const resolvedSpec = params.resolution?.resolvedSpec;
  if (!params.pinResolvedRegistrySpec || !isExactRegistryNpmSpec(resolvedSpec)) {
    return params.requestedSpec;
  }
  return resolvedSpec;
}

/** Records or updates a plugin install record in OpenClaw config. */
export function recordPluginInstall(
  cfg: OpenClawConfig,
  update: PluginInstallUpdate,
): OpenClawConfig {
  const { pluginId, ...record } = update;
  const previous = clearStaleInstallRecordFields(cfg.plugins?.installs?.[pluginId]);
  const nextRecord = {
    ...previous,
    ...record,
    installedAt: record.installedAt ?? new Date().toISOString(),
  };

  return {
    ...cfg,
    plugins: {
      // cfg.plugins may be absent on first install; spreading undefined is {}.
      ...cfg.plugins,
      installs: {
        ...cfg.plugins?.installs,
        [pluginId]: nextRecord,
      },
    },
  };
}

function clearStaleInstallRecordFields(record: PluginInstallRecord | undefined) {
  if (!record) {
    return undefined;
  }
  const next: PluginInstallRecord = { ...record };
  for (const field of CLAWHUB_TRUST_INSTALL_RECORD_FIELDS) {
    delete next[field];
  }
  return next;
}
