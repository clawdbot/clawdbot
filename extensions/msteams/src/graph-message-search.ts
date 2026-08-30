import type { OpenClawConfig } from "../runtime-api.js";
import { resolveConversationPath, resolveGraphConversationId } from "./graph-conversation-path.js";
import { stripHtmlFromTeamsMessage } from "./graph-thread.js";
import { fetchGraphAbsoluteUrl, fetchGraphJson, resolveGraphToken } from "./graph.js";

type GraphMessageFrom = {
  user?: { id?: string; displayName?: string };
  application?: { id?: string; displayName?: string };
};

type GraphMessage = {
  id?: string;
  body?: { content?: string; contentType?: string };
  from?: GraphMessageFrom;
  createdDateTime?: string;
};

type SearchMessagesMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  query: string;
  from?: string;
  limit?: number;
};

type SearchMessagesMSTeamsResult = {
  messages: Array<{
    id: string;
    text: string | undefined;
    from: GraphMessageFrom | undefined;
    createdAt: string | undefined;
  }>;
  truncated: boolean;
};

const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_PAGES = 10;

type GraphMessagesPage = {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
};

function normalizeSearchText(message: GraphMessage): string {
  const content = message.body?.content ?? "";
  return message.body?.contentType?.toLowerCase() === "html"
    ? stripHtmlFromTeamsMessage(content)
    : content.trim();
}

function matchesSearchSender(message: GraphMessage, from: string | undefined): boolean {
  const normalized = from?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const sender = message.from?.user ?? message.from?.application;
  return [sender?.id, sender?.displayName].some(
    (value) => value?.trim().toLowerCase() === normalized,
  );
}

export async function searchMessagesMSTeams(
  params: SearchMessagesMSTeamsParams,
): Promise<SearchMessagesMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const { basePath } = resolveConversationPath(conversationId);
  const rawLimit = params.limit ?? SEARCH_DEFAULT_LIMIT;
  const top = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT;
  const query = params.query.trim().toLowerCase();
  const messages: SearchMessagesMSTeamsResult["messages"] = [];
  let nextUrl: string | undefined;
  let truncated = false;

  for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
    const response: GraphMessagesPage = nextUrl
      ? await fetchGraphAbsoluteUrl<GraphMessagesPage>({ token, url: nextUrl })
      : await fetchGraphJson<GraphMessagesPage>({
          token,
          path: `${basePath}/messages?$top=${SEARCH_PAGE_SIZE}`,
        });
    for (const message of response.value ?? []) {
      const searchText = normalizeSearchText(message);
      if (searchText.toLowerCase().includes(query) && matchesSearchSender(message, params.from)) {
        if (messages.length >= top) {
          return { messages, truncated: true };
        }
        messages.push({
          id: message.id ?? "",
          text: message.body?.content,
          from: message.from,
          createdAt: message.createdDateTime,
        });
      }
    }
    nextUrl = response["@odata.nextLink"];
    if (messages.length >= top) {
      return { messages, truncated: Boolean(nextUrl) };
    }
    if (!nextUrl) {
      return { messages, truncated: false };
    }
    truncated = page === SEARCH_MAX_PAGES - 1;
  }
  return { messages, truncated };
}
