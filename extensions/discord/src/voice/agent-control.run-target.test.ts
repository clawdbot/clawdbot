/**
 * Caller-path proof: Discord voice active-run control always passes owned
 * runTarget or null (fail-closed). Foreign agentId on the same sessionKey must
 * not be aborted via session-key legacy control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isEmbeddedAgentRunActive,
} from "../../../../src/agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as runsTesting,
} from "../../../../src/agents/embedded-agent-runner/runs.test-support.js";
import { controlDiscordVoiceAgentRun } from "./agent-control.js";

function createEntry(agentId = "main") {
  return {
    route: {
      agentId,
      sessionKey: "agent:main:discord:channel:c1",
    },
    generation: 1,
    sessionLifecycle: { status: "active" as const },
  };
}

describe("Discord voice control runTarget ownership (caller path)", () => {
  const sessionKey = "agent:main:discord:channel:c1";
  const sessionId = "shared-colliding-session-id";

  beforeEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
  });

  afterEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
  });

  it("fail-closed: foreign agent on the same sessionKey is not aborted", async () => {
    const abortSpy = vi.fn();
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ abort: abortSpy, runId: "run-ops" }),
      sessionKey,
      undefined,
      "ops",
    );

    const result = await controlDiscordVoiceAgentRun({
      entry: createEntry("main"),
      text: "cancel that",
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

  it("owned agent cancel aborts the matching embedded run", async () => {
    const abortSpy = vi.fn();
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ abort: abortSpy, runId: "run-main" }),
      sessionKey,
      undefined,
      "main",
    );

    const result = await controlDiscordVoiceAgentRun({
      entry: createEntry("main"),
      text: "cancel that",
    });

    expect(result).toMatchObject({
      ok: true,
      active: true,
      aborted: true,
      sessionId,
    });
    expect(abortSpy).toHaveBeenCalled();
  });

  it("stopped voice session refuses ownership (null fail-closed)", async () => {
    const abortSpy = vi.fn();
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ abort: abortSpy, runId: "run-main" }),
      sessionKey,
      undefined,
      "main",
    );

    const result = await controlDiscordVoiceAgentRun({
      entry: {
        ...createEntry("main"),
        sessionLifecycle: { status: "stopped", reason: "left" },
      },
      text: "cancel that",
    });

    expect(result).toMatchObject({
      ok: false,
      active: false,
      reason: "no_active_run",
    });
    expect(abortSpy).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
  });
});
