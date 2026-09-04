// Commits detached background results into an existing conversation generation.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import {
  appendExactAssistantMessageToSessionTranscript,
  type SessionTranscriptAssistantMessage,
} from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  retainAssistantModelContent,
} from "../shared/assistant-display-content.js";
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
  | { ok: true; messageId: string; appended: boolean }
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
  displayContent?: readonly Record<string, unknown>[];
  onMessageCommitted?: Parameters<
    typeof appendExactAssistantMessageToSessionTranscript
  >[0]["onMessageCommitted"];
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
  const displayContent = params.displayContent?.map((block) => Object.assign({}, block));
  const modelContent = displayContent ? retainAssistantModelContent(displayContent) : [];

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
      const message = {
        role: "assistant",
        content: modelContent.length > 0 ? modelContent : [{ type: "text", text }],
        ...(displayContent?.length ? { [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent } : {}),
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
        openclawAutomation: params.provenance,
      } satisfies SessionTranscriptAssistantMessage & {
        openclawAutomation: BackgroundSessionResultProvenance;
      };
      let appendedMessage = false;
      const appended = await appendExactAssistantMessageToSessionTranscript({
        agentId: params.agentId,
        sessionKey,
        expectedSessionId,
        expectedLifecycleRevision: expectedLifecycleRevision ?? null,
        idempotencyKey,
        message,
        storePath,
        updateMode: "inline",
        config: params.config,
        // Managed display blocks get fresh attachment ids on retry. Preserve the
        // first committed bytes once this idempotency key owns a transcript row.
        ...(displayContent ? { beforeMessageWrite: ({ message: candidate }) => candidate } : {}),
        onMessageCommitted: (result) => {
          appendedMessage = result.appended;
          params.onMessageCommitted?.(result);
        },
      });
      return appended.ok
        ? { ok: true, messageId: appended.messageId, appended: appendedMessage }
        : { ok: false, reason: appended.reason };
    },
  });
}
