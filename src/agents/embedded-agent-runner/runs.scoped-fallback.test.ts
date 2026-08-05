import { afterEach, describe, expect, it } from "vitest";
import {
  ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY,
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
} from "./run-state.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedRunAbandoned,
  markActiveEmbeddedRunAbandoned,
  resolveActiveEmbeddedRunHandleSessionId,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

function createRunHandle(): EmbeddedAgentQueueHandle {
  return {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  };
}

describe("embedded-agent scoped fallback run registry", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
  });

  it("does not resolve ambiguous fallback handle lookups without an agent", () => {
    const mainHandle = createRunHandle();
    const workHandle = createRunHandle();

    setActiveEmbeddedRun("session-main", mainHandle, "global", undefined, "main");
    setActiveEmbeddedRun("session-work", workHandle, "global", undefined, "work");

    expect(resolveActiveEmbeddedRunHandleSessionId("global")).toBeUndefined();
    expect(resolveActiveEmbeddedRunHandleSessionId("global", "main")).toBe("session-main");
    expect(resolveActiveEmbeddedRunHandleSessionId("global", "work")).toBe("session-work");

    clearActiveEmbeddedRun("session-main", mainHandle, "global");

    expect(resolveActiveEmbeddedRunHandleSessionId("global", "main")).toBeUndefined();
    expect(resolveActiveEmbeddedRunHandleSessionId("global", "work")).toBe("session-work");
  });

  it("counts legacy fallback ownership when resolving unscoped ambiguity", () => {
    const legacyHandle = createRunHandle();
    const workHandle = createRunHandle();

    setActiveEmbeddedRun("session-legacy", legacyHandle, "global");
    setActiveEmbeddedRun("session-work", workHandle, "global", undefined, "work");

    expect(resolveActiveEmbeddedRunHandleSessionId("global")).toBeUndefined();
    expect(resolveActiveEmbeddedRunHandleSessionId("global", "work")).toBe("session-work");
  });

  it("clears only the matching scoped fallback abandonment marker", () => {
    const handle = createRunHandle();
    const mainSessionFile = "sqlite:main-global";
    const workSessionFile = "sqlite:work-global";
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-work", {
      sessionId: "session-work",
      sessionKey: "global",
      agentId: "work",
      sessionFile: workSessionFile,
      abandonedAtMs: 20,
      reason: "timeout",
    });
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set(
      "main:global",
      "session-main",
    );
    ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.set("main:global", {
      sessionId: "session-main",
      sessionKey: "global",
      agentId: "main",
      sessionFile: mainSessionFile,
      abandonedAtMs: 10,
      reason: "timeout",
    });
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set(
      "work:global",
      "session-work",
    );
    ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.set("work:global", {
      sessionId: "session-work",
      sessionKey: "global",
      agentId: "work",
      sessionFile: workSessionFile,
      abandonedAtMs: 20,
      reason: "timeout",
    });
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(mainSessionFile, "session-main");
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(workSessionFile, "session-work");

    setActiveEmbeddedRun("session-main", handle, "global", undefined, "main");

    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.has("main:global")).toBe(
      false,
    );
    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.get("work:global")).toBe(
      "session-work",
    );
    expect(ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.get("work:global")).toMatchObject({
      agentId: "work",
      sessionId: "session-work",
    });
    expect(ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get("session-work")).toMatchObject({
      agentId: "work",
    });
    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.has(mainSessionFile)).toBe(false);
    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(workSessionFile)).toBe("session-work");
    expect(
      isEmbeddedRunAbandoned({
        sessionId: "session-main",
        sessionKey: "agent:main:global",
        agentId: "main",
      }),
    ).toBe(false);
    expect(
      isEmbeddedRunAbandoned({
        sessionId: "session-work",
        sessionKey: "agent:work:global",
        agentId: "work",
      }),
    ).toBe(true);
  });

  it("clears a prior scoped fallback abandonment when a replacement starts", () => {
    const handle = createRunHandle();
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-old", {
      sessionId: "session-old",
      sessionKey: "global",
      agentId: "main",
      sessionFile: "sqlite:main-old-global",
      abandonedAtMs: 10,
      reason: "timeout",
    });
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set(
      "main:global",
      "session-old",
    );
    ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.set("main:global", {
      sessionId: "session-old",
      sessionKey: "global",
      agentId: "main",
      sessionFile: "sqlite:main-old-global",
      abandonedAtMs: 10,
      reason: "timeout",
    });
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set("sqlite:main-old-global", "session-old");

    setActiveEmbeddedRun("session-new", handle, "global", undefined, "main");

    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.has("main:global")).toBe(
      false,
    );
    expect(ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.has("main:global")).toBe(false);
    expect(ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.has("session-old")).toBe(false);
    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.has("sqlite:main-old-global")).toBe(false);
  });

  it("clears matching legacy abandonment when a scoped fallback run starts", () => {
    const handle = createRunHandle();
    const sessionFile = "sqlite:work-legacy-global";
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-recovered", {
      sessionId: "session-recovered",
      sessionKey: "global",
      sessionFile,
      abandonedAtMs: 10,
      reason: "timeout",
    });
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(sessionFile, "session-recovered");
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_AGENT_SCOPED_FALLBACK_KEY.set(
      "main:global",
      "session-recovered",
    );
    ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.set("main:global", {
      sessionId: "session-recovered",
      sessionKey: "global",
      agentId: "main",
      sessionFile: "sqlite:main-global",
      abandonedAtMs: 20,
      reason: "timeout",
    });

    setActiveEmbeddedRun("session-recovered", handle, "global", sessionFile, "work");

    expect(ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.has("session-recovered")).toBe(false);
    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.has(sessionFile)).toBe(false);
    expect(ABANDONED_EMBEDDED_RUNS_BY_AGENT_SCOPED_FALLBACK_KEY.get("main:global")).toMatchObject({
      agentId: "main",
      sessionId: "session-recovered",
    });
  });

  it("clears another agent's legacy global abandonment before a scoped replacement", () => {
    const handle = createRunHandle();
    const sessionFile = "sqlite:main-legacy-global";
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-shared", {
      sessionId: "session-shared",
      sessionKey: "global",
      sessionFile,
      abandonedAtMs: 10,
      reason: "timeout",
    });
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("global", "session-shared");
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(sessionFile, "session-shared");

    setActiveEmbeddedRun("session-shared", handle, "global", undefined, "work");

    expect(ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.has("session-shared")).toBe(false);
    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.has("global")).toBe(false);
    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.has(sessionFile)).toBe(false);
    expect(isEmbeddedRunAbandoned({ sessionId: "session-shared", sessionKey: "global" })).toBe(
      false,
    );
    expect(resolveActiveEmbeddedRunHandleSessionId("global", "work")).toBe("session-shared");
  });

  it("does not let one agent's fallback abandonment suppress another owner", () => {
    const mainHandle = createRunHandle();
    const workHandle = createRunHandle();

    setActiveEmbeddedRun("session-main", mainHandle, "global", undefined, "main");
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-main",
        handle: mainHandle,
        sessionKey: "global",
        agentId: "main",
        reason: "timeout",
      }),
    ).toBe(true);
    setActiveEmbeddedRun("session-work", workHandle, "global", undefined, "work");

    expect(ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.has("session-main")).toBe(false);
    expect(ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.has("global")).toBe(false);
    expect(
      isEmbeddedRunAbandoned({
        sessionId: "session-main",
        sessionKey: "agent:main:global",
        agentId: "main",
      }),
    ).toBe(true);
    expect(
      isEmbeddedRunAbandoned({
        sessionId: "session-work",
        sessionKey: "agent:work:global",
        agentId: "work",
      }),
    ).toBe(false);
    expect(isEmbeddedRunAbandoned({ sessionId: "session-work", sessionKey: "global" })).toBe(false);
  });

  it("resolves canonical fallback keys through their agent-scoped aliases", () => {
    const mainHandle = createRunHandle();
    const workHandle = createRunHandle();

    setActiveEmbeddedRun("session-main", mainHandle, "global", undefined, "main");
    setActiveEmbeddedRun("session-work", workHandle, "global", undefined, "work");

    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:global")).toBe("session-main");
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:work:global")).toBe("session-work");
  });

  it("retires stale scoped aliases when one session generation changes owner", () => {
    const mainHandle = createRunHandle();
    const workHandle = createRunHandle();

    setActiveEmbeddedRun("session-shared", mainHandle, "global", undefined, "main");
    setActiveEmbeddedRun("session-shared", workHandle, "global", undefined, "work");

    expect(resolveActiveEmbeddedRunHandleSessionId("global", "main")).toBeUndefined();
    expect(resolveActiveEmbeddedRunHandleSessionId("global", "work")).toBe("session-shared");

    clearActiveEmbeddedRun("session-shared", mainHandle, "global");

    expect(resolveActiveEmbeddedRunHandleSessionId("global", "work")).toBe("session-shared");
  });
});
