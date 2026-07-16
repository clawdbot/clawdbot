// Nextcloud Talk plugin module implements replay guard behavior.
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";

export const NEXTCLOUD_TALK_PLUGIN_ID = "nextcloud-talk";
export const NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX = "replay-dedupe";
const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_SIZE = 1_000;
const DEFAULT_STATE_MAX_ENTRIES = 10_000;

function buildNextcloudTalkReplayKey(params: {
  roomToken: string;
  messageId: string;
}): string | null {
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

type NextcloudTalkReplayEvent = {
  accountId: string;
  roomToken: string;
  messageId: string;
};

export function createNextcloudTalkReplayGuard(options: NextcloudTalkReplayGuardOptions) {
  const stateDir = options.stateDir?.trim();
  const baseOptions = {
    ttlMs: options.ttlMs ?? DEFAULT_REPLAY_TTL_MS,
    memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
  };
  return createChannelReplayGuard<NextcloudTalkReplayEvent>({
    dedupe: stateDir
      ? {
          ...baseOptions,
          pluginId: NEXTCLOUD_TALK_PLUGIN_ID,
          namespacePrefix: NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
          stateMaxEntries:
            options.stateMaxEntries ?? options.fileMaxEntries ?? DEFAULT_STATE_MAX_ENTRIES,
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          onDiskError: options.onDiskError,
        }
      : baseOptions,
    buildReplayKey: buildNextcloudTalkReplayKey,
    namespace: (event) => event.accountId,
  });
}

export type NextcloudTalkReplayGuard = ReturnType<typeof createNextcloudTalkReplayGuard>;
