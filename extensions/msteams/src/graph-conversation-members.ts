import { resolveConversationPath, resolveGraphConversationId } from "./graph-messages.js";
import { fetchAllGraphPages } from "./graph.js";

type MSTeamsConversationMember = {
  id?: string;
  userId?: string;
  email?: string;
};

const MAX_CONVERSATION_MEMBER_PAGES = 100;

export async function findMSTeamsConversationMember(params: {
  includeIndirectChannelMembers?: boolean;
  token: string;
  to: string;
  userId: string;
}): Promise<{
  conversationId: string;
  member: MSTeamsConversationMember | undefined;
}> {
  const conversationId = await resolveGraphConversationId(params.to);
  const conversation = resolveConversationPath(conversationId);
  const collection =
    conversation.kind === "channel" && params.includeIndirectChannelMembers
      ? "allMembers"
      : "members";
  const userId = params.userId.trim().toLowerCase();
  const result = await fetchAllGraphPages<MSTeamsConversationMember>({
    token: params.token,
    path: `${conversation.basePath}/${collection}`,
    maxPages: MAX_CONVERSATION_MEMBER_PAGES,
    collectItems: false,
    findOne: (candidate) =>
      candidate.userId?.trim().toLowerCase() === userId ||
      candidate.email?.trim().toLowerCase() === userId,
  });
  if (result.truncated) {
    throw new Error("MS Teams conversation member pagination limit exceeded");
  }

  return { conversationId, member: result.found };
}
