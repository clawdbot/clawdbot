import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type {
  ChatGuardianNotice,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";

export type BuildChatItemsProps = {
  paneId: string;
  sessionKey: string;
  runId?: string | null;
  /** Invalidates cached display copy when the active UI language changes. */
  locale?: string;
  messages: unknown[];
  toolMessages: unknown[];
  guardianNotices?: ChatGuardianNotice[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  queue?: ChatQueueItem[];
  showToolCalls: boolean;
  persistCommentary?: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** True while the current session has an abortable live run. */
  runActive?: boolean;
  questionPrompts?: readonly QuestionPrompt[];
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
};
