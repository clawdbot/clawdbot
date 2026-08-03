import { formatErrorMessage } from "../infra/errors.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
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

function resolveRelayAgentIdFromCurrentConfig(session: RelaySession, sessionKey: string): string {
  const config = session.voiceConfig ?? session.context.getRuntimeConfig();
  return resolveTalkSessionAgentId(config, sessionKey);
}

export function bindRelaySessionKey(session: RelaySession, sessionKey: string): void {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    throw new Error("Realtime relay session key must be non-empty");
  }
  if (session.sessionKey && session.sessionKey !== normalizedSessionKey) {
    throw new Error("Realtime relay session belongs to another agent session");
  }
  if (!session.sessionKey) {
    session.sessionKey = normalizedSessionKey;
    session.agentId = resolveRelayAgentIdFromCurrentConfig(session, normalizedSessionKey);
  }
}

export function resolveRelayAgentId(session: RelaySession, sessionKey: string): string {
  bindRelaySessionKey(session, sessionKey);
  if (!session.agentId) {
    throw new Error("Realtime relay session has no pinned agent owner");
  }
  return session.agentId;
}

export function ensureRelayVoiceSession(session: RelaySession): boolean {
  if (session.voiceSessionCreated) {
    return true;
  }
  if (!session.sessionKey) {
    return false;
  }
  try {
    createOrResumeClientVoiceSession({
      agentId: resolveRelayAgentId(session, session.sessionKey),
      sessionKey: session.sessionKey,
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
  if (!session.sessionKey) {
    // Lazy-bound relays hear audio before talk.client.toolCall supplies the session
    // key; buffer bounded finals so the call's opening turns survive the binding.
    // Never-binding callers accept best-effort loss: they had no persistence before.
    session.pendingVoiceTranscripts.push({ role, text: normalizedText });
    if (session.pendingVoiceTranscripts.length > VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount) {
      session.pendingVoiceTranscripts.shift();
    }
    return true;
  }
  if (!ensureRelayVoiceSession(session)) {
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const sessionKey = session.sessionKey;
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
            agentId: resolveRelayAgentId(session, sessionKey),
            sessionKey,
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
  if (!session.sessionKey || !ensureRelayVoiceSession(session)) {
    session.voiceSessionClose = Promise.resolve();
    return session.voiceSessionClose;
  }
  const sessionKey = session.sessionKey;
  session.voiceSessionClose = session.voiceTranscriptQueue
    .flush()
    .then(async () => {
      const config = session.voiceConfig ?? session.context.getRuntimeConfig();
      await closeRelayVoiceSessionRecord({
        agentId: resolveRelayAgentId(session, sessionKey),
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
