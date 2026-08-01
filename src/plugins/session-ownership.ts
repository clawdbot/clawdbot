import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
} from "../sessions/agent-harness-session-key.js";
import type { PluginRegistry } from "./registry-types.js";

export type LockedSessionPluginOwnership = {
  ownerPluginId: string;
  harnessId?: string;
  registration?: PluginRegistry["agentHarnesses"][number];
};

export function resolveAgentHarnessRegistration(params: {
  harnessId: unknown;
  registry: Pick<PluginRegistry, "agentHarnesses">;
}): PluginRegistry["agentHarnesses"][number] | undefined {
  const normalizedHarnessId = normalizeOptionalAgentRuntimeId(params.harnessId);
  return normalizedHarnessId
    ? params.registry.agentHarnesses.find(
        (entry) => normalizeOptionalAgentRuntimeId(entry.harness.id) === normalizedHarnessId,
      )
    : undefined;
}

export function resolveAgentHarnessRegistrationForSessionKey(params: {
  registry: Pick<PluginRegistry, "agentHarnesses">;
  sessionKey: string;
}): PluginRegistry["agentHarnesses"][number] | undefined {
  return params.registry.agentHarnesses.find((entry) => {
    const rawHarnessId = normalizeOptionalString(entry.harness.id)?.toLowerCase();
    return (
      rawHarnessId === normalizeOptionalAgentRuntimeId(rawHarnessId) &&
      isAgentHarnessSessionKeyOwnedBy(params.sessionKey, rawHarnessId)
    );
  });
}

export function assertReservedAgentHarnessSessionKeyOwned(params: {
  action: string;
  pluginId: string;
  registry: Pick<PluginRegistry, "agentHarnesses">;
  sessionKey: unknown;
}): void {
  const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
  if (!normalizedSessionKey || !isAgentHarnessSessionKey(normalizedSessionKey)) {
    return;
  }
  const registration = resolveAgentHarnessRegistrationForSessionKey({
    registry: params.registry,
    sessionKey: normalizedSessionKey,
  });
  if (!registration) {
    throw new Error(
      `Plugin "${params.pluginId}" cannot ${params.action} reserved agent harness session "${normalizedSessionKey}" because its harness is not registered.`,
    );
  }
  if (registration.pluginId !== params.pluginId) {
    throw new Error(
      `Plugin "${params.pluginId}" cannot ${params.action} reserved agent harness session "${normalizedSessionKey}" owned by plugin "${registration.pluginId}".`,
    );
  }
}

export function resolveLockedSessionPluginOwnership(params: {
  action: string;
  entry: SessionEntry;
  pluginId: string;
  registry: Pick<PluginRegistry, "agentHarnesses">;
  sessionKey: string;
}): LockedSessionPluginOwnership | undefined {
  if (params.entry.modelSelectionLocked !== true) {
    return undefined;
  }
  const harnessId = normalizeOptionalAgentRuntimeId(params.entry.agentHarnessId);
  if (!harnessId) {
    const pluginOwnerId = normalizeOptionalString(params.entry.pluginOwnerId);
    if (pluginOwnerId) {
      return { ownerPluginId: pluginOwnerId };
    }
    throw new Error(
      `Plugin "${params.pluginId}" must provide a registered agent harness id to ${params.action} locked sessions.`,
    );
  }
  const registration = resolveAgentHarnessRegistration({
    registry: params.registry,
    harnessId,
  });
  if (!registration) {
    throw new Error(
      `Plugin "${params.pluginId}" must register agent harness "${harnessId}" before it can ${params.action} locked sessions.`,
    );
  }
  if (
    isAgentHarnessSessionKey(params.sessionKey) &&
    !isAgentHarnessSessionKeyOwnedBy(params.sessionKey, harnessId)
  ) {
    throw new Error(
      `Locked session "${params.sessionKey}" belongs to agent harness "${harnessId}", which does not match its reserved session key.`,
    );
  }
  return { ownerPluginId: registration.pluginId, harnessId, registration };
}

export function assertLockedSessionEntryPluginOwned(params: {
  action: string;
  entry: SessionEntry;
  pluginId: string;
  registry: Pick<PluginRegistry, "agentHarnesses">;
  sessionKey: string;
}): void {
  const resolved = resolveLockedSessionPluginOwnership(params);
  if (!resolved) {
    return;
  }
  if (resolved.ownerPluginId !== params.pluginId) {
    throw new Error(
      `Locked session "${params.sessionKey}" is owned by plugin "${resolved.ownerPluginId}", not "${params.pluginId}".`,
    );
  }
}

export function resolveReservedSpawnRequesterOwnerPluginId(params: {
  entry: SessionEntry;
  pluginId: string;
  registry: Pick<PluginRegistry, "agentHarnesses">;
  sessionKey: string;
}): string {
  const explicitOwnerPluginId = normalizeOptionalString(params.entry.pluginOwnerId);
  if (explicitOwnerPluginId && explicitOwnerPluginId !== params.pluginId) {
    throw new Error(
      `Requester session "${params.sessionKey}" is owned by plugin "${explicitOwnerPluginId}", not "${params.pluginId}".`,
    );
  }
  const locked = resolveLockedSessionPluginOwnership({
    action: "spawn a reserved child from",
    entry: params.entry,
    pluginId: params.pluginId,
    registry: params.registry,
    sessionKey: params.sessionKey,
  });
  if (locked?.ownerPluginId === params.pluginId) {
    return locked.ownerPluginId;
  }
  if (locked) {
    throw new Error(
      `Requester session "${params.sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${params.pluginId}".`,
    );
  }
  if (explicitOwnerPluginId) {
    return explicitOwnerPluginId;
  }
  throw new Error(
    `Requester session "${params.sessionKey}" is not owned by plugin "${params.pluginId}".`,
  );
}
