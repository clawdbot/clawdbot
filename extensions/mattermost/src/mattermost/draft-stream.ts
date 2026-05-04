import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import { formatChannelProgressDraftLineForEntry } from "openclaw/plugin-sdk/channel-streaming";
import {
  createMattermostPost,
  deleteMattermostPost,
  updateMattermostPost,
  type MattermostClient,
} from "./client.js";

const MATTERMOST_STREAM_MAX_CHARS = 4000;
const DEFAULT_THROTTLE_MS = 1000;

type MattermostDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  postId: () => string | undefined;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => Promise<void>;
  forceNewMessage: () => void;
};

function normalizeMattermostDraftText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function buildMattermostToolStatusText(params: {
  name?: string;
  phase?: string;
  args?: Record<string, unknown>;
  detailMode?: "explain" | "raw";
  config?: Parameters<typeof formatChannelProgressDraftLineForEntry>[0];
}): string {
  return (
    formatChannelProgressDraftLineForEntry(
      params.config,
      {
        event: "tool",
        name: params.name,
        phase: params.phase,
        args: params.args,
      },
      params.detailMode ? { detailMode: params.detailMode } : undefined,
    ) ?? "Running tool..."
  );
}

export function createMattermostDraftStream(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  maxChars?: number;
  throttleMs?: number;
  renderText?: (text: string) => string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): MattermostDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? MATTERMOST_STREAM_MAX_CHARS,
    MATTERMOST_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const streamState = { stopped: false, final: false };
  let streamPostId: string | undefined;
  let lastSentText = "";

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const rendered = params.renderText?.(text) ?? text;
    const normalized = normalizeMattermostDraftText(rendered, maxChars);
    if (!normalized) {
      return false;
    }
    if (normalized === lastSentText) {
      return true;
    }
    try {
      if (streamPostId) {
        await updateMattermostPost(params.client, streamPostId, {
          message: normalized,
        });
      } else {
        const sent = await createMattermostPost(params.client, {
          channelId: params.channelId,
          message: normalized,
          rootId: params.rootId,
        });
        const postId = sent.id?.trim();
        if (!postId) {
          streamState.stopped = true;
          params.warn?.("mattermost stream preview stopped (missing post id from create)");
          return false;
        }
        streamPostId = postId;
      }
      lastSentText = normalized;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `mattermost stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const { loop, update, stop, clear, discardPending, seal } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId: () => streamPostId,
    clearMessageId: () => {
      streamPostId = undefined;
    },
    isValidMessageId: (value): value is string => typeof value === "string" && value.length > 0,
    deleteMessage: async (postId) => {
      await deleteMattermostPost(params.client, postId);
    },
    warn: params.warn,
    warnPrefix: "mattermost stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    streamPostId = undefined;
    lastSentText = "";
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  params.log?.(`mattermost stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    postId: () => streamPostId,
    clear,
    discardPending,
    seal,
    stop,
    forceNewMessage,
  };
}
