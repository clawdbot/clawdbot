import type { ClickClackClient } from "./http-client.js";

export async function resolveWorkspaceId(client: ClickClackClient, workspace: string) {
  if (workspace.startsWith("wsp_")) {
    return workspace;
  }
  const workspaces = await client.workspaces();
  const found = workspaces.find(
    (candidate) =>
      candidate.id === workspace || candidate.slug === workspace || candidate.name === workspace,
  );
  if (!found) {
    throw new Error(`ClickClack workspace not found: ${workspace}`);
  }
  return found.id;
}

export async function resolveChannelId(
  client: ClickClackClient,
  workspaceId: string,
  channel: string,
) {
  if (channel.startsWith("chn_")) {
    return channel;
  }
  const channels = await client.channels(workspaceId);
  const found = channels.find(
    (candidate) => candidate.id === channel || candidate.name === channel,
  );
  if (!found) {
    throw new Error(`ClickClack channel not found: ${channel}`);
  }
  return found.id;
}
