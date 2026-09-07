import { describe, expect, it, vi } from "vitest";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import {
  classifyAcceptedChatSendFailure,
  runAcceptedChatSendDispatch,
  shouldRetainAcceptedChatSendRetryIdentity,
} from "./chat-send-retry.js";

const projectionError = new SessionTranscriptProjectionUnavailableError("sess-main");

describe("accepted chat-send retry classification", () => {
  it.each([
    {
      name: "pre-ACK projection unavailability",
      params: { error: projectionError, phase: "pre-ack" as const },
      expected: "client-retry",
    },
    {
      name: "post-ACK projection unavailability before execution",
      params: { error: projectionError, phase: "post-ack" as const },
      expected: "retry",
    },
    {
      name: "projection unavailability after model start",
      params: { error: projectionError, phase: "post-ack" as const, executionStarted: true },
      expected: "reconcile",
    },
    {
      name: "projection unavailability after observable side effects",
      params: { error: projectionError, phase: "post-ack" as const, sideEffectsObserved: true },
      expected: "reconcile",
    },
    {
      name: "an unclassified dispatch failure",
      params: { error: new Error("dispatch failed"), phase: "post-ack" as const },
      expected: "terminal",
    },
    {
      name: "an unclassified failure after model start",
      params: {
        error: new Error("dispatch failed"),
        phase: "post-ack" as const,
        executionStarted: true,
      },
      expected: "reconcile",
    },
    {
      name: "an unclassified failure after observable side effects",
      params: {
        error: new Error("dispatch failed"),
        phase: "post-ack" as const,
        sideEffectsObserved: true,
      },
      expected: "reconcile",
    },
  ])("classifies $name as $expected", ({ params, expected }) => {
    expect(classifyAcceptedChatSendFailure(params)).toBe(expected);
  });

  it("drops same-ID retry authority only for reconciliation-only failures", () => {
    expect(shouldRetainAcceptedChatSendRetryIdentity("reconcile")).toBe(false);
    expect(shouldRetainAcceptedChatSendRetryIdentity("terminal")).toBe(true);
    expect(shouldRetainAcceptedChatSendRetryIdentity("retry")).toBe(true);
  });

  it("stops at the bounded attempt count", async () => {
    const operation = vi.fn().mockRejectedValue(projectionError);
    const waitForRetry = vi.fn().mockResolvedValue(undefined);

    await expect(
      runAcceptedChatSendDispatch({
        operation,
        waitForRetry,
        classify: (error) => classifyAcceptedChatSendFailure({ error, phase: "post-ack" }),
      }),
    ).rejects.toBe(projectionError);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(waitForRetry).toHaveBeenCalledTimes(2);
  });
});
