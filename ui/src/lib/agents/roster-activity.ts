import type { AgentIdentityResult, AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import { deriveAvatarInitial, resolveAgentAvatarUrl } from "../avatar.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import { buildAgentMainSessionKey, parseAgentSessionKey } from "../sessions/session-key.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar, selectableAgentsList } from "./display.ts";

/** Shared identity, main-chat preview, and activity ordering for agent rosters. */
export function agentRosterCards(
  roster: AgentsListResult | undefined,
  rows: readonly GatewaySessionRow[],
  identityFor: (id: string) => AgentIdentityResult | null = () => null,
) {
  return (roster ? selectableAgentsList(roster).agents : [])
    .map((agent) => {
      const identity = identityFor(agent.id);
      const name = normalizeAgentLabel(agent, identity);
      const mainKey = buildAgentMainSessionKey({ agentId: agent.id, mainKey: roster?.mainKey });
      const sessions = rows.filter(
        (row) => (row.agentId ?? parseAgentSessionKey(row.key)?.agentId) === agent.id,
      );
      const recent = sessions.reduce<GatewaySessionRow | undefined>(
        (latest, row) => (!latest || (row.updatedAt ?? 0) > (latest.updatedAt ?? 0) ? row : latest),
        undefined,
      );
      const main =
        sessions.find((row) => row.key === mainKey) ?? sessions.find((row) => row.isMain);
      return {
        id: agent.id,
        name,
        role: agent.identity?.theme,
        model: agent.model?.primary,
        avatar: resolveAgentAvatarUrl(agent, identity),
        fallback: resolveAgentTextAvatar(agent, identity) ?? deriveAvatarInitial(name),
        mainKey,
        activeNow: sessions.some(isSessionRunActive),
        lastActiveAt: recent?.updatedAt ?? 0,
        preview: (main ?? recent)?.lastMessagePreview,
      };
    })
    .toSorted(
      (a, b) =>
        Number(b.activeNow) - Number(a.activeNow) ||
        b.lastActiveAt - a.lastActiveAt ||
        Number(b.id === roster?.defaultId) - Number(a.id === roster?.defaultId) ||
        a.id.localeCompare(b.id),
    );
}
