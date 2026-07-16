import type { OpenClawConfig } from "../runtime-api.js";
import { type GraphResponse, fetchGraphJson, resolveGraphToken } from "./graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GraphTeamsChannel = {
  id?: string;
  displayName?: string;
  description?: string;
  membershipType?: string;
  webUrl?: string;
  createdDateTime?: string;
};

export type ListChannelsMSTeamsParams = {
  cfg: OpenClawConfig;
  teamId: string;
};

export type ListChannelsMSTeamsResult = {
  channels: Array<{
    id: string | undefined;
    displayName: string | undefined;
    description: string | undefined;
    membershipType: string | undefined;
  }>;
  truncated?: boolean;
};

export type GetChannelInfoMSTeamsParams = {
  cfg: OpenClawConfig;
  teamId: string;
  channelId: string;
};

export type GetChannelInfoMSTeamsResult = {
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
  const firstPath = `/teams/${encodeURIComponent(params.teamId)}/channels?$select=id,displayName,description,membershipType`;
  const collected: GraphTeamsChannel[] = [];
  let nextPath: string | undefined = firstPath;
  const MAX_PAGES = 10;
  let page = 0;
  while (nextPath && page < MAX_PAGES) {
    type PagedChannelResponse = GraphResponse<GraphTeamsChannel> & {
      "@odata.nextLink"?: string;
    };
    const res: PagedChannelResponse = await fetchGraphJson<PagedChannelResponse>({
      token,
      path: nextPath,
    });
    collected.push(...(res.value ?? []));
    const nextLink: string | undefined = res["@odata.nextLink"];
    // Strip the Graph API root so fetchGraphJson receives a relative path
    nextPath = nextLink ? nextLink.replace("https://graph.microsoft.com/v1.0", "") : undefined;
    page++;
  }
  const channels = collected.map((ch) => ({
    id: ch.id,
    displayName: ch.displayName,
    description: ch.description,
    membershipType: ch.membershipType,
  }));
  return { channels, truncated: !!nextPath };
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
