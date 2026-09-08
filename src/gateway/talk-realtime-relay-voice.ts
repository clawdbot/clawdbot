import { formatErrorMessage } from "../infra/errors.js";
import {
  appendRelayVoiceTranscript,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
} from "../talk/client-voice-session.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../talk/voice-transcript.js";
import { drainingRelaySessions, type RelaySession } from "./talk-realtime-relay-state.js";

const RELAY_TRANSCRIPT_RETRY_DELAYS_MS = [0, 500, 2_000] as const;

function logRelayVoiceFailure(session: RelaySession, message: string, error: unknown): void {
  session.context.logGateway?.warn(`${message}: ${formatErrorMessage(error)}`);
}

export function ensureRelayVoiceSession(session: RelaySession): boolean {
  if (session.voiceSessionCreated) {
    return true;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  try {
    createOrResumeClientVoiceSession({
      agentId,
      sessionKey,
      provider: session.provider,
      origin: "relay",
      voiceSessionId: session.id,
    });
    session.voiceSessionCreated = true;
    return true;
  } catch (error) {
    logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
    return false;
  }
}

export function enqueueRelayVoiceTranscript(
  session: RelaySession,
  role: "user" | "assistant",
  text: string,
): boolean {
  const normalizedText = normalizeVoiceTranscriptText(text);
  if (!normalizedText) {
    return true;
  }
  if (!ensureRelayVoiceSession(session)) {
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  const admission = session.voiceTranscriptQueue.enqueue(
    async () => {
      let lastError: unknown;
      for (const delayMs of RELAY_TRANSCRIPT_RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        try {
          await appendRelayVoiceTranscript({
            agentId,
            sessionKey,
            sessionTarget: { sessionKey: canonicalKey, storePath },
            voiceSessionId: session.id,
            entryId,
            role,
            text: normalizedText,
            ...(session.voiceConfig ? { config: session.voiceConfig } : {}),
          });
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    { weight: normalizedText.length },
  );
  if (!admission.accepted) {
    if (admission.reason === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return false;
  }
  session.voiceTranscriptSeq = transcriptSeq;
  void admission.completion.catch((error: unknown) => {
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  });
  return true;
}

export function closeRelayVoiceSession(session: RelaySession): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  session.voiceTranscriptQueue.seal();
  if (!ensureRelayVoiceSession(session)) {
    session.voiceSessionClose = Promise.resolve();
    return session.voiceSessionClose;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  session.voiceSessionClose = session.voiceTranscriptQueue
    .flush()
    .then(async () => {
      const config = session.voiceConfig ?? session.context.getRuntimeConfig();
      await closeRelayVoiceSessionRecord({
        agentId,
        sessionKey,
        voiceSessionId: session.id,
        config,
      });
    })
    .catch((error: unknown) => {
      logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
    });
  drainingRelaySessions.add(session);
  void session.voiceSessionClose.finally(() => {
    drainingRelaySessions.delete(session);
  });
  return session.voiceSessionClose;
}
