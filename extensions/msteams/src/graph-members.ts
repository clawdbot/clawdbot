// Msteams plugin module implements graph members behavior.
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveConversationPath, resolveGraphConversationId } from "./graph-messages.js";
import { fetchGraphJson, resolveGraphToken } from "./graph.js";

type GetMemberInfoMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  userId: string;
  currentRequesterId?: string | null;
};

type GetMemberInfoMSTeamsResult = {
  user: {
    id: string | undefined;
    displayName: string | undefined;
    mail: string | undefined;
    jobTitle: string | undefined;
    userPrincipalName: string | undefined;
    officeLocation: string | undefined;
    roles: string[];
  };
};

type GraphConversationMember = {
  displayName?: string;
  userId?: string;
  email?: string;
  roles?: string[];
};

type GraphConversationMembersPage = {
  value?: GraphConversationMember[];
  "@odata.nextLink"?: string;
};

const MAX_TEAM_MEMBER_PAGES = 100;

function normalizeUserId(value?: string | null): string {
  return (
    value
      ?.replace(/^(msteams|teams|user):/i, "")
      .trim()
      .toLowerCase() ?? ""
  );
}

async function findStandardChannelMember(params: {
  token: string;
  to: string;
  userId: string;
}): Promise<GraphConversationMember | undefined> {
  const conversationId = await resolveGraphConversationId(params.to);
  const conversation = resolveConversationPath(conversationId);
  if (conversation.kind !== "channel" || !conversation.teamId) {
    return undefined;
  }
  const channel = await fetchGraphJson<{ membershipType?: string }>({
    token: params.token,
    path: `${conversation.basePath}?$select=membershipType`,
  });
  if (channel.membershipType !== "standard") {
    throw new Error(
      "Microsoft Teams member-info requires a standard channel when using the configured permission baseline.",
    );
  }

  const requestedUserId = normalizeUserId(params.userId);
  let nextPath: string | undefined = `/teams/${encodeURIComponent(conversation.teamId)}/members`;
  let pages = 0;
  while (nextPath && pages < MAX_TEAM_MEMBER_PAGES) {
    const response: GraphConversationMembersPage =
      await fetchGraphJson<GraphConversationMembersPage>({
        token: params.token,
        path: nextPath,
      });
    const member = (response.value ?? []).find(
      (candidate) =>
        normalizeUserId(candidate.userId) === requestedUserId ||
        normalizeUserId(candidate.email) === requestedUserId,
    );
    if (member) {
      return member;
    }
    nextPath = response["@odata.nextLink"]?.replace("https://graph.microsoft.com/v1.0", "");
    pages += 1;
  }
  if (nextPath) {
    throw new Error("Microsoft Teams team member pagination limit exceeded");
  }
  return undefined;
}

/**
 * Fetch a user profile from Microsoft Graph by user ID.
 */
export async function getMemberInfoMSTeams(
  params: GetMemberInfoMSTeamsParams,
): Promise<GetMemberInfoMSTeamsResult> {
  const isCurrentRequester =
    normalizeUserId(params.userId) === normalizeUserId(params.currentRequesterId);
  if (isCurrentRequester && resolveConversationPath(params.to).kind === "chat") {
    return {
      user: {
        id: params.currentRequesterId ?? undefined,
        displayName: undefined,
        mail: undefined,
        jobTitle: undefined,
        userPrincipalName: undefined,
        officeLocation: undefined,
        roles: [],
      },
    };
  }
  const conversationId = await resolveGraphConversationId(params.to);
  const conversation = resolveConversationPath(conversationId);
  const member =
    conversation.kind === "channel"
      ? await findStandardChannelMember({
          token: await resolveGraphToken(params.cfg),
          to: params.to,
          userId: params.userId,
        })
      : undefined;
  if (!member?.userId) {
    throw new Error(`User ${params.userId} is not a member of this conversation`);
  }
  return {
    user: {
      id: member.userId,
      displayName: member.displayName,
      mail: member.email,
      jobTitle: undefined,
      userPrincipalName: member.email,
      officeLocation: undefined,
      roles: member.roles ?? [],
    },
  };
}
