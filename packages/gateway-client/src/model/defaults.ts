export const CONTROL_MODEL_DEFAULT_BOUNDS = Object.freeze({
  maxSessions: 200,
  maxSubscribers: 100,
  maxInactiveConversations: 32,
  maxConversationMessages: 200,
  maxConversationRuns: 200,
  maxConversationTools: 100,
  maxConversationApprovals: 100,
  maxConversationQuestions: 100,
  maxConversationProgressUpdates: 100,
  maxConversationProgressBytes: 64_000,
  maxConversationStartupMetadataBytes: 64_000,
  maxConversationArtifacts: 100,
  maxArtifactBytes: 64_000,
  maxArtifactDepth: 12,
  maxArtifactCollectionItems: 256,
  maxArtifactStringBytes: 16_000,
  maxArtifactViews: 16,
});

export const CONTROL_MODEL_SESSION_REFRESH_DEFAULTS = Object.freeze({
  debounceMs: 200,
  maxWaitMs: 1_000,
});
