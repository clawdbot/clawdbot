import { afterEach, describe, expect, it } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY,
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  getEmbeddedRunDiagnosticSnapshot,
} from "./run-state.js";

afterEach(() => {
  ACTIVE_EMBEDDED_RUNS.clear();
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.clear();
  ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.clear();
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.clear();
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.clear();
  replyRunTesting.resetReplyRunRegistry();
});

describe("getEmbeddedRunDiagnosticSnapshot", () => {
  it("uses sessionFile for lookup without returning local paths", () => {
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set("sqlite:session-1", "session-1");
    ACTIVE_EMBEDDED_RUNS.set("session-1", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
      sourceReplyDeliveryMode: "automatic",
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionFile: "sqlite:session-1",
      }),
    ).toEqual({
      active: true,
      sessionId: "session-1",
      streaming: true,
      compacting: false,
      sourceReplyDeliveryMode: "automatic",
      hasTranscriptSnapshot: false,
    });
  });

  it("omits abandoned run sessionFile details from diagnosis output", () => {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set("sqlite:session-2", "session-2");
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-2", {
      sessionId: "session-2",
      sessionFile: "sqlite:session-2",
      abandonedAtMs: 10,
      reason: "timeout",
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionFile: "sqlite:session-2",
      }),
    ).toEqual({
      active: false,
      sessionId: "session-2",
      abandoned: {
        sessionId: "session-2",
        abandonedAtMs: 10,
        reason: "timeout",
      },
    });
  });

  it("prefers the current session-key active id over a stale stored session id", () => {
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:main", "session-current");
    ACTIVE_EMBEDDED_RUNS.set("session-current", {
      isStreaming: () => false,
      isCompacting: () => true,
      queueMessage: async () => {},
      abort: () => {},
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-stale",
        sessionKey: "agent:main:main",
      }),
    ).toEqual({
      active: true,
      sessionId: "session-current",
      sessionKey: "agent:main:main",
      streaming: false,
      compacting: true,
      hasTranscriptSnapshot: false,
    });
  });

  it("does not trust an active stored session id indexed to another key", () => {
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:other", "session-shared");
    ACTIVE_EMBEDDED_RUNS.set("session-shared", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
    });
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set("session-shared", {
      transcriptLeafId: "other-agent-leaf",
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-shared",
        sessionKey: "agent:main:target",
      }),
    ).toEqual({
      active: false,
      sessionKey: "agent:main:target",
    });
  });

  it("scopes fallback key diagnosis by agent", () => {
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("global", "session-work");
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set("main:global", "session-main");
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set("work:global", "session-work");
    ACTIVE_EMBEDDED_RUNS.set("session-main", {
      isStreaming: () => false,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
    });
    ACTIVE_EMBEDDED_RUNS.set("session-work", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-main",
        sessionKey: "global",
        agentId: "main",
      }),
    ).toMatchObject({
      active: true,
      sessionId: "session-main",
      sessionKey: "global",
      streaming: false,
    });
  });

  it("requires scoped fallback ownership before reporting a shared id active", () => {
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set(
      "main:global",
      "session-shared",
    );
    ACTIVE_EMBEDDED_RUNS.set("session-shared", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-shared",
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual({
      active: false,
      sessionId: "session-shared",
      sessionKey: "global",
    });
  });

  it("does not treat a file index as scoped fallback ownership", () => {
    const sessionFile = "sqlite:work-global";
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(sessionFile, "session-shared");
    ACTIVE_EMBEDDED_RUNS.set("session-shared", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-shared",
        sessionKey: "global",
        sessionFile,
        agentId: "work",
      }),
    ).toEqual({
      active: false,
      sessionId: "session-shared",
      sessionKey: "global",
    });
  });

  it("does not attach legacy fallback abandonment without matching file identity", () => {
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-shared", {
      sessionId: "session-shared",
      sessionKey: "global",
      sessionFile: "sqlite:main-global",
      abandonedAtMs: 10,
      reason: "timeout",
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-shared",
        sessionKey: "global",
        sessionFile: "sqlite:work-global",
        agentId: "work",
      }),
    ).toEqual({
      active: false,
      sessionId: "session-shared",
      sessionKey: "global",
    });
  });

  it("preserves reply-run activity for scoped fallback rows", () => {
    createReplyOperation({
      sessionKey: "global",
      sessionId: "session-reply",
      agentId: "work",
      resetTriggered: false,
    });
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set(
      "work:global",
      "session-old",
    );
    ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.set("work:global", {
      sessionId: "session-old",
      sessionKey: "global",
      agentId: "work",
      abandonedAtMs: 10,
      reason: "timeout",
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-reply",
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual({
      active: true,
      sessionId: "session-reply",
      sessionKey: "global",
    });
    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual({
      active: true,
      sessionId: "session-reply",
      sessionKey: "global",
    });
  });

  it("does not attribute reply-run activity to another scoped fallback agent", () => {
    createReplyOperation({
      sessionKey: "global",
      sessionId: "session-shared",
      agentId: "main",
      resetTriggered: false,
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-shared",
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual({
      active: false,
      sessionId: "session-shared",
      sessionKey: "global",
    });
  });

  it("prefers active file-indexed runs over abandoned key-indexed runs", () => {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:main", "session-old");
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-old", {
      sessionId: "session-old",
      sessionKey: "agent:main:main",
      abandonedAtMs: 10,
      reason: "timeout",
    });
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set("sqlite:session-current", "session-current");
    ACTIVE_EMBEDDED_RUNS.set("session-current", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionKey: "agent:main:main",
        sessionFile: "sqlite:session-current",
      }),
    ).toEqual({
      active: true,
      sessionId: "session-current",
      sessionKey: "agent:main:main",
      streaming: true,
      compacting: false,
      hasTranscriptSnapshot: false,
    });
  });
});
