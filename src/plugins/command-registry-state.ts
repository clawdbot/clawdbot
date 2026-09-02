// Stores plugin command registry state for the current process lifecycle.
import { normalizeAgentPromptSurfaceKind } from "./agent-prompt-surface-kind.js";
import { listRegisteredPluginCommands } from "./plugin-command-registry.js";
import { requireActivePluginRegistry } from "./runtime.js";
import type {
  AgentPromptGuidance,
  AgentPromptSurfaceKind,
  OpenClawPluginCommandDefinition,
} from "./types.js";

export type RegisteredPluginCommand = OpenClawPluginCommandDefinition & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
  trustedOwnerStatusExposure?: true;
};

export function clearPluginCommands(): void {
  requireActivePluginRegistry().commands.length = 0;
}

export function isTrustedReservedCommandOwner(command: RegisteredPluginCommand): boolean {
  return command.ownership === "reserved";
}

export function canExposeSenderIsOwner(command: RegisteredPluginCommand): boolean {
  return (
    (Array.isArray(command.requiredScopes) && command.requiredScopes.length > 0) ||
    command.trustedOwnerStatusExposure === true
  );
}

export function listRegisteredPluginAgentPromptGuidance(params?: {
  surface?: AgentPromptSurfaceKind;
  includeLegacyGlobalGuidance?: boolean;
}): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  // Plugin discovery can complete in a different order on the next run; only
  // canonical command ownership may decide bytes in the cached prompt prefix.
  const commands = listRegisteredPluginCommands(requireActivePluginRegistry()).toSorted(
    (left, right) => {
      if (left.pluginId !== right.pluginId) {
        return left.pluginId < right.pluginId ? -1 : 1;
      }
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    },
  );
  for (const command of commands) {
    for (const entry of command.agentPromptGuidance ?? []) {
      const trimmed = resolveAgentPromptGuidanceTextForSurface(entry, {
        surface: params?.surface ? normalizeAgentPromptSurfaceKind(params.surface) : undefined,
        includeLegacyGlobalGuidance: params?.includeLegacyGlobalGuidance ?? true,
      });
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      lines.push(trimmed);
    }
  }
  return lines;
}

function resolveAgentPromptGuidanceTextForSurface(
  entry: AgentPromptGuidance,
  params: {
    surface?: AgentPromptSurfaceKind;
    includeLegacyGlobalGuidance: boolean;
  },
): string | undefined {
  if (typeof entry === "string") {
    return params.includeLegacyGlobalGuidance ? entry.trim() : undefined;
  }
  const text = entry.text.trim();
  if (!params.surface) {
    return text;
  }
  if (!entry.surfaces || entry.surfaces.length === 0) {
    return params.includeLegacyGlobalGuidance ? text : undefined;
  }
  return entry.surfaces.includes(params.surface) ? text : undefined;
}
