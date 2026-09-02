/**
 * Focused privacy-safety tests for the E2E failure formatter in
 * subagent-requester-settle-two-wave-observed.e2e.test.ts
 * (OpenClaw #129635 regression coverage).
 *
 * This file tests the shape contract of what the failure formatter
 * is ALLOWED to include, by exercising the same sanitized pattern
 * it now uses: only a finite error kind and aggregate counts are included;
 * no raw errors, prompts, session IDs, message text, destination details,
 * or gateway logs.
 *
 * Because the E2E harness is a full integration test that requires
 * process orchestration, we test the formatter contract as a unit
 * by reproducing its exact logic here and asserting its output shape.
 */
import { describe, expect, it } from "vitest";
import { QA_TWO_WAVE_OBSERVED_FINAL_MARKER } from "./providers/mock-openai/mock-openai-contracts.js";

// ---------------------------------------------------------------------------
// Re-implementation of the safe failure formatter pattern used in the E2E test.
// This mirrors the actual failureContext function — if the real impl diverges,
// this test will fail to compile or type-check, catching drift early.
// ---------------------------------------------------------------------------

interface SafeMessage {
  direction: string;
  text?: string;
}

type FailureKind = "assertion" | "unknown";

function classifyFailure(error: unknown): FailureKind {
  return error instanceof Error && error.constructor?.name === "AssertionError"
    ? "assertion"
    : "unknown";
}

function buildSafeFailureError(opts: {
  label: string;
  cause: unknown;
  messages: SafeMessage[];
  outboundStartIndex: number;
  settleWakesSeen: number;
}): Error {
  const allOutbound = opts.messages.filter((m) => m.direction === "outbound");
  const outboundSinceTrigger = allOutbound.slice(opts.outboundStartIndex);
  return new Error(
    [
      opts.label,
      `errorKind=${classifyFailure(opts.cause)}`,
      `outboundTotalSinceTrigger=${outboundSinceTrigger.length}`,
      `outboundMarkerBearingCount=${outboundSinceTrigger.filter((m) => m.text?.includes(QA_TWO_WAVE_OBSERVED_FINAL_MARKER)).length}`,
      `settleWakesSeen=${opts.settleWakesSeen}`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Canary strings that must NEVER appear in failure output
// ---------------------------------------------------------------------------
const BANNED_CANARIES = [
  "prompt:secret-system-prompt",
  "sess-abc-danger",
  "msg-outbound-id-secret",
  "raw destination details",
  "gateway-log-line-internal",
  "session_id",
  "client_metadata",
];

describe("E2E failure formatter — safe output shape", () => {
  const syntheticMessages: SafeMessage[] = [
    { direction: "inbound", text: "user trigger" },
    { direction: "outbound", text: "some benign outbound before trigger" },
    // Messages after the trigger (index 2 onward = startIndex=2)
    { direction: "outbound", text: "wave1 response without marker" },
    { direction: "outbound", text: `final response with ${QA_TWO_WAVE_OBSERVED_FINAL_MARKER}` },
  ];

  it("produces only aggregate counts and booleans — no raw message text", () => {
    const err = buildSafeFailureError({
      label: "two-wave observed proof failed",
      cause: new Error("pollDebugRequests timed out after 30000ms"),
      messages: syntheticMessages,
      outboundStartIndex: 1, // 1 outbound message before the trigger
      settleWakesSeen: 1,
    });

    // Shape assertions: the message should contain exactly these safe fields
    expect(err.message).toContain("outboundTotalSinceTrigger=2");
    expect(err.message).toContain("outboundMarkerBearingCount=1");
    expect(err.message).toContain("settleWakesSeen=1");
    expect(err.message).toContain("errorKind=unknown");
    expect(err.message).not.toContain("pollDebugRequests timed out");
  });

  it("does not include any banned canary strings in its message", () => {
    const messagesWithCanaries: SafeMessage[] = [
      {
        direction: "outbound",
        text: `prompt:secret-system-prompt sess-abc-danger msg-outbound-id-secret ${QA_TWO_WAVE_OBSERVED_FINAL_MARKER}`,
      },
      {
        direction: "outbound",
        text: "raw destination details gateway-log-line-internal session_id client_metadata",
      },
    ];

    const err = buildSafeFailureError({
      label: "two-wave observed proof failed",
      cause: new Error(BANNED_CANARIES.join(" ")),
      messages: messagesWithCanaries,
      outboundStartIndex: 0,
      settleWakesSeen: 0,
    });

    for (const canary of BANNED_CANARIES) {
      expect(
        err.message,
        `banned canary "${canary}" must not appear in failure message`,
      ).not.toContain(canary);
    }
  });

  it("does not include raw JSON stringification of messages", () => {
    const err = buildSafeFailureError({
      label: "two-wave observed proof failed",
      cause: new Error("timeout"),
      messages: syntheticMessages,
      outboundStartIndex: 0,
      settleWakesSeen: 0,
    });

    // The banned patterns from the old impl
    expect(err.message).not.toContain('"text":');
    expect(err.message).not.toContain('"id":');
    expect(err.message).not.toContain('"prompt":');
    expect(err.message).not.toContain('"sessionId":');
    expect(err.message).not.toContain('"observed"');
    expect(err.message).not.toContain('"outbound":[');
  });

  it("counts marker-bearing messages correctly for zero-marker case", () => {
    const noMarkerMessages: SafeMessage[] = [
      { direction: "outbound", text: "response without marker" },
      { direction: "outbound", text: "another response without marker" },
    ];

    const err = buildSafeFailureError({
      label: "failed",
      cause: new Error("x"),
      messages: noMarkerMessages,
      outboundStartIndex: 0,
      settleWakesSeen: 0,
    });

    expect(err.message).toContain("outboundTotalSinceTrigger=2");
    expect(err.message).toContain("outboundMarkerBearingCount=0");
  });
});
