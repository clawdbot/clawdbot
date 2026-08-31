import { describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { FailoverError } from "../failover-error.js";
import { renderFailoverCodeUserCopy } from "../failover/user-copy.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";

const { emitAgentEvent, lifecycleLog } = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  lifecycleLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent }));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => lifecycleLog,
}));

describe("createAgentCommandLifecycle", () => {
  it.each([
    { name: "successful stops", status: "ok", stopReason: "stop", level: "info" },
    { name: "tool-use stops", status: "ok", stopReason: "toolUse", level: "info" },
    { name: "ordinary end turns", status: "ok", stopReason: "end_turn", level: undefined },
    { name: "timeouts", status: "timeout", stopReason: "timeout", level: "warn" },
    { name: "cancelled runs", status: "error", stopReason: "stop", level: "error" },
    { name: "failed runs", status: "error", stopReason: "error", level: "error" },
  ] as const)("logs $name at the expected severity", ({ status, stopReason, level }) => {
    vi.clearAllMocks();
    const lifecycle = createAgentCommandLifecycle({
      runId: "logged-terminal-owner",
      lifecycleGeneration: () => "test-generation",
      startedAt: 100,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });

    lifecycle.emitEnd({
      metadata: {},
      outcome: buildAgentRunTerminalOutcome({ status, stopReason }),
    });

    for (const candidate of ["info", "warn", "error"] as const) {
      if (candidate === level) {
        expect(lifecycleLog[candidate]).toHaveBeenCalledOnce();
      } else {
        expect(lifecycleLog[candidate]).not.toHaveBeenCalled();
      }
    }
  });

  it.each(["finishing", "end", "error"] as const)(
    "preserves only canonical terminal facts on %s events",
    (phase) => {
      emitAgentEvent.mockClear();
      const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
      const metadata = {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        livenessState: "blocked",
        yielded: true,
        replayInvalid: true,
        error: { message: `Authorization: Bearer ${secret}`, nested: { secret } },
        terminalDelivery: {
          status: "sent",
          resultCount: 2,
          errorMessage: secret,
          target: "private-target",
        },
        unsafeMetadata: { credential: secret },
      };
      const lifecycle = createAgentCommandLifecycle({
        runId: "terminal-owner",
        lifecycleGeneration: () => "test-generation",
        startedAt: 100,
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
      });
      const terminal = {
        metadata,
        outcome: buildAgentRunTerminalOutcome({ status: "timeout", ...metadata }),
      };

      if (phase === "finishing") {
        lifecycle.emitFinishing(terminal);
      } else if (phase === "end") {
        lifecycle.emitEnd(terminal);
      } else {
        lifecycle.emitResultError(
          {
            payloads: [],
            meta: {
              durationMs: 0,
              error: { kind: "retry_limit", message: "internal provider diagnostic" },
            },
          },
          true,
          terminal,
        );
      }

      expect(emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "terminal-owner",
          stream: "lifecycle",
          data: expect.objectContaining({
            phase,
            aborted: true,
            stopReason: "timeout",
            timeoutPhase: "provider",
            providerStarted: true,
            livenessState: "blocked",
            yielded: true,
            replayInvalid: true,
            ...(phase === "error" ? { fallbackExhaustedFailure: true } : {}),
          }),
        }),
      );
      const event = emitAgentEvent.mock.calls[0]?.[0];
      expect(event.data.terminalDelivery).toEqual({ status: "sent", resultCount: 2 });
      expect(JSON.stringify(event)).not.toContain(secret);
      expect(event.data).not.toHaveProperty("unsafeMetadata");
    },
  );

  it.each(["lifecycle callback", "fallback payload", "post-turn error"] as const)(
    "redacts credentials from a %s before publishing the lifecycle event",
    (source) => {
      emitAgentEvent.mockClear();
      const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
      const error = `The provider failed. Authorization: Bearer ${secret}`;
      const state = {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
        ...(source === "lifecycle callback" ? { lifecycleError: error } : {}),
      };
      const lifecycle = createAgentCommandLifecycle({
        runId: "secret-safe-terminal-owner",
        lifecycleGeneration: () => "test-generation",
        startedAt: 100,
        state,
      });
      const terminal = {
        metadata: {},
        outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
      };

      if (source === "post-turn error") {
        lifecycle.emitPostTurnError(new Error(error), terminal);
      } else {
        lifecycle.emitResultError(
          {
            payloads: source === "fallback payload" ? [{ isError: true, text: error }] : [],
            meta: { durationMs: 0 },
          },
          source === "fallback payload",
          terminal,
        );
      }

      const event = emitAgentEvent.mock.calls[0]?.[0];
      expect(event.data.error).toContain("The provider failed.");
      expect(event.data.error).toContain("Authorization: Bearer");
      expect(JSON.stringify(event)).not.toContain(secret);
    },
  );

  it.each(["basic", "post-turn"] as const)(
    "publishes bounded selected-profile recovery from %s lifecycle errors",
    (source) => {
      emitAgentEvent.mockClear();
      const profileId = "openai:private-profile";
      const rawCause = `Codex app-server auth profile "${profileId}" was not found`;
      const lifecycle = createAgentCommandLifecycle({
        runId: "missing-selected-profile",
        lifecycleGeneration: () => "test-generation",
        startedAt: 100,
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
      });
      const error = new FailoverError(rawCause, {
        reason: "auth",
        code: "selected_auth_profile_unavailable",
        profileId,
        cause: new Error(rawCause),
      });

      if (source === "basic") {
        lifecycle.emitBasicError(error);
      } else {
        lifecycle.emitPostTurnError(error, {
          metadata: {},
          outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
        });
      }

      const event = emitAgentEvent.mock.calls[0]?.[0];
      expect(event.data.error).toBe(
        renderFailoverCodeUserCopy("selected_auth_profile_unavailable"),
      );
      expect(JSON.stringify(event)).not.toContain(profileId);
      expect(JSON.stringify(event)).not.toContain(rawCause);
    },
  );

  it("does not let generic abort metadata erase a superseded outcome", () => {
    emitAgentEvent.mockClear();
    const controller = new AbortController();
    controller.abort();
    const lifecycle = createAgentCommandLifecycle({
      runId: "superseded-owner",
      lifecycleGeneration: () => "test-generation",
      startedAt: 100,
      abortSignal: controller.signal,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });

    lifecycle.emitEnd({
      metadata: { aborted: true },
      outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "superseded" }),
    });

    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aborted: true,
          phase: "end",
          stopReason: "superseded",
        }),
      }),
    );
  });

  it("keeps post-turn errors narrow while publishing bounded delivery evidence", () => {
    emitAgentEvent.mockClear();
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const lifecycle = createAgentCommandLifecycle({
      runId: "post-turn-delivery-owner",
      lifecycleGeneration: () => "test-generation",
      startedAt: 100,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });
    lifecycle.emitPostTurnError(new Error("delivery failed"), {
      metadata: {
        terminalDelivery: {
          status: "failed",
          resultCount: 0,
          errorMessage: secret,
        },
        terminalReceipt: { runId: "unrelated-receipt", secret },
        terminalReply: { disposition: "visible", text: secret },
        unsafeMetadata: { secret },
      },
      outcome: buildAgentRunTerminalOutcome({
        status: "timeout",
        stopReason: "timeout",
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    });

    const event = emitAgentEvent.mock.calls[0]?.[0];
    expect(event.data).toMatchObject({
      phase: "error",
      error: "delivery failed",
      terminalDelivery: { status: "failed", resultCount: 0 },
    });
    expect(JSON.stringify(event)).not.toContain(secret);
    for (const field of [
      "aborted",
      "stopReason",
      "livenessState",
      "timeoutPhase",
      "providerStarted",
      "terminalReceipt",
      "terminalReply",
      "unsafeMetadata",
    ]) {
      expect(event.data).not.toHaveProperty(field);
    }
  });

  it.each(["finishing", "end", "error"] as const)(
    "rejects malformed canonical metadata on %s events",
    (phase) => {
      emitAgentEvent.mockClear();
      const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
      const malicious = { authorization: `Bearer ${secret}`, nested: { secret } };
      const lifecycle = createAgentCommandLifecycle({
        runId: "malformed-terminal-owner",
        lifecycleGeneration: () => "test-generation",
        startedAt: 100,
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
      });
      const terminal = {
        metadata: {
          aborted: malicious,
          stopReason: malicious,
          yielded: malicious,
          timeoutPhase: malicious,
          providerStarted: malicious,
          livenessState: malicious,
          replayInvalid: malicious,
          terminalReceipt: malicious,
          terminalDelivery: malicious,
          error: malicious,
          unknownMetadata: malicious,
        },
        outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
      };

      if (phase === "finishing") {
        lifecycle.emitFinishing(terminal);
      } else if (phase === "end") {
        lifecycle.emitEnd(terminal);
      } else {
        lifecycle.emitResultError({ payloads: [], meta: { durationMs: 0 } }, false, terminal);
      }

      const event = emitAgentEvent.mock.calls[0]?.[0];
      expect(event.data).toMatchObject({ phase, aborted: false, stopReason: "error" });
      expect(JSON.stringify(event)).not.toContain(secret);
      for (const field of [
        "yielded",
        "timeoutPhase",
        "providerStarted",
        "livenessState",
        "replayInvalid",
        "terminalDelivery",
        "terminalReceipt",
        "unknownMetadata",
      ]) {
        expect(event.data).not.toHaveProperty(field);
      }
    },
  );
});
