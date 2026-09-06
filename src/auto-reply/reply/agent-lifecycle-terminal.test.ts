import { describe, expect, it, vi } from "vitest";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { FailoverError } from "../../agents/failover-error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import * as providerFailover from "../../plugins/provider-failover.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }));

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent }));

describe("createAgentLifecycleTerminalBackstop", () => {
  it("publishes the provider-owned OAuth summary instead of the wrapped diagnostic", () => {
    emitAgentEvent.mockClear();
    const summary =
      "Your refresh token has already been used to generate a new access token. Please try signing in again.";
    const rawDiagnostic = `OAuth token refresh failed for openai: {"error":{"message":"${summary}"}}`;
    const oauthError = new OAuthRefreshFailureError({
      provider: "openai",
      message: rawDiagnostic,
      errorType: "invalid_request_error",
      reason: "refresh_token_reused",
      status: 401,
      summary,
    });
    const error = new Error("wrapped OAuth refresh failure", { cause: oauthError });
    const terminal = createAgentLifecycleTerminalBackstop({
      runId: "oauth-refresh-failure",
      getLifecycleGeneration: () => "test-generation",
      resolveTerminationFields: () => ({}),
    });

    terminal.emit("error", error);

    const event = emitAgentEvent.mock.calls[0]?.[0];
    expect(event.data.error).toBe(`⚠️ ${summary}`);
    expect(event.data.errorObservation).toEqual({
      provider: "openai",
      failoverReason: "refresh_token_reused",
      providerRuntimeFailureKind: "auth_refresh",
      providerErrorType: "invalid_request_error",
      httpStatus: 401,
    });
    expect(JSON.stringify(event)).not.toContain(rawDiagnostic);
  });

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
