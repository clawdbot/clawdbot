// Matrix inbound replay protection: /sync replays events after an unclean
// shutdown and the decrypt bridge re-emits decrypted events, so each
// (account, room, event) is claimed before handling and committed only after
// reply dispatch succeeds; release on retryable failure reopens the event.
import {
  createClaimableDedupe,
  resolvePersistentDedupePluginStateNamespace,
} from "openclaw/plugin-sdk/persistent-dedupe";
import type { MatrixAuth } from "../client/types.js";
import { LogService } from "../sdk/logger.js";

const MATRIX_INBOUND_DEDUPE_PLUGIN_ID = "matrix";
// One shared "global" namespace with the account baked into each key: the
// plugin-state fuse sheds only the writing namespace, so per-account
// namespaces could starve a new account once older ones fill the per-plugin
// row budget. A single bounded pool stays far under that fuse. The qa-matrix
// runtime-state probe mirrors this prefix and key shape when asserting commits.
const MATRIX_INBOUND_DEDUPE_NAMESPACE_PREFIX = "matrix.inbound-dedupe";
const MATRIX_INBOUND_DEDUPE_NAMESPACE = "global";
// 30d window: a /sync backlog after long downtime can resurface old events.
export const MATRIX_INBOUND_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MATRIX_INBOUND_DEDUPE_MEMORY_MAX = 5_000;
export const MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES = 20_000;

export type MatrixInboundEventDeduper = {
  /** True when the caller now owns the event; false for committed or in-flight duplicates. */
  claimEvent: (params: { roomId: string; eventId: string }) => Promise<boolean>;
  /** Records a handled event so restart/replay cannot dispatch it again. */
  commitEvent: (params: { roomId: string; eventId: string }) => Promise<void>;
  /** Drops an uncommitted claim so a failed dispatch can retry the event. */
  releaseEvent: (params: { roomId: string; eventId: string }) => void;
};

function resolveMatrixInboundDedupeAccountId(accountId: string): string {
  return accountId.trim() || "default";
}

export function buildMatrixInboundDedupeEventKey(params: {
  accountId: string;
  roomId: string;
  eventId: string;
}): string | null {
  const roomId = params.roomId.trim();
  const eventId = params.eventId.trim();
  if (!roomId || !eventId) {
    return null;
  }
  // NUL separators: room-version 1/2 event ids may contain ":", so a printable
  // separator could collide two distinct (account, room, event) triples.
  return `${resolveMatrixInboundDedupeAccountId(params.accountId)}\0${roomId}\0${eventId}`;
}

/** Persisted plugin-state namespace holding the inbound dedupe rows. */
export function resolveMatrixInboundDedupeStateNamespace(): string {
  return resolvePersistentDedupePluginStateNamespace({
    namespace: MATRIX_INBOUND_DEDUPE_NAMESPACE,
    namespacePrefix: MATRIX_INBOUND_DEDUPE_NAMESPACE_PREFIX,
  });
}

export function createMatrixInboundEventDeduper(params: {
  auth: Pick<MatrixAuth, "accountId">;
  env?: NodeJS.ProcessEnv;
}): MatrixInboundEventDeduper {
  const guard = createClaimableDedupe({
    pluginId: MATRIX_INBOUND_DEDUPE_PLUGIN_ID,
    namespacePrefix: MATRIX_INBOUND_DEDUPE_NAMESPACE_PREFIX,
    ttlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
    memoryMaxSize: MATRIX_INBOUND_DEDUPE_MEMORY_MAX,
    stateMaxEntries: MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
    ...(params.env ? { env: params.env } : {}),
    // Persistence is best effort: a broken state DB must never block inbound
    // handling, so disk errors log and the memory layer keeps deduping.
    onDiskError: (err) => {
      LogService.warn("MatrixInboundDedupe", "Matrix inbound dedupe persistence failed:", err);
    },
  });
  const accountId = params.auth.accountId;
  const namespace = MATRIX_INBOUND_DEDUPE_NAMESPACE;
  return {
    claimEvent: async (ids) => {
      const key = buildMatrixInboundDedupeEventKey({ accountId, ...ids });
      if (!key) {
        // Fail open: never suppress an event we cannot identify.
        return true;
      }
      return (await guard.claim(key, { namespace })).kind === "claimed";
    },
    commitEvent: async (ids) => {
      const key = buildMatrixInboundDedupeEventKey({ accountId, ...ids });
      if (!key) {
        return;
      }
      await guard.commit(key, { namespace });
    },
    releaseEvent: (ids) => {
      const key = buildMatrixInboundDedupeEventKey({ accountId, ...ids });
      if (key) {
        guard.release(key, { namespace });
      }
    },
  };
}
