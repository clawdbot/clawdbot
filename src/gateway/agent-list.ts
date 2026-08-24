// Gateway agent list projection.
// Combines configured agents and existing on-disk agent state for lightweight UI use.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries, tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionScope } from "../config/sessions.js";
import {
  resolveAgentMainSessionKey,
  resolveSessionRoutingContract,
} from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeMainKey } from "../routing/session-key.js";
import type { GatewayAgentKind } from "../shared/session-types.js";
import { SYSTEM_AGENT_ROSTER_ENTRIES } from "../system-agent/agent-id.js";

type GatewayAgentListRow = {
  id: string;
  kind?: GatewayAgentKind;
  name?: string;
};

export type GatewayAgentOwnership = "sole" | "legacy" | "explicit";

type GatewayAgentSelectionState = {
  defaultId: string;
  ownership: GatewayAgentOwnership;
  selectionRequired: boolean;
};

const OWNER_ROSTER_ENTRIES = SYSTEM_AGENT_ROSTER_ENTRIES satisfies ReadonlyArray<{
  id: string;
  kind: GatewayAgentKind;
}>;

function listExistingAgentIdsFromDisk(): string[] {
  const agentsDir = path.join(resolveStateDir(), "agents");
  try {
    return fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeAgentId(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function resolveGatewayAgentSelectionState(cfg: OpenClawConfig): GatewayAgentSelectionState {
  const configuredIds = listAgentEntries(cfg).map((entry) => normalizeAgentId(entry.id));
  const soleAgentId = tryResolveDefaultAgentId(cfg);
  if (soleAgentId) {
    return {
      defaultId: normalizeAgentId(soleAgentId),
      ownership: "sole",
      selectionRequired: false,
    };
  }
  const legacyAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const legacyCompatibleId = legacyAgentId ?? configuredIds[0];
  if (!legacyCompatibleId) {
    throw new Error("Cannot project gateway agent ownership without a configured agent.");
  }
  const defaultId = normalizeAgentId(legacyCompatibleId);
  return {
    defaultId,
    ownership: legacyAgentId ? "legacy" : "explicit",
    selectionRequired: !legacyAgentId,
  };
}

/** Matches the released Apple projection only for an explicit canonical main target. */
export function matchesLegacyGatewaySessionRoutingContract(params: {
  cfg: OpenClawConfig;
  expectedContract: string;
  agentId?: string;
  sessionKey: string;
}): boolean {
  if (params.cfg.agents?.ownership !== "explicit" || !params.agentId) {
    return false;
  }
  const scope = params.cfg.session?.scope ?? "per-sender";
  if (scope !== "per-sender") {
    return false;
  }
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (resolveSessionRoutingContract(params.cfg) !== [scope, mainKey, "unowned"].join("|")) {
    return false;
  }
  const agentId = normalizeAgentId(params.agentId);
  if (!listAgentEntries(params.cfg).some((entry) => normalizeAgentId(entry.id) === agentId)) {
    return false;
  }
  if (
    params.sessionKey.trim().toLowerCase() !==
    resolveAgentMainSessionKey({ cfg: params.cfg, agentId })
  ) {
    return false;
  }
  const legacyDefaultId = resolveGatewayAgentSelectionState(params.cfg).defaultId;
  return (
    params.expectedContract.trim().toLowerCase() === [scope, mainKey, legacyDefaultId].join("|")
  );
}

/** Lists gateway-visible agents with canonical membership, ordering, and semantic kind. */
export function listGatewayAgentsBasic(cfg: OpenClawConfig): {
  defaultId: string;
  ownership?: GatewayAgentOwnership;
  selectionRequired?: boolean;
  sessionRoutingContract: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentListRow[];
} {
  const ownerEntries = new Map(
    OWNER_ROSTER_ENTRIES.map((entry) => [normalizeAgentId(entry.id), entry] as const),
  );
  const selection = resolveGatewayAgentSelectionState(cfg);
  const defaultId = selection.defaultId;
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<string, { name?: string }>();
  const explicitIds = new Set<string>();
  const diskIds = new Set<string>();
  const agentIds = new Set<string>();
  agentIds.add(normalizeAgentId(defaultId));

  for (const entry of listAgentEntries(cfg)) {
    if (!entry?.id) {
      continue;
    }
    const id = normalizeAgentId(entry.id);
    const configuredName = normalizeOptionalString(entry.name);
    const identityName = normalizeOptionalString(entry.identity?.name);
    configuredById.set(id, { name: configuredName ?? identityName });
    explicitIds.add(id);
    agentIds.add(id);
  }

  for (const id of listExistingAgentIdsFromDisk()) {
    diskIds.add(id);
    agentIds.add(id);
  }

  const allowedIds = explicitIds.size > 0 ? new Set(explicitIds) : null;
  const visibleIds = [...agentIds].filter(
    (id) =>
      !allowedIds ||
      allowedIds.has(id) ||
      // System agents are a separate negotiated surface, not authored roster members.
      (diskIds.has(id) && ownerEntries.has(id)),
  );
  visibleIds.sort((a, b) => a.localeCompare(b));
  const orderedIds =
    defaultId && visibleIds.includes(defaultId)
      ? [defaultId, ...visibleIds.filter((id) => id !== defaultId)]
      : visibleIds;
  if (mainKey && !orderedIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) {
    orderedIds.push(mainKey);
  }

  const agents: GatewayAgentListRow[] = orderedIds.map((id) => ({
    id,
    kind:
      !explicitIds.has(id) && diskIds.has(id) ? (ownerEntries.get(id)?.kind ?? "agent") : "agent",
    name: configuredById.get(id)?.name,
  }));
  return {
    ...selection,
    sessionRoutingContract: resolveSessionRoutingContract(cfg),
    mainKey,
    scope,
    agents,
  };
}
