// Inventory needs capability facts without artifact inspection or lifecycle writes.
import { createHash } from "node:crypto";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { PLUGIN_DECLARED_SURFACE_GROUPS } from "../../packages/gateway-protocol/src/schema/plugin-declared-surface-groups.js";
import type {
  PluginDeclaredSurface,
  PluginHookGrant,
  PluginInspectSource,
  PluginOperatorGrants,
  PluginInstallTrust,
  PluginsInspectResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginAcceptedDeclaredSurface,
  PluginEntryConfig,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import {
  resolveConversationAccessAllowed,
  resolvePromptInjectionAllowed,
} from "./hook-policy-decisions.js";
import type { InstalledPluginInstallRecordInfo } from "./installed-plugin-index-types.js";
import type { InstalledPluginPackageOwnership } from "./installed-plugin-package-ownership.js";
import { PLUGIN_MANIFEST_CONTRACT_KEYS } from "./manifest-contract-keys.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type PluginCapabilityManifest = {
  channels?: readonly string[];
  channel?: { id?: string };
  providers?: readonly (string | { id?: string })[];
  contracts?: PluginManifestRecord["contracts"];
  toolMetadata?: PluginManifestRecord["toolMetadata"];
  hooks?: readonly string[];
  mcpServers?: PluginManifestRecord["mcpServers"];
  cliCommands?: PluginManifestRecord["cliCommands"];
  cliBackends?: readonly string[];
  skills?: readonly string[];
  configContracts?: PluginManifestRecord["configContracts"];
};

export function diffDeclaredSurfaceWidening(
  previous: PluginAcceptedDeclaredSurface,
  next: PluginAcceptedDeclaredSurface,
): { widened: Partial<PluginAcceptedDeclaredSurface>; hasWidening: boolean } {
  const widened: Partial<PluginAcceptedDeclaredSurface> = {};
  for (const group of PLUGIN_DECLARED_SURFACE_GROUPS) {
    const previousValues = new Set(previous[group]);
    const added = next[group].filter((value) => !previousValues.has(value)).toSorted();
    if (added.length > 0) {
      widened[group] = added;
    }
  }
  return { widened, hasWidening: Object.keys(widened).length > 0 };
}

export function mergePluginDeclaredSurfaces(
  surfaces: Iterable<PluginDeclaredSurface>,
): PluginDeclaredSurface {
  const merged: PluginDeclaredSurface = {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  };
  for (const surface of surfaces) {
    for (const group of PLUGIN_DECLARED_SURFACE_GROUPS) {
      merged[group].push(...surface[group]);
    }
  }
  for (const group of PLUGIN_DECLARED_SURFACE_GROUPS) {
    merged[group] = [...new Set(merged[group])].toSorted();
  }
  return merged;
}

/** Acceptance belongs to the package; missing siblings must never shrink its review. */
export function resolvePluginPackageDeclaredSurface(
  ownership: Pick<InstalledPluginPackageOwnership, "pluginIds">,
  manifests: ReadonlyMap<string, PluginManifestRecord>,
): PluginDeclaredSurface | undefined {
  const surfaces: PluginDeclaredSurface[] = [];
  for (const pluginId of ownership.pluginIds) {
    const manifest = manifests.get(pluginId);
    if (!manifest) {
      return undefined;
    }
    surfaces.push(buildPluginCapabilitySummary({ manifest, origin: manifest.origin }).declared);
  }
  return mergePluginDeclaredSurfaces(surfaces);
}

export function computeDeclaredSurfaceHash(declared: PluginAcceptedDeclaredSurface): string {
  const canonical = Object.fromEntries(
    PLUGIN_DECLARED_SURFACE_GROUPS.map((group) => [group, declared[group].toSorted()]),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function resolvePluginInstallRecordIntegrity(
  record: Pick<PluginInstallRecord, "integrity" | "npmIntegrity" | "clawpackSha256" | "gitCommit">,
):
  | { integrity: string; integrityKind: NonNullable<PluginInspectSource["integrityKind"]> }
  | undefined {
  const npmIntegrity = record.integrity ?? record.npmIntegrity;
  if (npmIntegrity) {
    return { integrity: npmIntegrity, integrityKind: "ssri" };
  }
  if (record.clawpackSha256) {
    return { integrity: record.clawpackSha256, integrityKind: "sha256" };
  }
  return record.gitCommit
    ? { integrity: record.gitCommit, integrityKind: "git-commit" }
    : undefined;
}

export function resolveAcceptedSurfaceCurrent(
  record: PluginInstallRecord,
  declared: PluginAcceptedDeclaredSurface,
): boolean {
  return (
    record.acceptedSurface !== undefined &&
    record.acceptedSurfaceHash !== undefined &&
    record.acceptedSurfaceHash === computeDeclaredSurfaceHash(record.acceptedSurface) &&
    record.acceptedSurfaceHash === computeDeclaredSurfaceHash(declared) &&
    record.acceptedSurfaceIntegrity === resolvePluginInstallRecordIntegrity(record)?.integrity
  );
}

export function formatPluginCapabilityConsentRequired(pluginId: string): string {
  return `Plugin "${pluginId}" requires capability consent; disable and re-enable it or run \`openclaw plugins enable ${pluginId} --accept-capabilities\`.`;
}

function buildHookGrant(effective: boolean, configured: boolean | undefined): PluginHookGrant {
  return {
    effective,
    ...(typeof configured === "boolean" ? { configured } : {}),
  };
}

export function buildPluginCapabilitySummary(params: {
  manifest: PluginCapabilityManifest;
  origin: PluginOrigin | "official";
  entryConfig?: PluginEntryConfig;
}): { declared: PluginDeclaredSurface; grants: PluginOperatorGrants } {
  const { manifest, entryConfig } = params;
  const hooks = entryConfig?.hooks;
  const llm = entryConfig?.llm;
  const subagent = entryConfig?.subagent;
  return {
    declared: {
      channels: (
        manifest.channels ?? (manifest.channel?.id ? [manifest.channel.id] : [])
      ).toSorted(),
      providers: (manifest.providers ?? [])
        .flatMap((provider) =>
          typeof provider === "string" ? [provider] : provider.id ? [provider.id] : [],
        )
        .toSorted(),
      tools: [
        ...new Set([
          ...(manifest.contracts?.tools ?? []),
          ...Object.keys(manifest.toolMetadata ?? {}),
        ]),
      ].toSorted(),
      contracts: [
        ...new Set(
          PLUGIN_MANIFEST_CONTRACT_KEYS.flatMap((family) =>
            (manifest.contracts?.[family] ?? []).map((id) => `${family}: ${id}`),
          ),
        ),
      ].toSorted(),
      hooks: (manifest.hooks ?? []).toSorted(),
      mcpServers: Object.keys(manifest.mcpServers ?? {}).toSorted(),
      cliCommands: (manifest.cliCommands ?? []).map((command) => command.name).toSorted(),
      cliBackends: (manifest.cliBackends ?? []).toSorted(),
      skills: (manifest.skills ?? []).toSorted(),
      dangerousConfigFlags: (manifest.configContracts?.dangerousFlags ?? [])
        .map((flag) => flag.path)
        .toSorted(),
    },
    grants: {
      hooks: {
        allowPromptInjection: buildHookGrant(
          resolvePromptInjectionAllowed(hooks),
          hooks?.allowPromptInjection,
        ),
        allowConversationAccess: buildHookGrant(
          resolveConversationAccessAllowed(params.origin, hooks),
          hooks?.allowConversationAccess,
        ),
      },
      ...(llm
        ? {
            llm: {
              ...(llm.allowModelOverride !== undefined
                ? { allowModelOverride: llm.allowModelOverride }
                : {}),
              ...(llm.allowedModels ? { allowedModels: llm.allowedModels.toSorted() } : {}),
              ...(llm.allowedCompletionModels
                ? { allowedCompletionModels: llm.allowedCompletionModels.toSorted() }
                : {}),
              ...(llm.allowAuthProfileOverride !== undefined
                ? { allowAuthProfileOverride: llm.allowAuthProfileOverride }
                : {}),
              ...(llm.allowAgentIdOverride !== undefined
                ? { allowAgentIdOverride: llm.allowAgentIdOverride }
                : {}),
            },
          }
        : {}),
      ...(subagent
        ? {
            subagent: {
              ...(subagent.allowModelOverride !== undefined
                ? { allowModelOverride: subagent.allowModelOverride }
                : {}),
              ...(subagent.allowedModels
                ? { allowedModels: subagent.allowedModels.toSorted() }
                : {}),
            },
          }
        : {}),
    },
  };
}

export type PluginCapabilityConsentReview = Omit<PluginsInspectResult, "ok" | "plugin"> & {
  pluginId: string;
  name: string;
  version?: string;
  widened?: Partial<PluginAcceptedDeclaredSurface>;
  acceptedAt?: string;
};

export function resolvePluginInstallRecordTrust(
  record: InstalledPluginInstallRecordInfo | undefined,
): PluginInstallTrust | undefined {
  if (!record?.clawhubTrustDisposition) {
    return undefined;
  }
  return {
    disposition: record.clawhubTrustDisposition,
    ...(record.clawhubTrustReasons ? { reasons: [...record.clawhubTrustReasons] } : {}),
    ...(record.clawhubTrustCheckedAt ? { checkedAt: record.clawhubTrustCheckedAt } : {}),
    ...(record.clawhubTrustAcknowledgedAt
      ? { acknowledgedAt: record.clawhubTrustAcknowledgedAt }
      : {}),
    ...(record.clawhubTrustPending !== undefined ? { pending: record.clawhubTrustPending } : {}),
    ...(record.clawhubTrustStale !== undefined ? { stale: record.clawhubTrustStale } : {}),
  };
}

export function buildPluginCapabilityConsentReview(params: {
  pluginId: string;
  manifest: Parameters<typeof buildPluginCapabilitySummary>[0]["manifest"] & {
    name?: string;
    version?: string;
  };
  record: PluginInstallRecord;
  config: OpenClawConfig;
  declared?: PluginAcceptedDeclaredSurface;
  previousDeclared?: PluginAcceptedDeclaredSurface;
  widened?: Partial<PluginAcceptedDeclaredSurface>;
}): PluginCapabilityConsentReview {
  const { pluginId, manifest, record } = params;
  const summary = buildPluginCapabilitySummary({
    manifest,
    origin: "global",
    entryConfig: params.config.plugins?.entries?.[pluginId],
  });
  const declared = params.declared ?? summary.declared;
  const spec = record.resolvedSpec ?? record.spec;
  const packageName = record.clawhubPackage ?? record.resolvedName;
  const previousDeclared = params.previousDeclared ?? record.acceptedSurface;
  const widened =
    params.widened ??
    (previousDeclared
      ? diffDeclaredSurfaceWidening(previousDeclared, declared).widened
      : undefined);
  const trust = resolvePluginInstallRecordTrust(record);
  return {
    pluginId,
    name: manifest.name ?? pluginId,
    ...((manifest.version ?? record.version)
      ? { version: manifest.version ?? record.version }
      : {}),
    ...summary,
    declared,
    reviewToken: computeDeclaredSurfaceHash(declared),
    source: {
      kind: record.source,
      // Keep operational specs in install records; prompts and RPCs receive display-safe copies.
      ...(spec ? { spec: redactSensitiveUrlLikeString(spec) } : {}),
      ...(packageName ? { packageName } : {}),
      ...resolvePluginInstallRecordIntegrity(record),
    },
    ...(trust ? { trust } : {}),
    ...(widened && Object.keys(widened).length > 0 ? { widened } : {}),
    ...(record.acceptedSurfaceAt ? { acceptedAt: record.acceptedSurfaceAt } : {}),
  };
}
