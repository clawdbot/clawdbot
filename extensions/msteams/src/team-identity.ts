// Msteams plugin module implements canonical team identity resolution.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { type MSTeamsRequestDeadline, withMSTeamsRequestDeadline } from "./request-timeout.js";

// Team AAD group IDs are stable metadata; a bounded process cache avoids a
// regional Bot Connector lookup on every turn and refreshes on restart.
const teamGroupIdCache = new Map<string, string>();
const TEAM_GROUP_ID_CACHE_MAX_ENTRIES = 500;

function cacheTeamGroupId(conversationTeamId: string, groupId: string): void {
  teamGroupIdCache.set(conversationTeamId, groupId);
  pruneMapToMaxSize(teamGroupIdCache, TEAM_GROUP_ID_CACHE_MAX_ENTRIES);
}

/** Resolve the Graph team GUID without ever treating a Bot Framework team ID as equivalent. */
export async function resolveTeamGroupId(params: {
  conversationTeamId: string;
  aadGroupId?: string;
  getTeamDetails?: (teamId: string) => Promise<{ aadGroupId?: string }>;
  deadline?: MSTeamsRequestDeadline;
}): Promise<string | undefined> {
  const activityGroupId = params.aadGroupId?.trim();
  if (activityGroupId) {
    cacheTeamGroupId(params.conversationTeamId, activityGroupId);
    return activityGroupId;
  }

  const cached = teamGroupIdCache.get(params.conversationTeamId);
  if (cached) {
    return cached;
  }

  const getTeamDetails = params.getTeamDetails;
  if (!getTeamDetails) {
    return undefined;
  }
  const team = await withMSTeamsRequestDeadline({
    deadline: params.deadline,
    label: "MS Teams team details",
    work: () => getTeamDetails(params.conversationTeamId),
  });
  const groupId = team.aadGroupId?.trim();
  if (!groupId) {
    return undefined;
  }
  cacheTeamGroupId(params.conversationTeamId, groupId);
  return groupId;
}
