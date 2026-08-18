import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import type { CommandClientPresentationAction } from "../../app/command-client-presentation.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { SessionCapability, SessionRefreshTarget } from "../../lib/sessions/index.ts";
import type { ChatCommandHost } from "./chat-commands.ts";
import type { ChatRunStartupState } from "./chat-run-startup.ts";
import type { ChatSendTimingEntry } from "./chat-send-ack.ts";
import type { ChatInputHistoryState } from "./input-history.ts";
import type { QueuedMessageEdit } from "./queued-message-edit.ts";
import type { ChatScrollHost } from "./scroll.ts";
import type { ToolStreamHost } from "./tool-stream.ts";

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: AgentsListResult["agents"];
};

export type ChatHost = ChatInputHistoryState &
  ChatScrollHost &
  ToolStreamHost &
  ChatCommandHost & {
    sessions: SessionCapability;
    client: GatewayBrowserClient | null;
    connected: boolean;
    connectionEpoch: number;
    currentSessionId?: string | null;
    reconnectResumeSessionId?: string | null;
    chatLoading: boolean;
    chatMessage: string;
    chatMessages: unknown[];
    chatThinkingLevel: string | null;
    chatVerboseLevel: string | null;
    chatStreamStartedAt: number | null;
    chatAttachments: ChatAttachment[];
    chatQueue: ChatQueueItem[];
    /** Pane-local row draft while a queued message remains held in the outbox. */
    chatQueuedEdit?: QueuedMessageEdit | null;
    /** Active leaf of the history snapshot currently rendered by this pane. */
    chatDisplayedLeafEntryId?: string | null;
    chatRunId: string | null;
    chatRunStartup?: ChatRunStartupState | null;
    chatRunUsageById?: Map<string, number>;
    chatSending: boolean;
    chatSendingScopeKey?: string | null;
    chatRunError?: { summary: string } | null;
    lastError: string | null;
    chatError?: string | null;
    hello: GatewayHelloOk | null;
    requestUpdate?: () => void;
    refreshSessionsAfterChat: Map<string, SessionRefreshTarget>;
    chatSubmitGuards?: Map<string, Promise<void>>;
    chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
    eventLogBuffer?: unknown[];
    assistantAgentId?: string | null;
    agentsList?: ChatAgentsListSnapshot | null;
    settings: Pick<UiSettings, "lastActiveSessionKey"> & Partial<UiSettings>;
    applySettings: (patch: Partial<UiSettings>) => void;
    /** Prepared from the browser override and current Gateway effective queue mode. */
    chatFollowUpMode?: ControlUiFollowUpMode;
    /** Selected message to reply to (right-click / keyboard shortcut). */
    chatReplyTarget?: {
      messageId: string;
      text: string;
      senderLabel?: string | null;
      sourceMessageId?: string | null;
    } | null;
    /** Control UI route for /btw and /side; server/TUI command handling remains unchanged. */
    openSessionCompanion?: (question: string) => Promise<void> | void;
    /** Handles a recognized catalog action only when this client can complete it. */
    dispatchClientPresentation?: (action: CommandClientPresentationAction) => Promise<boolean>;
  };
