import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing as runsTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import { controlRealtimeVoiceAgentRun } from "./agent-run-control.js";
import { resolveOwnedActiveRealtimeVoiceRunTargetForAgent } from "./realtime-voice-run-target.js";

describe("resolveOwnedActiveRealtimeVoiceRunTargetForAgent", () => {
  const sessionKey = "agent:main:discord:channel:c1";
  const sessionId = "shared-colliding-session-id";

  beforeEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
  });

  afterEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
  });

  it("returns null for a foreign agentId on the same sessionKey (fail-closed)", () => {
    const abortSpy = vi.fn();
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ abort: abortSpy, runId: "run-ops" }),
      sessionKey,
      undefined,
      "ops",
    );

    expect(
      resolveOwnedActiveRealtimeVoiceRunTargetForAgent({
        sessionKey,
        agentId: "main",
      }),
    ).toBeNull();
    expect(abortSpy).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
  });

  it("admits the exact owned run for matching sessionKey+agentId", () => {
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ runId: "run-main" }),
      sessionKey,
      undefined,
      "main",
    );

    const runTarget = resolveOwnedActiveRealtimeVoiceRunTargetForAgent({
      sessionKey,
      agentId: "main",
    });
    expect(runTarget).toMatchObject({ runId: "run-main" });
    expect(runTarget?.isCurrent()).toBe(true);
    expect(runTarget?.isCurrent(sessionId)).toBe(true);
  });

  it("returns null when the voice session lifecycle fence fails", () => {
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ runId: "run-main" }),
      sessionKey,
      undefined,
      "main",
    );

    expect(
      resolveOwnedActiveRealtimeVoiceRunTargetForAgent({
        sessionKey,
        agentId: "main",
        isSessionCurrent: () => false,
      }),
    ).toBeNull();
  });
});

describe("controlRealtimeVoiceAgentRun with Discord-shaped ownership", () => {
  const sessionKey = "agent:main:discord:channel:c1";
  const sessionId = "shared-colliding-session-id";
  let abortSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
    abortSpy = vi.fn();
  });

  afterEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
  });

  it("null runTarget refuses legacy abort of a foreign-owned run", async () => {
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ abort: abortSpy, runId: "run-ops" }),
      sessionKey,
      undefined,
      "ops",
    );

    const result = await controlRealtimeVoiceAgentRun({
      sessionKey,
      text: "cancel that",
      runTarget: null,
    });

    expect(result).toMatchObject({
      ok: false,
      active: false,
      reason: "no_active_run",
    });
    expect(abortSpy).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    clearActiveEmbeddedRun(sessionId);
  });

  it("owned runTarget cancels only the matching agent run", async () => {
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ abort: abortSpy, runId: "run-main" }),
      sessionKey,
      undefined,
      "main",
    );
    const runTarget = resolveOwnedActiveRealtimeVoiceRunTargetForAgent({
      sessionKey,
      agentId: "main",
    });
    expect(runTarget).not.toBeNull();

    const result = await controlRealtimeVoiceAgentRun({
      sessionKey,
      text: "cancel that",
      runTarget,
    });

    expect(result).toMatchObject({
      ok: true,
      active: true,
      aborted: true,
      sessionId,
    });
    expect(abortSpy).toHaveBeenCalled();
  });
});
