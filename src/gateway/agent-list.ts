// Gateway agent list projection.
// Combines configured agents and existing on-disk agent state for lightweight UI use.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionScope } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeMainKey } from "../routing/session-key.js";
import type { GatewayAgentKind } from "../shared/session-types.js";
import { SYSTEM_AGENT_ROSTER_ENTRIES } from "../system-agent/agent-id.js";

type GatewayAgentListRow = {
  id: string;
  kind?: GatewayAgentKind;
  name?: string;
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

/** Lists gateway-visible agents with canonical membership, ordering, and semantic kind. */
export function listGatewayAgentsBasic(cfg: OpenClawConfig): {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentListRow[];
} {
  const ownerEntries = new Map(
    OWNER_ROSTER_ENTRIES.map((entry) => [normalizeAgentId(entry.id), entry] as const),
  );
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<string, { name?: string }>();
  const explicitIds = new Set<string>();
  const diskIds = new Set<string>();
  const agentIds = new Set<string>([defaultId]);

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

  const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
  const visibleIds = [...agentIds].filter((id) => (allowedIds ? allowedIds.has(id) : true));
  visibleIds.sort((a, b) => a.localeCompare(b));
  const orderedIds = visibleIds.includes(defaultId)
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
  return { defaultId, mainKey, scope, agents };
}
