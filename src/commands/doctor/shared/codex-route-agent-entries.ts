import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import type { MutableRecord } from "./codex-route-types.js";

type MutableCodexRouteAgentEntry = {
  agent: MutableRecord;
  agentId: string;
  path: string;
};

/** Lists mutable canonical agent entries, with legacy list fallback for raw Doctor input. */
export function listMutableCodexRouteAgentEntries(
  cfg: OpenClawConfig,
): MutableCodexRouteAgentEntry[] {
  const entries = asMutableRecord(cfg.agents?.entries);
  if (entries) {
    return Object.entries(entries).flatMap(([entryId, value]) => {
      const agent = asMutableRecord(value);
      return agent
        ? [{ agent, agentId: normalizeAgentId(entryId), path: `agents.entries.${entryId}` }]
        : [];
    });
  }

  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  return list.flatMap((value, index) => {
    const agent = asMutableRecord(value);
    if (!agent) {
      return [];
    }
    const pathId =
      typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    return [
      {
        agent,
        agentId: normalizeAgentId(typeof agent.id === "string" ? agent.id : undefined),
        path: `agents.list.${pathId}`,
      },
    ];
  });
}
