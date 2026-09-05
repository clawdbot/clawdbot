import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { TemplateResult, nothing } from "lit";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type {
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import type { ChatFollowUpMode, ChatSendShortcut } from "../../../app/settings.ts";
import type {
  ChatGoalAction,
  ChatGoalDraft,
  ChatGoalDraftMode,
  ChatQueueItem,
  HumanMention,
} from "../../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../../lib/chat/follow-up-mode.ts";
import type { HumanMentionInput } from "../../../lib/chat/human-mentions.ts";
import type { ProviderUsageDisplayProps } from "../../../lib/provider-quota-summary.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import type { ComposerMicrophonePicker } from "../composer-microphone-picker.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "../input-history.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import type { RealtimeTalkCameraDevice } from "../realtime-talk-input.ts";
import type { RealtimeTalkLevelSignal } from "../realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "../realtime-talk.ts";
import type { ChatRunUiStatus } from "../run-lifecycle.ts";
import type { FallbackStatus } from "../tool-stream-contract.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachments.ts";
import type { HumanMentionDirectory, HumanMentionMenu } from "./chat-composer-mention-menu.ts";
import type {
  ChatComposerCapabilityMenuProps,
  ChatComposerPlusMenuView,
} from "./chat-composer-plus-menu.ts";
import type { SkillMenuState } from "./chat-composer-skill-menu.ts";
import type { SlashMenuState } from "./chat-composer-slash-menu.ts";
import type { ChatPermissionPickerProps } from "./chat-permission-picker.ts";

/** One shape for queued-row edit state and actions. */
type ChatQueuedEditProps = {
  /** Id of the row with an inline draft, or null when no row is being edited. */
  editingId: string | null;
  editingText?: string;
  editingMentions?: readonly HumanMention[];
  source?: ChatQueueItem;
  onEdit?: (id: string) => void;
  onEditChange?: (text: string, mentions?: readonly HumanMention[]) => void;
  onEditSubmit?: () => void;
  onCancel: () => void;
};

export type CapabilityMenuProps = ChatComposerCapabilityMenuProps;

type ChatComposerDisabledBannerContent = {
  title?: string;
  text: string;
  tone?: "info" | "neutral";
  icon?: "warning" | "archive";
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
  disabledReasonTone?: "info" | "danger";
  disabledReasonBusy?: boolean;
  disabledBanner?: ChatComposerDisabledBanner;
  runError?: { summary: string } | null;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  waitingApproval?: boolean;
  fallbackStatus?: FallbackStatus | null;
  progressCard?: ProgressCard | null;
  progressCardError?: string;
  runActive?: boolean;
  collapseTaskProgress?: boolean;
  runId?: string | null;
  onDismissProgressCard?: (card: ProgressCard) => void;
  gatewayQuestionPrompts?: readonly QuestionPrompt[];
  messages: unknown[];
  stream: string | null;
  queue: ChatQueueItem[];
  draft: string;
  mentions?: readonly HumanMention[];
  getMentions?: () => readonly HumanMention[];
  mentionDirectory?: HumanMentionDirectory;
  mentionsUnsupported?: boolean;
  modelCatalog: readonly ModelCatalogEntry[];
  modelSwitching: boolean;
  sessions: SessionsListResult | null;
  /** The pane resolves aliases and agent ownership; absence must not reuse an unowned row. */
  selectedSession?: GatewaySessionRow;
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
  realtimeTalkInputDeviceId?: string;
  onComposerHoldToRecordChange?: (enabled: boolean) => void;
  onOpenTalkSettings?: () => void;
  onOpenDictationSettings?: () => void;
  suggestionComposer?: boolean;
  typingActors?: readonly { id: string; label: string; preview?: string }[];
  onTypingChange?: (typing: boolean, preview?: string) => void;
  composerControls?: TemplateResult | typeof nothing;
  anchoredNotices?: TemplateResult | typeof nothing;
  permissionPicker?: ChatPermissionPickerProps;
  onDraftChange: (next: string, mentions?: readonly HumanMention[]) => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSlashCommand?: (command: string) => void;
  onSend: (
    followUpModeOverride?: ChatFollowUpMode,
    submissionAction?: Event,
  ) => void | Promise<boolean | void>;
  onToggleRealtimeTalk?: () => void;
  onToggleRealtimeCamera?: () => void;
  onSwitchRealtimeCamera?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onUseSystemDefaultMicrophone?: () => Promise<void>;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueMove?: (id: string, toIndex: number) => void;
  queuedEdit?: ChatQueuedEditProps;
  onClearReply?: () => void;
  onGoalAction?: (goalId: string, action: ChatGoalAction) => void;
  onGoalSubmit?: (draft: ChatGoalDraft, submissionAction?: Event) => Promise<boolean>;
  goalDraftMode?: ChatGoalDraftMode | null;
  onGoalDraftModeChange?: (mode: ChatGoalDraftMode | null) => void;
  currentSessionId?: string | null;
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

export type ChatComposerState = SkillMenuState &
  SlashMenuState & {
    composerComposing: boolean;
    mentionMenu: HumanMentionMenu;
    mentionInput?: HumanMentionInput;
    composingDraft: ComposingDraft | null;
    composerInputIntentKey: string | null;
    pendingClearedSubmittedDraft: PendingClearedSubmittedDraft | null;
    goalExpandedId: string | null;
    goalComposer: (ChatGoalDraftMode & { key: string; pending: boolean }) | null;
    activeGatewayQuestionId: string | null;
    gatewayQuestionCollapsed: boolean;
    questionTakeoverActive: boolean;
    restoreComposerFocus: boolean;
    composerInput: HTMLElement | null;
    composerTextarea: HTMLTextAreaElement | null;
    microphonePicker: ComposerMicrophonePicker | null;
    capabilityMenuOpen: boolean;
    capabilityMenuView: ChatComposerPlusMenuView;
    // Stable Lit refs: inline arrows would change identity per render and force
    // layout observers to detach and reconnect on every chat update.
    composerInputRef: ((element?: Element) => void) | null;
    textareaRef: ((element?: Element) => void) | null;
    dictation: ComposerDictationController | null;
    composerDraftScopeKey: string | null;
    dictationError: string | null;
    dictationSelection: { start: number; end: number; value: string } | null;
  };
