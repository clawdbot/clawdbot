import type { OpenClawConfig } from "../runtime-api.js";
import { resolveConversationPath, resolveGraphConversationId } from "./graph-messages.js";
import { fetchGraphJson } from "./graph.js";

type MSTeamsConversationMember = {
  id?: string;
  userId?: string;
  email?: string;
};

type GraphConversationMembersPage = {
  value?: MSTeamsConversationMember[];
  "@odata.nextLink"?: string;
};

const MAX_CONVERSATION_MEMBER_PAGES = 100;

export async function findMSTeamsConversationMember(params: {
  accountId?: string | null;
  cfg?: OpenClawConfig;
  includeIndirectChannelMembers?: boolean;
  token: string;
  to: string;
  userId: string;
}): Promise<{
  conversationId: string;
  member: MSTeamsConversationMember | undefined;
}> {
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const conversation = resolveConversationPath(conversationId);
  const collection =
    conversation.kind === "channel" && params.includeIndirectChannelMembers
      ? "allMembers"
      : "members";
  let nextPath: string | undefined = `${conversation.basePath}/${collection}`;
  let pages = 0;
  let member: MSTeamsConversationMember | undefined;

  while (nextPath && pages < MAX_CONVERSATION_MEMBER_PAGES && !member) {
    const response: GraphConversationMembersPage =
      await fetchGraphJson<GraphConversationMembersPage>({
        token: params.token,
        path: nextPath,
      });
    const userId = params.userId.trim().toLowerCase();
    member = (response.value ?? []).find(
      (candidate) =>
        candidate.userId?.trim().toLowerCase() === userId ||
        candidate.email?.trim().toLowerCase() === userId,
    );
    nextPath = response["@odata.nextLink"]?.replace("https://graph.microsoft.com/v1.0", "");
    pages += 1;
  }
  if (nextPath && !member) {
    throw new Error("MS Teams conversation member pagination limit exceeded");
  }

  return { conversationId, member };
}
