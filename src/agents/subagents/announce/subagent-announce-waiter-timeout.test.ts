/**
 * openclaw-2hlg — an announce waiter timeout is not a delivery failure.
 *
 * The announce dispatch uses `expectFinal: true` with a 120s timeout, so
 * "delivery succeeded" was being decided by whether the REQUESTER finished its
 * whole turn inside that window. Requester turn duration is unbounded by
 * design, so no finite window makes that a sound test — any parent that keeps
 * working for two minutes after receiving an announce manufactured a failure
 * for an announce it already had.
 *
 * Measured before the fix: child run ended 11:51:51, the announce run started
 * inside the requester at 11:51:52.905 (delivered), and
 * "direct announce failed ... gateway request timeout for agent" was logged at
 * 11:53:51.316 — exactly 120s later. Retry ladders of 12-13 attempts were
 * re-firing against announces that landed on the first attempt.
 *
 * The classifier must stay NARROW: openclaw-ykga depends on a child that
 * actually died remaining distinguishable from a parent that was merely slow,
 * so only this one error may be reclassified.
 */

import { describe, expect, it } from "vitest";
import {
  isAnnounceAgentWaiterTimeoutError,
  isPermanentAnnounceDeliveryError,
} from "./subagent-announce-delivery-retry.js";

describe("isAnnounceAgentWaiterTimeoutError", () => {
  it("matches the in-process dispatcher's agent timeout — the false alarm", () => {
    // Exact string raised by server-in-process-dispatch.ts for method "agent".
    expect(isAnnounceAgentWaiterTimeoutError(new Error("gateway request timeout for agent"))).toBe(
      true,
    );
  });

  it("matches when the message is wrapped by the delivery-error summary", () => {
    // Production logs it as: "gateway request timeout for agent; direct-primary: ..."
    expect(
      isAnnounceAgentWaiterTimeoutError(
        new Error(
          "gateway request timeout for agent; direct-primary: gateway request timeout for agent",
        ),
      ),
    ).toBe(true);
  });

  it("does NOT match a timeout on some other gateway method", () => {
    // A timeout waiting on sessions.list or connect is not evidence that THIS
    // announce was handed off, so it must keep failing and retrying.
    expect(
      isAnnounceAgentWaiterTimeoutError(new Error("gateway request timeout for sessions.list")),
    ).toBe(false);
    expect(
      isAnnounceAgentWaiterTimeoutError(new Error("gateway request timeout for connect")),
    ).toBe(false);
  });

  it("does NOT match genuine delivery failures — protects openclaw-ykga", () => {
    // If any of these were reclassified as delivered, a child that really failed
    // to announce would be silently dropped instead of retried.
    for (const message of [
      "In-process gateway dispatch requires a gateway request scope or instance binding (method: agent)",
      "requester session abandoned after timeout",
      "prepared model runtime replaced the admitted plugin generation",
      "incomplete terminal response",
      "ECONNREFUSED",
    ]) {
      expect(
        isAnnounceAgentWaiterTimeoutError(new Error(message)),
        `must not reclassify: ${message}`,
      ).toBe(false);
    }
  });

  it("does not swallow a non-error value", () => {
    expect(isAnnounceAgentWaiterTimeoutError(undefined)).toBe(false);
    expect(isAnnounceAgentWaiterTimeoutError(null)).toBe(false);
    expect(isAnnounceAgentWaiterTimeoutError("")).toBe(false);
  });

  it("is disjoint from the permanent-failure classifier", () => {
    // The two must never both claim the same error, or ordering in the catch
    // block would decide behaviour silently.
    const waiterTimeout = new Error("gateway request timeout for agent");
    expect(isAnnounceAgentWaiterTimeoutError(waiterTimeout)).toBe(true);
    expect(isPermanentAnnounceDeliveryError(waiterTimeout)).toBe(false);
  });
});
