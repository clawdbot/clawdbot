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
