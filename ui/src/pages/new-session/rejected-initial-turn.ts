import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { admitStoredChatComposerQueueItem } from "../chat/composer-persistence.ts";
import { prepareInitialTurnHandoff } from "../chat/initial-turn-handoff.ts";

/** Returns true when attachment payload ownership moved to the volatile handoff. */
export function retainRejectedInitialTurn(options: {
  agentId: string;
  attachments: ChatAttachment[];
  context: ApplicationContext;
  error: string;
  message: string;
  sessionKey: string;
}): boolean {
  const gateway = options.context.gateway.snapshot;
  const rejectedItem = {
    id: generateUUID(),
    text: options.message,
    attachments: options.attachments,
    createdAt: Date.now(),
    kind: "queued" as const,
    refreshSessions: true,
    sendAttempts: 1,
    sendError: options.error,
    sendState: "failed" as const,
    sessionKey: options.sessionKey,
    agentId: normalizeAgentId(options.agentId),
  };
  const persisted = admitStoredChatComposerQueueItem(
    {
      settings: loadSettings(),
      assistantAgentId: gateway.assistantAgentId,
      agentsList: options.context.agents.state.agentsList,
      hello: gateway.hello,
    },
    options.sessionKey,
    rejectedItem,
  );
  if (persisted) {
    return false;
  }
  // The server already created this key. A volatile handoff prevents retry
  // from creating a duplicate when large attachments exceed browser storage.
  prepareInitialTurnHandoff(options.sessionKey, {
    ...rejectedItem,
    sendRunId: generateUUID(),
  });
  return true;
}
