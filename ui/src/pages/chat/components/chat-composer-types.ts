import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { TemplateResult, nothing } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { SessionsListResult } from "../../../api/types.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import type { ControlUiFollowUpMode } from "../../../lib/chat/follow-up-mode.ts";
import type { ProviderUsageDisplayProps } from "../../../lib/provider-quota-summary.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "../input-history.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import type {
  RealtimeTalkCameraDevice,
  RealtimeTalkDeviceIssue,
  RealtimeTalkInputDevice,
} from "../realtime-talk-input.ts";
import type { RealtimeTalkLevelSignal } from "../realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "../realtime-talk.ts";
import type { ChatRunUiStatus } from "../run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus } from "../tool-stream.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachments.ts";
import type {
  ChatComposerPlusMenuProps,
  ChatComposerPlusMenuView,
} from "./chat-composer-plus-menu.ts";
import type { ChatPermissionPickerProps } from "./chat-permission-picker.ts";

/** One shape for queued-row edit state and actions. */
export type ChatQueuedEditProps = {
  /** Id of the row with an inline draft, or null when no row is being edited. */
  editingId: string | null;
  editingText?: string;
  onEdit?: (id: string) => void;
  onEditChange?: (text: string) => void;
  onEditSubmit?: () => void;
  onCancel: () => void;
};

export type CapabilityMenuProps = Omit<
  ChatComposerPlusMenuProps,
  | "attachments"
  | "disabled"
  | "open"
  | "view"
  | "toolOverrides"
  | "onOpenChange"
  | "onViewChange"
  | "showCapabilities"
>;

type ChatComposerDisabledBannerContent = {
  title?: string;
  text: string;
  tone?: "info" | "neutral";
  icon?: "warning";
  actionLabel: string;
  actionStyle?: "primary";
  busy?: boolean;
  busyLabel?: string;
  disabledReason?: string;
  onAction: () => void;
};

export type ChatComposerDisabledBanner = ChatComposerDisabledBannerContent &
  ({ kind: "above-composer" } | { kind: "composer-replacement" });

export type ChatComposerProps = ChatAttachmentControlsProps & {
  paneId: string;
  sessionKey: string;
  currentAgentId: string;
  connected: boolean;
  offline?: boolean;
  queuedOutboxCount?: number;
  canSend: boolean;
  disabledReason: string | null;
  disabledBanner?: ChatComposerDisabledBanner;
  runError?: { summary: string } | null;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  waitingApproval?: boolean;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  progressCard?: ProgressCard | null;
  gatewayQuestionPrompts?: readonly QuestionPrompt[];
  messages: unknown[];
  stream: string | null;
  queue: ChatQueueItem[];
  draft: string;
  sessions: SessionsListResult | null;
  toolOverrides?: SessionToolOverrides;
  capabilityMenu?: CapabilityMenuProps;
  providerUsage?: ProviderUsageDisplayProps;
  assistantName: string;
  sendShortcut?: ChatSendShortcut;
  followUpMode?: ControlUiFollowUpMode;
  pendingAttachmentReads?: number;
  getPendingAttachmentReads?: () => number;
  replyTarget?: {
    messageId: string;
    text: string;
    senderLabel?: string | null;
    sourceMessageId?: string | null;
  } | null;
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
  realtimeTalkDetail?: string | null;
  realtimeTalkInputLevel?: RealtimeTalkLevelSignal;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  realtimeTalkVideoStream?: MediaStream | null;
  realtimeTalkCameraDevices?: RealtimeTalkCameraDevice[];
  realtimeTalkVideoCapable?: boolean;
  realtimeTalkVideoPending?: boolean;
  realtimeTalkCameraError?: boolean;
  gatewayClient?: GatewayBrowserClient | null;
  composerHoldToRecord?: boolean;
  suggestionComposer?: boolean;
  typingActors?: readonly { id: string; label: string }[];
  onTypingChange?: (typing: boolean) => void;
  composerControls?: TemplateResult | typeof nothing;
  permissionPicker?: ChatPermissionPickerProps;
  onDraftChange: (next: string) => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSend: (followUpModeOverride?: "steer") => void;
  onCompact?: () => void | Promise<void>;
  onToggleRealtimeTalk?: () => void;
  onToggleRealtimeCamera?: () => void;
  onSwitchRealtimeCamera?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onDictationError?: (message: string) => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueMove?: (id: string, toIndex: number) => void;
  queuedEdit?: ChatQueuedEditProps;
  onClearReply?: () => void;
  onGoalCommand?: (command: string) => void;
  onGatewayQuestionChange?: () => void;
  onGatewayQuestionSubmit?: (id: string, answers: Record<string, string[]>) => void | Promise<void>;
  onGatewayQuestionSkip?: (id: string) => void | Promise<void>;
};

type PendingClearedSubmittedDraft = {
  key: string;
  value: string;
};

type ComposingDraft = {
  key: string;
  value: string;
};

type SkillMenuTarget = {
  start: number;
  end: number;
  query: string;
};

export type ChatComposerState = {
  slashMenuOpen: boolean;
  slashMenuItems: SlashCommandDef[];
  slashMenuIndex: number;
  slashMenuMode: "command" | "args";
  slashMenuCommand: SlashCommandDef | null;
  slashMenuArgItems: string[];
  slashCommandRefreshPending: boolean;
  skillMenuOpen: boolean;
  skillMenuItems: SlashCommandDef[];
  skillMenuIndex: number;
  skillMenuTarget: SkillMenuTarget | null;
  skillCommandRefreshPending: boolean;
  skillCommandRefreshGeneration: number;
  skillCommandRefreshTargetStart: number | null;
  composerComposing: boolean;
  composingDraft: ComposingDraft | null;
  composerInputIntentKey: string | null;
  pendingClearedSubmittedDraft: PendingClearedSubmittedDraft | null;
  goalExpandedId: string | null;
  activeGatewayQuestionId: string | null;
  gatewayQuestionCollapsed: boolean;
  questionTakeoverActive: boolean;
  restoreComposerFocus: boolean;
  composerInput: HTMLElement | null;
  composerTextarea: HTMLTextAreaElement | null;
  microphonePickerOpen: boolean;
  microphonePickerLoading: boolean;
  microphoneDevices: RealtimeTalkInputDevice[];
  microphoneIssue: RealtimeTalkDeviceIssue | null;
  /** Unsubscribe for the devicechange watch; non-null only while the picker is open. */
  microphoneDeviceWatch: (() => void) | null;
  microphoneDiscoveryRequest: number;
  capabilityMenuOpen: boolean;
  capabilityMenuView: ChatComposerPlusMenuView;
  // Stable Lit refs: inline arrows would change identity per render and force
  // layout observers to detach and reconnect on every chat update.
  composerInputRef: ((element?: Element) => void) | null;
  textareaRef: ((element?: Element) => void) | null;
  dictation: ComposerDictationController | null;
  dictationDraftKey: string | null;
  dictationSelection: { start: number; end: number } | null;
};
