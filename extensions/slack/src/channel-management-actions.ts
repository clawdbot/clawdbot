// Slack channel management actions (create/rename/invite/kick/archive).
import { getClient, type SlackActionClientOpts } from "./actions.js";

export type SlackChannelManagementResult = {
  channelId?: string;
  name?: string;
};

export async function createSlackChannel(
  name: string,
  opts: SlackActionClientOpts & { isPrivate?: boolean } = {},
): Promise<SlackChannelManagementResult> {
  const client = await getClient(opts, "write");
  const result = await client.conversations.create({
    name,
    ...(opts.isPrivate ? { is_private: true } : {}),
  });
  return { channelId: result.channel?.id, name: result.channel?.name };
}

export async function renameSlackChannel(
  channelId: string,
  name: string,
  opts: SlackActionClientOpts = {},
): Promise<SlackChannelManagementResult> {
  const client = await getClient(opts, "write");
  const result = await client.conversations.rename({ channel: channelId, name });
  return { channelId: result.channel?.id, name: result.channel?.name };
}

export async function addSlackChannelMember(
  channelId: string,
  userId: string,
  opts: SlackActionClientOpts = {},
): Promise<SlackChannelManagementResult> {
  const client = await getClient(opts, "write");
  await client.conversations.invite({ channel: channelId, users: userId });
  return { channelId };
}

export async function removeSlackChannelMember(
  channelId: string,
  userId: string,
  opts: SlackActionClientOpts = {},
): Promise<SlackChannelManagementResult> {
  const client = await getClient(opts, "write");
  await client.conversations.kick({ channel: channelId, user: userId });
  return { channelId };
}

export async function archiveSlackChannel(
  channelId: string,
  opts: SlackActionClientOpts = {},
): Promise<SlackChannelManagementResult> {
  const client = await getClient(opts, "write");
  await client.conversations.archive({ channel: channelId });
  return { channelId };
}
