type SessionTranscriptUpdate = {
  sessionFile: string;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(sessionFile: string): void {
  const trimmed = sessionFile.trim();
  if (!trimmed) return;
  const update = { sessionFile: trimmed };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    listener(update);
  }
}
