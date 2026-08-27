import { PLUGIN_DECLARED_SURFACE_GROUPS } from "../../packages/gateway-protocol/src/schema/plugin-declared-surface-groups.js";
import type {
  PluginDeclaredSurface,
  PluginHookGrant,
  PluginOperatorGrants,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import {
  resolveConversationAccessAllowed,
  resolvePromptInjectionAllowed,
} from "./hook-policy-decisions.js";
import type { InstalledPluginPackageOwnership } from "./installed-plugin-package-ownership.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestContracts } from "./manifest-types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const MANIFEST_CONTRACT_FAMILIES = [
  "embeddedExtensionFactories",
  "agentToolResultMiddleware",
  "trustedToolPolicies",
  "externalAuthProviders",
  "embeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "usageProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  "tools",
] as const satisfies readonly (keyof PluginManifestContracts)[];

type MissingManifestContractFamilies = Exclude<
  keyof PluginManifestContracts,
  (typeof MANIFEST_CONTRACT_FAMILIES)[number]
>;

const REVIEWED_MANIFEST_CONTRACT_FAMILIES: MissingManifestContractFamilies extends never
  ? typeof MANIFEST_CONTRACT_FAMILIES
  : never = MANIFEST_CONTRACT_FAMILIES;

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
          REVIEWED_MANIFEST_CONTRACT_FAMILIES.flatMap((family) =>
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
