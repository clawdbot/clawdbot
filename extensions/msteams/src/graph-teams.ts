// Msteams plugin module implements graph teams behavior.
import type { OpenClawConfig } from "../runtime-api.js";
import { fetchAllGraphPages, fetchGraphJson, resolveGraphToken } from "./graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GraphTeamsChannel = {
  id?: string;
  displayName?: string;
  description?: string;
  membershipType?: string;
  webUrl?: string;
  createdDateTime?: string;
};

type ListChannelsMSTeamsParams = {
  cfg: OpenClawConfig;
  teamId: string;
};

type ListChannelsMSTeamsResult = {
  channels: Array<{
    id: string | undefined;
    displayName: string | undefined;
    description: string | undefined;
    membershipType: string | undefined;
  }>;
  truncated?: boolean;
};

type GetChannelInfoMSTeamsParams = {
  cfg: OpenClawConfig;
  teamId: string;
  channelId: string;
};

type GetChannelInfoMSTeamsResult = {
  channel: {
    id: string | undefined;
    displayName: string | undefined;
    description: string | undefined;
    membershipType: string | undefined;
    webUrl: string | undefined;
    createdDateTime: string | undefined;
  };
};

// ---------------------------------------------------------------------------
// List channels for a team
// ---------------------------------------------------------------------------

/**
 * List channels in a team via Graph API.
 * Returns id, displayName, description, and membershipType for each channel.
 * Follows @odata.nextLink for paginated results (up to 10 pages).
 */
export async function listChannelsMSTeams(
  params: ListChannelsMSTeamsParams,
): Promise<ListChannelsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const result = await fetchAllGraphPages<GraphTeamsChannel>({
    token,
    path: `/teams/${encodeURIComponent(params.teamId)}/channels?$select=id,displayName,description,membershipType`,
    maxPages: 10,
  });
  const channels = result.items.map((ch) => ({
    id: ch.id,
    displayName: ch.displayName,
    description: ch.description,
    membershipType: ch.membershipType,
  }));
  return { channels, truncated: result.truncated };
}

// ---------------------------------------------------------------------------
// Get channel info
// ---------------------------------------------------------------------------

/**
 * Get detailed information about a single channel in a team via Graph API.
 * Returns id, displayName, description, membershipType, webUrl, and createdDateTime.
 */
export async function getChannelInfoMSTeams(
  params: GetChannelInfoMSTeamsParams,
): Promise<GetChannelInfoMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const path = `/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}?$select=id,displayName,description,membershipType,webUrl,createdDateTime`;
  const ch = await fetchGraphJson<GraphTeamsChannel>({ token, path });
  return {
    channel: {
      id: ch.id,
      displayName: ch.displayName,
      description: ch.description,
      membershipType: ch.membershipType,
      webUrl: ch.webUrl,
      createdDateTime: ch.createdDateTime,
    },
  };
}
