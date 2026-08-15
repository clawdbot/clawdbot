// Imessage plugin module resolves and authorizes action message references.
import type { IMessageChatContext } from "./chat-context.js";

type ResolveMessageId = (
  messageId: string,
  options: {
    requireKnownShortId: boolean;
    chatContext: IMessageChatContext;
    requireFromMe?: boolean;
  },
) => string;

type AuthorizeMessageReference = (params: {
  accountId: string;
  chatContext: IMessageChatContext;
  cliPath: string;
  dbPath?: string;
  hasExclusiveLocalDatabase: boolean;
  remoteHost?: string;
  messageId: string;
  conversationReadOrigin?: string;
}) => void;

export async function resolveAuthorizedIMessageActionReference(params: {
  messageId?: string;
  inputChatContext: IMessageChatContext;
  requireFromMe?: boolean;
  resolveFallbackMessageId: (chatContext: IMessageChatContext) => string;
  resolveMessageId: ResolveMessageId;
  authorize: AuthorizeMessageReference;
  authorization: Omit<Parameters<AuthorizeMessageReference>[0], "chatContext" | "messageId">;
  resolveChatGuid: () => Promise<string>;
}): Promise<{ messageId: string; chatGuid: string }> {
  const options = {
    requireKnownShortId: true,
    chatContext: params.inputChatContext,
    ...(params.requireFromMe ? { requireFromMe: true } : {}),
  };
  const rawMessageId = params.messageId ?? params.resolveFallbackMessageId(params.inputChatContext);
  const messageId = params.resolveMessageId(rawMessageId, options);
  const authorize = (authorizedMessageId: string, chatContext: IMessageChatContext) =>
    params.authorize({ ...params.authorization, messageId: authorizedMessageId, chatContext });
  // Alias resolution may call `chats.list`; reject known foreign references
  // before that provider read, then bind again to its canonical result.
  authorize(messageId, params.inputChatContext);
  const chatGuid = await params.resolveChatGuid();
  // The mutation uses this GUID, so authorize it independently. Keeping the
  // original alias here would let an alias-only cache match mask a foreign GUID.
  const chatContext = { chatGuid };
  // Sender ownership was proven against the original selector above. Repeating
  // it here would reject cache entries whose canonical GUID was learned later.
  const resolvedMessageId = params.resolveMessageId(messageId, {
    requireKnownShortId: true,
    chatContext,
  });
  authorize(resolvedMessageId, chatContext);
  return { messageId: resolvedMessageId, chatGuid };
}
