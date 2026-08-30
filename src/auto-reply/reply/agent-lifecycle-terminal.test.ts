import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }));

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent }));

describe("createAgentLifecycleTerminalBackstop", () => {
  it("publishes bounded selected-profile recovery from typed failures", () => {
    const profileId = "openai:private-profile";
    const rawCause = `Codex app-server auth profile "${profileId}" was not found`;
    const terminal = createAgentLifecycleTerminalBackstop({
      runId: "missing-selected-profile",
      sessionKey: "agent:main:test",
      getLifecycleGeneration: () => "test-generation",
      resolveTerminationFields: () => ({}),
    });

    terminal.emit(
      "error",
      new FailoverError(rawCause, {
        reason: "auth",
        code: "selected_auth_profile_unavailable",
        profileId,
        cause: new Error(rawCause),
      }),
    );

    const event = emitAgentEvent.mock.calls[0]?.[0];
    expect(event.data.error).toBe(renderFailoverCodeUserCopy("selected_auth_profile_unavailable"));
    expect(JSON.stringify(event)).not.toContain(profileId);
    expect(JSON.stringify(event)).not.toContain(rawCause);
  });
});
