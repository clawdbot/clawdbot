import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import type { ChatFollowUpMode } from "../../app/settings.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { ChatSideResultPending } from "../../lib/chat/side-result.ts";
import type { SessionCapability, SessionRefreshTarget } from "../../lib/sessions/index.ts";
import type { ChatCommandHost } from "./chat-commands.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import type { ChatSendTimingEntry } from "./chat-send-ack.ts";
import type { ChatInputHistoryState } from "./input-history.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

export type ChatHost = ChatInputHistoryState &
  ChatCommandHost & {
    sessions: SessionCapability;
    client: GatewayBrowserClient | null;
    chatStream: string | null;
    connected: boolean;
    connectionEpoch?: number;
    chatAttachments: ChatAttachment[];
    chatQueue: ChatQueueItem[];
    chatQueueByScope?: Record<string, ChatQueueItem[]>;
    /** Active leaf of the history snapshot currently rendered by this pane. */
    chatDisplayedLeafEntryId?: string | null;
    chatRunId: string | null;
    chatRunStartup?: ChatRunStartupState | null;
    chatRunUsageById?: Map<string, number>;
    chatSending: boolean;
    chatSendingScopeKey?: string | null;
    chatRunError?: { summary: string } | null;
    lastError?: string | null;
    chatError?: string | null;
    hello: GatewayHelloOk | null;
    renderLifecycle?: RenderLifecycle;
    requestUpdate?: () => void;
    refreshSessionsAfterChat: Map<string, SessionRefreshTarget>;
    chatSubmitGuards?: Map<string, Promise<void>>;
    chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
    eventLogBuffer?: unknown[];
    assistantAgentId?: string | null;
    agentsList?: ChatAgentsListSnapshot | null;
    settings?: { chatFollowUpMode?: ChatFollowUpMode };
    /** Prepared from the browser override and current Gateway effective queue mode. */
    chatFollowUpMode?: ControlUiFollowUpMode;
    /** Selected message to reply to (right-click / keyboard shortcut). */
    chatReplyTarget?: {
      messageId: string;
      text: string;
      senderLabel?: string | null;
      sourceMessageId?: string | null;
    } | null;
    /** Placeholder for an in-flight /btw side question awaiting chat.side_result. */
    chatSideResultPending?: ChatSideResultPending | null;
    /** Retired/handled BTW run ids whose late events must not reach the transcript. */
    chatSideResultTerminalRuns?: Set<string>;
    /** Side-chat panel closed via X/Escape; a new question reopens it. */
    chatSideChatHidden?: boolean;
  };
