import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

type BlueBubblesGroupConfig = {
  /** If true, only respond in this group when mentioned. */
  requireMention?: boolean;
  /** Optional tool policy overrides for this group. */
  tools?: { allow?: string[]; deny?: string[] };
  /**
   * Free-form directive appended to the system prompt on every turn that
   * handles a message in this group.
   */
  systemPrompt?: string;
};

type BlueBubblesActionConfig = {
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  sendWithEffect?: boolean;
  renameGroup?: boolean;
  setGroupIcon?: boolean;
  addParticipant?: boolean;
  removeParticipant?: boolean;
  leaveGroup?: boolean;
  sendAttachment?: boolean;
};

type BlueBubblesNetworkConfig = {
  /** Dangerous opt-in for same-host or trusted private/internal BlueBubbles deployments. */
  dangerouslyAllowPrivateNetwork?: boolean;
};

export type BlueBubblesAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this BlueBubbles account. Default: true. */
  enabled?: boolean;
  /** Base URL for the BlueBubbles API. */
  serverUrl?: string;
  /** Password for BlueBubbles API authentication. */
  password?: string;
  /** Webhook path for the gateway HTTP server. */
  webhookPath?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  /** Optional allowlist for group senders. */
  groupAllowFrom?: Array<string | number>;
  /** Group message handling policy. */
  groupPolicy?: GroupPolicy;
  /** Enrich unnamed group participants with local macOS Contacts names after gating. Default: true. */
  enrichGroupParticipantsFromContacts?: boolean;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, unknown>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /**
   * Per-request timeout (ms) for outbound text sends via
   * `/api/v1/message/text` and the `createNewChatWithMessage` send path.
   * Probes, chat lookups, catchup, and history keep the shorter default.
   * Raise this on macOS 26 setups where Private API iMessage sends can stall
   * for 60+s. Default: 30000.
   *
   * Reaction and edit paths (`sendBlueBubblesReaction`,
   * `editBlueBubblesMessage`, `unsendBlueBubblesMessage`) still honor the
   * shorter client default unless the caller passes `opts.timeoutMs` — covering
   * those uniformly from config is tracked as a follow-up. (#67486)
   */
  sendTimeoutMs?: number;
  /** Chunking mode: "newline" (default) splits on every newline; "length" splits by size. */
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: Record<string, unknown>;
  /**
   * When an inbound reply lands without `replyToBody`/`replyToSender` and the
   * in-memory reply cache misses (e.g., multi-instance deployments sharing
   * one BlueBubbles account, after process restarts, or after long-lived
   * cache eviction), fetch the original message from the BlueBubbles HTTP API
   * as a best-effort fallback. Default: false.
   */
  replyContextApiFallback?: boolean;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /**
   * Explicit allowlist of local directory roots permitted for outbound media paths.
   * Local paths are rejected unless they resolve under one of these roots.
   */
  mediaLocalRoots?: string[];
  /** Send read receipts for incoming messages (default: true). */
  sendReadReceipts?: boolean;
  /** Network policy overrides for same-host or trusted private/internal BlueBubbles deployments. */
  network?: BlueBubblesNetworkConfig;
  /** Per-group configuration keyed by chat GUID or identifier. */
  groups?: Record<string, BlueBubblesGroupConfig>;
  /** Per-action tool gating (default: true for all). */
  actions?: BlueBubblesActionConfig;
  /** Channel health monitor overrides for this channel/account. */
  healthMonitor?: {
    enabled?: boolean;
  };
  /**
   * When true, consecutive DM messages (`isGroup === false`) from the same
   * sender within the inbound debounce window coalesce into a single agent
   * turn. Keys by `chat:sender` instead of the per-message `messageId` so
   * "command + payload as two sends" (e.g. a `dump` command followed by a
   * pasted URL that iMessage renders as its own URL balloon) reaches the
   * agent together. Does not apply to group chats or to BlueBubbles
   * text+balloon follow-ups, which still coalesce via
   * `associatedMessageGuid`. Default: false.
   */
  coalesceSameSenderDms?: boolean;
};

export type BlueBubblesSendTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; address: string; service?: "imessage" | "sms" | "auto" };

export type BlueBubblesAttachment = {
  guid?: string;
  uti?: string;
  mimeType?: string;
  transferName?: string;
  totalBytes?: number;
  height?: number;
  width?: number;
  originalROWID?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Default timeout for outbound message sends via `/api/v1/message/text` and
 * the `createNewChatWithMessage` flow. Larger than `DEFAULT_TIMEOUT_MS` because
 * Private API iMessage sends on macOS 26 (Tahoe) can stall for 60+ seconds
 * inside the iMessage framework. Callers can override per-call via
 * `opts.timeoutMs` or per-account via `channels.bluebubbles.sendTimeoutMs`.
 * (#67486)
 */
export const DEFAULT_SEND_TIMEOUT_MS = 30_000;

export function normalizeBlueBubblesServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("BlueBubbles serverUrl is required");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

// Overridable guard for testing; production code uses fetchWithSsrFGuard.
let _fetchGuard = fetchWithSsrFGuard;

/** @internal Replace the SSRF fetch guard in tests. */
export function _setFetchGuardForTesting(
  impl:
    | ((...args: Parameters<typeof fetchWithSsrFGuard>) => ReturnType<typeof fetchWithSsrFGuard>)
    | null,
): void {
  _fetchGuard = impl ?? fetchWithSsrFGuard;
}

export async function blueBubblesFetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<Response> {
  if (ssrfPolicy !== undefined) {
    // Use SSRF-guarded fetch; buffer the body so the dispatcher can be released
    // before the caller reads the response (API responses are small JSON payloads).
    const { response, release } = await _fetchGuard({
      url,
      init,
      timeoutMs,
      policy: ssrfPolicy,
      auditContext: "bluebubbles-api",
    });
    // Null-body status codes per Fetch spec — Response constructor rejects a body for these.
    const isNullBody =
      response.status === 101 ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304;
    try {
      const bodyBytes = isNullBody ? null : await response.arrayBuffer();
      return new Response(bodyBytes, { status: response.status, headers: response.headers });
    } finally {
      await release();
    }
  }
  // Strip `dispatcher` from init — the SSRF guard may have attached a bundled-undici
  // dispatcher that is incompatible with Node 22+'s built-in undici backing globalThis.fetch().
  // Passing it through causes a silent TypeError (invalid onRequestStart method).
  // The SSRF validation already completed upstream in fetchWithSsrFGuard before calling
  // this function as fetchImpl, so stripping the dispatcher does not weaken security. (#64105)
  const { dispatcher: _dispatcher, ...safeInit } = (init ?? {}) as RequestInit & {
    dispatcher?: unknown;
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchWithRuntimeDispatcherOrMockedGlobal(url, {
      ...safeInit,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
