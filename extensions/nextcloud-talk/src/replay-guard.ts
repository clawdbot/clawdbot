// Nextcloud Talk plugin module implements replay guard behavior.
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

export const NEXTCLOUD_TALK_PLUGIN_ID = "nextcloud-talk";
export const NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX = "replay-dedupe";
const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_SIZE = 1_000;
const DEFAULT_STATE_MAX_ENTRIES = 10_000;

function buildReplayKey(params: { roomToken: string; messageId: string }): string | null {
  const roomToken = params.roomToken.trim();
  const messageId = params.messageId.trim();
  if (!roomToken || !messageId) {
    return null;
  }
  return `${roomToken}:${messageId}`;
}

type NextcloudTalkReplayGuardOptions = {
  stateDir?: string;
  ttlMs?: number;
  memoryMaxSize?: number;
  stateMaxEntries?: number;
  /** @deprecated Use stateMaxEntries. */
  fileMaxEntries?: number;
  onDiskError?: (error: unknown) => void;
};

export type NextcloudTalkReplayGuard = {
  claimMessage: (params: {
    accountId: string;
    roomToken: string;
    messageId: string;
  }) => Promise<"claimed" | "duplicate" | "inflight" | "invalid">;
  commitMessage: (params: {
    accountId: string;
    roomToken: string;
    messageId: string;
  }) => Promise<boolean>;
  releaseMessage: (params: {
    accountId: string;
    roomToken: string;
    messageId: string;
    error?: unknown;
  }) => void;
  shouldProcessMessage: (params: {
    accountId: string;
    roomToken: string;
    messageId: string;
  }) => Promise<boolean>;
};

export function createNextcloudTalkReplayGuard(
  options: NextcloudTalkReplayGuardOptions,
): NextcloudTalkReplayGuard {
  const stateDir = options.stateDir?.trim();
  const baseOptions = {
    ttlMs: options.ttlMs ?? DEFAULT_REPLAY_TTL_MS,
    memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
  };
  const dedupe = createClaimableDedupe(
    stateDir
      ? {
          ...baseOptions,
          pluginId: NEXTCLOUD_TALK_PLUGIN_ID,
          namespacePrefix: NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
          stateMaxEntries:
            options.stateMaxEntries ?? options.fileMaxEntries ?? DEFAULT_STATE_MAX_ENTRIES,
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
          },
          onDiskError: options.onDiskError,
        }
      : baseOptions,
  );

  return {
    claimMessage: async ({ accountId, roomToken, messageId }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return "invalid";
      }
      const result = await dedupe.claim(replayKey, {
        namespace: accountId,
      });
      return result.kind;
    },
    commitMessage: async ({ accountId, roomToken, messageId }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return true;
      }
      return await dedupe.commit(replayKey, {
        namespace: accountId,
      });
    },
    releaseMessage: ({ accountId, roomToken, messageId, error }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return;
      }
      dedupe.release(replayKey, {
        namespace: accountId,
        error,
      });
    },
    shouldProcessMessage: async ({ accountId, roomToken, messageId }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return true;
      }
      const result = await dedupe.claim(replayKey, {
        namespace: accountId,
      });
      if (result.kind !== "claimed") {
        return false;
      }
      return await dedupe.commit(replayKey, {
        namespace: accountId,
      });
    },
  };
}
