import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import * as providerFailover from "../../plugins/provider-failover.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }));

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent }));

describe("createAgentLifecycleTerminalBackstop", () => {
  it.each(["typed", "raw"] as const)(
    "publishes bounded selected-profile recovery from %s failures without discovering providers",
    (kind) => {
      const classifyProvider = vi
        .spyOn(providerFailover, "classifyProviderFailoverSignalWithPlugin")
        .mockImplementation(() => {
          throw new Error("Terminal presentation must not discover providers");
        });
      emitAgentEvent.mockClear();
      try {
        const profileId = "openai:private-profile";
        const rawCause = `Codex app-server auth profile "${profileId}" was not found`;
        const terminal = createAgentLifecycleTerminalBackstop({
          runId: "missing-selected-profile",
          sessionKey: "agent:main:test",
          getLifecycleGeneration: () => "test-generation",
          resolveTerminationFields: () => ({}),
        });

        const error =
          kind === "typed"
            ? new FailoverError(rawCause, {
                reason: "auth",
                code: "selected_auth_profile_unavailable",
                profileId,
                cause: new Error(rawCause),
              })
            : Object.assign(new Error(rawCause), {
                code: "selected_auth_profile_unavailable",
              });
        terminal.emit("error", error);

        const event = emitAgentEvent.mock.calls[0]?.[0];
        expect(event.data.error).toBe(
          renderFailoverCodeUserCopy("selected_auth_profile_unavailable"),
        );
        expect(JSON.stringify(event)).not.toContain(profileId);
        expect(JSON.stringify(event)).not.toContain(rawCause);
        expect(classifyProvider).not.toHaveBeenCalled();
      } finally {
        classifyProvider.mockRestore();
      }
    },
  );
});
