import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticLogger } from "../../logging/diagnostic.js";
import {
  clearActiveEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedAgentRunHandleActive,
  isEmbeddedRunAbandoned,
  markActiveEmbeddedRunAbandoned,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(): RunHandle {
  return {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  };
}

describe("embedded-agent runner run registry state", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("shares active run state across distinct module instances", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-b",
    );
    const handle = createRunHandle();

    testing.resetActiveEmbeddedRuns();

    try {
      runsA.setActiveEmbeddedRun("session-shared", handle);
      expect(runsB.isEmbeddedAgentRunActive("session-shared")).toBe(true);

      runsB.clearActiveEmbeddedRun("session-shared", handle);
      expect(runsA.isEmbeddedAgentRunActive("session-shared")).toBe(false);
    } finally {
      testing.resetActiveEmbeddedRuns();
    }
  });

  it("tracks actual embedded handles separately from reply-operation ownership", () => {
    const handle = createRunHandle();

    expect(isEmbeddedAgentRunHandleActive("session-a")).toBe(false);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBeUndefined();

    setActiveEmbeddedRun("session-a", handle, "agent:main:main");

    expect(isEmbeddedAgentRunHandleActive("session-a")).toBe(true);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBe("session-a");

    clearActiveEmbeddedRun("session-a", handle, "agent:main:main");

    expect(isEmbeddedAgentRunHandleActive("session-a")).toBe(false);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBeUndefined();
  });

  it("clears a relative compatibility file key after normalization", () => {
    const handle = createRunHandle();
    const sessionFile = "relative-session-token";

    setActiveEmbeddedRun("session-relative", handle, "agent:main:relative", sessionFile);
    expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(sessionFile)).toBe(
      "session-relative",
    );

    clearActiveEmbeddedRun("session-relative", handle, "agent:main:relative", sessionFile);
    expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(sessionFile)).toBeUndefined();
  });

  it("tracks timeout abandonment by session id, key, and file until a new run starts", () => {
    // Abandonment markers must catch retries addressed by any durable identity,
    // then clear once a new run owns the same session key/file.
    const sessionFile = "/tmp/openclaw-abandoned-session.jsonl";
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-timeout", handle, "agent:main:main", sessionFile);
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-timeout",
        handle,
        sessionKey: "agent:main:main",
        sessionFile,
        reason: "timeout",
      }),
    ).toBe(true);

    expect(isEmbeddedRunAbandoned({ sessionId: "session-timeout" })).toBe(true);
    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(true);
    expect(isEmbeddedRunAbandoned({ sessionFile })).toBe(true);

    const nextHandle = createRunHandle();
    setActiveEmbeddedRun("session-next", nextHandle, "agent:main:main", sessionFile);

    expect(isEmbeddedRunAbandoned({ sessionId: "session-timeout" })).toBe(false);
    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(false);
    expect(isEmbeddedRunAbandoned({ sessionFile })).toBe(false);

    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-next",
        handle: nextHandle,
        sessionKey: "agent:main:main",
        reason: "timeout",
      }),
    ).toBe(true);
    setActiveEmbeddedRun("session-third", createRunHandle(), "agent:main:main");

    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(false);
  });

  it("ignores timeout abandonment from a stale replaced handle", () => {
    const oldHandle = createRunHandle();
    const newHandle = createRunHandle();

    setActiveEmbeddedRun("session-replaced", oldHandle, "agent:main:main");
    setActiveEmbeddedRun("session-replaced", newHandle, "agent:main:main");

    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-replaced",
        handle: oldHandle,
        sessionKey: "agent:main:main",
        reason: "timeout",
      }),
    ).toBe(false);

    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(false);
  });

  it("treats repeated clears for a completed run handle as idempotent", () => {
    const debugSpy = vi.spyOn(diagnosticLogger, "debug").mockImplementation(() => undefined);
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-repeat-clear", handle, "agent:main:main");
    clearActiveEmbeddedRun("session-repeat-clear", handle, "agent:main:main");
    clearActiveEmbeddedRun("session-repeat-clear", handle, "agent:main:main");

    expect(isEmbeddedAgentRunHandleActive("session-repeat-clear")).toBe(false);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBeUndefined();
    expect(
      debugSpy.mock.calls.some(([message]) => message.includes("reason=handle_mismatch")),
    ).toBe(false);
  });

  it("still logs handle mismatches when another run owns the session", () => {
    const debugSpy = vi.spyOn(diagnosticLogger, "debug").mockImplementation(() => undefined);
    const staleHandle = createRunHandle();
    const activeHandle = createRunHandle();

    setActiveEmbeddedRun("session-handle-replaced", activeHandle);
    clearActiveEmbeddedRun("session-handle-replaced", staleHandle);

    expect(isEmbeddedAgentRunHandleActive("session-handle-replaced")).toBe(true);
    expect(
      debugSpy.mock.calls.some(([message]) => message.includes("reason=handle_mismatch")),
    ).toBe(true);
  });

  it("tracks and clears per-session transcript snapshots for active runs", () => {
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-snapshot", handle);
    updateActiveEmbeddedRunSnapshot("session-snapshot", {
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toEqual({
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });

    clearActiveEmbeddedRun("session-snapshot", handle);
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toBeUndefined();
  });
});
