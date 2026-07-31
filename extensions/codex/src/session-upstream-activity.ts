import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionCatalogProvider,
  SessionUpstreamActivity,
  SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CodexAppServerRpcError } from "./app-server/client.js";
import type {
  CodexThread,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
  CodexTurn,
  CodexUserInput,
} from "./app-server/protocol.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
} from "./app-server/session-binding.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";

const CODEX_UPSTREAM_TURN_LIMIT = 100;
// codex-rs app-server thread/read maps a gone rollout to JSON-RPC invalid_request
// with exactly this message prefix (read_thread_view "thread not loaded"). The code
// alone is generic (other store validation reuses it), so both must match; a harness
// message rename degrades to the old silent gap instead of unlinking live threads.
const CODEX_APP_SERVER_INVALID_REQUEST_CODE = -32600;
const CODEX_THREAD_NOT_LOADED_MESSAGE_PREFIX = "thread not loaded:";

function isCodexThreadGoneError(error: unknown): boolean {
  return (
    error instanceof CodexAppServerRpcError &&
    error.code === CODEX_APP_SERVER_INVALID_REQUEST_CODE &&
    error.message.startsWith(CODEX_THREAD_NOT_LOADED_MESSAGE_PREFIX)
  );
}

type CodexUpstreamControl = {
  connectionFingerprint?: string;
  withPinnedConnection<T>(run: (control: CodexUpstreamControl) => Promise<T>): Promise<T>;
  listTurnPage(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThread>;
};

type CodexUpstreamMarker = {
  turnId: string | null;
  userMessageCount?: number;
};

function readMarker(probe: SessionUpstreamProbe): CodexUpstreamMarker | undefined {
  if (!isRecord(probe.marker)) {
    return undefined;
  }
  const turnId = probe.marker.turnId;
  if (turnId !== null && typeof turnId !== "string") {
    return undefined;
  }
  const count = probe.marker.userMessageCount;
  if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)) {
    return undefined;
  }
  return {
    turnId,
    ...(count === undefined ? {} : { userMessageCount: count as number }),
  };
}

function upstreamConnectionFingerprint(probe: SessionUpstreamProbe): string | undefined {
  return isRecord(probe.upstreamRef) && typeof probe.upstreamRef.connectionFingerprint === "string"
    ? probe.upstreamRef.connectionFingerprint
    : undefined;
}

function classifyCodexUpstreamTurns(params: {
  probe: SessionUpstreamProbe;
  turns: CodexTurn[];
  now?: number;
}): SessionUpstreamActivity | undefined {
  const marker = readMarker(params.probe);
  if (!marker) {
    return undefined;
  }
  const newest = params.turns[0];
  if (!newest?.id) {
    return undefined;
  }
  const markerIndex =
    marker.turnId === null ? -1 : params.turns.findIndex((turn) => turn.id === marker.turnId);
  const candidateTurns = markerIndex < 0 ? params.turns : params.turns.slice(0, markerIndex + 1);
  const newestUserMessageCount = countUserMessages(newest);
  const markerAdvanced =
    marker.turnId !== newest.id ||
    marker.userMessageCount === undefined ||
    newestUserMessageCount > marker.userMessageCount;
  if (!markerAdvanced) {
    return undefined;
  }
  const ownTexts = new Set(params.probe.ownRecentUserTexts);
  let humanTurns = 0;
  let occurredAt: number | undefined;
  for (const turn of candidateTurns) {
    const userMessages = turn.items.filter((item) => item.type === "userMessage");
    const alreadySeen =
      turn.id === marker.turnId ? (marker.userMessageCount ?? userMessages.length) : 0;
    for (const item of userMessages.slice(alreadySeen)) {
      const texts = normalizeUserMessageTexts(item);
      if (
        ownTexts.has(texts.join(" ")) ||
        (texts.length > 1 && texts.every((text) => ownTexts.has(text)))
      ) {
        continue;
      }
      humanTurns += 1;
      if (occurredAt === undefined) {
        const timestampSeconds = turn.completedAt ?? turn.startedAt;
        occurredAt =
          typeof timestampSeconds === "number" && Number.isFinite(timestampSeconds)
            ? timestampSeconds * 1000
            : (params.now ?? Date.now());
      }
    }
  }
  const activityId = `${newest.id}:${newestUserMessageCount}`;
  return {
    kind: "activity",
    sessionKey: params.probe.sessionKey,
    humanTurns,
    nextMarker: { turnId: newest.id, userMessageCount: newestUserMessageCount },
    ...(humanTurns > 0
      ? { occurredAt: occurredAt ?? params.now ?? Date.now(), dedupeId: activityId }
      : {}),
  };
}

function countUserMessages(turn: CodexTurn): number {
  return turn.items.filter((item) => item.type === "userMessage").length;
}

function normalizeUserMessageTexts(item: CodexTurn["items"][number]): string[] {
  const typed = item as CodexTurn["items"][number] & {
    content?: CodexUserInput[];
    text?: string;
  };
  const contentTexts = typed.content
    ?.filter((input): input is Extract<CodexUserInput, { type: "text" }> => input.type === "text")
    .map((input) => input.text.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  return contentTexts?.length ? contentTexts : [(typed.text ?? "").trim().replace(/\s+/g, " ")];
}

async function checkCodexUpstreamActivity(
  probes: SessionUpstreamProbe[],
  control: CodexUpstreamControl,
  resolveThreadId: (probe: SessionUpstreamProbe) => Promise<string> = async (probe) =>
    probe.threadId,
): Promise<SessionUpstreamActivity[]> {
  return await control.withPinnedConnection(async (pinned) => {
    const activities: SessionUpstreamActivity[] = [];
    for (const probe of probes) {
      const fingerprint = upstreamConnectionFingerprint(probe);
      if (
        probe.upstreamKind !== "codex-app-server" ||
        !fingerprint ||
        fingerprint !== pinned.connectionFingerprint
      ) {
        continue;
      }
      try {
        const threadId = await resolveThreadId(probe);
        const page = await pinned.listTurnPage({
          threadId,
          limit: CODEX_UPSTREAM_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "full",
        });
        const marker = readMarker(probe);
        if (page.data.length === 0 && marker) {
          // Deleted threads do NOT reject turns/list: codex-rs load_thread_turns_list_history
          // swallows ThreadNotFound/no-rollout and returns an empty page, and rollback can
          // empty a live thread too. thread/read is the existence oracle: it still succeeds
          // after rollback and rejects "thread not loaded" only once the rollout is gone.
          try {
            await pinned.readThread(threadId, false);
          } catch (error) {
            if (isCodexThreadGoneError(error)) {
              activities.push({ kind: "missing", sessionKey: probe.sessionKey });
            }
          }
          continue;
        }
        const activity = classifyCodexUpstreamTurns({ probe, turns: page.data });
        if (activity) {
          activities.push(activity);
        }
      } catch {
        // One transient probe failure must not suppress healthy sessions in the same batch.
      }
    }
    return activities;
  });
}

export function createChecker(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  control: CodexSessionCatalogControl;
  getRuntimeConfig: () => OpenClawConfig | undefined;
}): NonNullable<SessionCatalogProvider["checkUpstreamActivity"]> {
  return async (probes) =>
    await checkCodexUpstreamActivity(probes, params.control, async (probe) => {
      const config = params.getRuntimeConfig();
      const entry = params.api.runtime.agent.session.getSessionEntry({
        agentId: probe.agentId,
        sessionKey: probe.sessionKey,
        readConsistency: "latest",
      });
      const sessionId = entry?.sessionId?.trim();
      if (!sessionId) {
        return probe.threadId;
      }
      const binding = await params.bindingStore.read(
        sessionBindingIdentity({ sessionId, sessionKey: probe.sessionKey, config }),
      );
      return binding?.connectionScope === "supervision" &&
        binding.supervisionSourceThreadId === probe.threadId
        ? binding.threadId
        : probe.threadId;
    });
}
