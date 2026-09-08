// Commits detached background results into an existing conversation generation.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import {
  findTranscriptEvent,
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import type { SessionTranscriptAssistantMessage } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../shared/transcript-only-openclaw-assistant.js";
import {
  getSessionWorkAdmissionRelease,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

// Background completions are durable conversation output, so this identity
// must stay outside the transcript-only delivery-mirror model set.
const AUTOMATION_RESULT_MODEL = "automation-result" as const;

type BackgroundSessionResultCommit =
  | { ok: true; messageId: string }
  | { ok: false; reason: string };

type BackgroundSessionResultProvenance = {
  kind: "cron";
  jobId: string;
  runId: string;
};

/** Serializes a background assistant result behind active work on its target conversation. */
export async function commitBackgroundResultToSession(params: {
  agentId: string;
  sessionKey: string;
  /** Pins output to the conversation generation that admitted the background run. */
  expectedGeneration: { sessionId: string; lifecycleRevision: string | undefined };
  text: string;
  prepareDisplayContent?: () => Promise<readonly Record<string, unknown>[] | undefined>;
  onMessageCommitted?: SessionTranscriptTurnPersistOptions["onMessageCommitted"];
  idempotencyKey: string;
  provenance: BackgroundSessionResultProvenance;
  config: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<BackgroundSessionResultCommit> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const text = normalizeOptionalString(params.text);
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  if (!sessionKey || !text || !idempotencyKey) {
    return { ok: false, reason: "background session result is missing required data" };
  }

  const storePath = resolveSessionStorePathCore(params.config.session?.store, {
    agentId: params.agentId,
  });
  const expectedSessionId = normalizeOptionalString(params.expectedGeneration.sessionId);
  if (!expectedSessionId) {
    return { ok: false, reason: "background session result has an invalid expected generation" };
  }
  const expectedLifecycleRevision = normalizeOptionalString(
    params.expectedGeneration.lifecycleRevision,
  );
  const identities = [sessionKey, expectedSessionId];

  return await runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities,
    signal: params.signal,
    prepare: async () => {
      await getSessionWorkAdmissionRelease({ scope: storePath, identities });
    },
    run: async () => {
      const current = loadSessionEntryReadOnly({
        agentId: params.agentId,
        sessionKey,
        storePath,
        readConsistency: "latest",
      });
      if (
        current?.sessionId !== expectedSessionId ||
        normalizeOptionalString(current.lifecycleRevision) !== expectedLifecycleRevision
      ) {
        return { ok: false, reason: `session rebound for sessionKey: ${sessionKey}` };
      }
      const unavailable = resolveSessionWorkStartError(sessionKey, current, {
        expectedSessionId,
      });
      if (unavailable) {
        return { ok: false, reason: unavailable };
      }
      const scope = {
        agentId: params.agentId,
        sessionKey,
        sessionId: expectedSessionId,
        storePath,
      };
      // A retry owns the original committed payload, including its managed-media IDs.
      // Restaging media would conflict with the transcript's exact replay contract.
      const prior = await findTranscriptEvent(
        scope,
        (event) => readTranscriptEventMessage(event)?.idempotencyKey === idempotencyKey,
      );
      const priorMessage = prior && readTranscriptEventMessage(prior.event);
      const priorId = prior && readTranscriptEventId(prior.event);
      if (prior && (!priorMessage || !priorId)) {
        return { ok: false, reason: "background result transcript identity is unavailable" };
      }
      const displayContent = priorMessage
        ? undefined
        : (await params.prepareDisplayContent?.())?.map((block) => Object.assign({}, block));
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        ...(displayContent ? { [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent } : {}),
        api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
        provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
        model: AUTOMATION_RESULT_MODEL,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
        idempotencyKey,
        openclawAutomation: params.provenance,
      } satisfies SessionTranscriptAssistantMessage & {
        idempotencyKey: string;
        openclawAutomation: BackgroundSessionResultProvenance;
      };
      const committed = await persistSessionTranscriptTurn(scope, {
        cwd: current.spawnedCwd,
        expectedSessionId,
        expectedLifecycleRevision: expectedLifecycleRevision ?? null,
        messages: [
          {
            message: priorMessage
              ? { ...priorMessage, content: message.content, openclawAutomation: params.provenance }
              : message,
            idempotencyLookup: "scan",
            ...(priorId ? { eventId: priorId } : {}),
            shouldAppendInTransaction: () => {
              params.signal?.throwIfAborted();
              if (priorId && !readActiveTranscriptEntryAnchor({ ...scope, entryId: priorId })) {
                throw new Error("background result no longer owns the active transcript");
              }
              return true;
            },
          },
        ],
        touchSessionEntry: true,
        updateMode: "inline",
        // A retry can finish media ownership after a committed append failed to publish.
        publishWhen: params.prepareDisplayContent ? "always" : undefined,
        config: params.config,
        onMessageCommitted: params.onMessageCommitted,
      });
      const appended = committed.messages[0];
      return appended
        ? { ok: true, messageId: appended.messageId }
        : { ok: false, reason: committed.rejectedReason ?? "background result was not committed" };
    },
  });
}
