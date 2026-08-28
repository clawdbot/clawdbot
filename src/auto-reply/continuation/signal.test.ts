import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { extractContinuationSignal } from "./signal.js";

describe("extractContinuationSignal", () => {
  it("returns null when disabled", () => {
    const result = extractContinuationSignal({
      payloads: [{ text: "reply\nCONTINUE_WORK" }],
      enabled: false,
    });
    expect(result.signal).toBeNull();
  });

  it("extracts bracket signal from last text payload", () => {
    const payloads = [{ text: "Here is my reply.\n\n[[CONTINUE_DELEGATE: check status]]" }];
    const result = extractContinuationSignal({
      payloads,
      enabled: true,
      sessionKey: "test",
    });
    expect(result.signal?.kind).toBe("delegate");
    expect(result.fromBracket).toBe(true);
    // Text should be stripped
    expect(expectDefined(payloads.at(0), "payload").text).toBe("Here is my reply.");
  });

  it("extracts CONTINUE_WORK from text", () => {
    const payloads = [{ text: "Done for now.\nCONTINUE_WORK:30" }];
    const result = extractContinuationSignal({
      payloads,
      enabled: true,
    });
    expect(result.signal).toEqual({ kind: "work", delayMs: 30_000 });
    expect(result.fromBracket).toBe(true);
  });

  it("falls back to tool-call request when no bracket signal", () => {
    const result = extractContinuationSignal({
      payloads: [{ text: "Normal reply." }],
      continueWorkRequest: { reason: "more to do", delaySeconds: 15 },
      enabled: true,
    });
    expect(result.signal).toEqual({ kind: "work", delayMs: 15_000 });
    expect(result.fromBracket).toBe(false);
    expect(result.workReason).toBe("more to do");
  });

  it("handles absent tool-call traceparent without adding a carrier", () => {
    const result = extractContinuationSignal({
      payloads: [{ text: "Normal reply." }],
      continueWorkRequest: { reason: "more to do", delaySeconds: 15 },
      enabled: true,
    });

    expect(result.signal).toEqual({ kind: "work", delayMs: 15_000 });
    expect(result.signal).not.toHaveProperty("traceparent");
    expect(result.fromBracket).toBe(false);
    expect(result.workReason).toBe("more to do");
  });

  it("keeps tool-call traceparent out of the merged model-facing signal", () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const result = extractContinuationSignal({
      payloads: [{ text: "Normal reply." }],
      continueWorkRequest: { reason: "more to do", delaySeconds: 15, traceparent },
      enabled: true,
    });

    expect(result.signal).toEqual({ kind: "work", delayMs: 15_000 });
    expect(result.signal).not.toHaveProperty("traceparent");
    expect(result.fromBracket).toBe(false);
    expect(result.workReason).toBe("more to do");
  });

  it("bracket signal takes precedence over tool-call request", () => {
    const payloads = [{ text: "reply\nCONTINUE_WORK:5" }];
    const result = extractContinuationSignal({
      payloads,
      continueWorkRequest: { reason: "tool", delaySeconds: 60 },
      enabled: true,
    });
    // Bracket wins
    expect(result.signal).toEqual({ kind: "work", delayMs: 5_000 });
    expect(result.fromBracket).toBe(true);
    expect(result.workReason).toBeUndefined();
  });

  it("handles empty payloads", () => {
    const result = extractContinuationSignal({
      payloads: [],
      enabled: true,
    });
    expect(result.signal).toBeNull();
  });

  it("scans backward through payloads to find last text", () => {
    const payloads = [
      { text: "First reply with bracket\n[[CONTINUE_DELEGATE: old task]]" },
      { toolCall: true }, // non-text payload
      { text: "Latest reply\n[[CONTINUE_DELEGATE: real task]]" },
    ];
    const result = extractContinuationSignal({
      payloads,
      enabled: true,
    });
    expect(result.signal?.kind).toBe("delegate");
    if (result.signal?.kind === "delegate") {
      expect(result.signal.task).toBe("real task");
    }
  });

  // Regression test: previously the scan stopped
  // at the LAST payload with text and missed markers on earlier payloads when
  // a later non-marker text payload (e.g. a warning/error block) followed the
  // model's continuation-signaling text. The fix scans all payloads for the
  // marker, walking backward so the latest marker wins.
  it("finds marker on earlier payload even when a later payload has plain non-marker text (regression)", () => {
    const payloads = [
      { text: "Investigating a thing.\nCONTINUE_WORK:45" },
      { text: "warning: tool call failed, will retry" }, // later payload, no marker
    ];
    const result = extractContinuationSignal({
      payloads,
      enabled: true,
    });
    expect(result.signal).toEqual({ kind: "work", delayMs: 45_000 });
    expect(result.fromBracket).toBe(true);
    // Text on the marker-bearing payload was stripped.
    expect(expectDefined(payloads.at(0), "first payload").text).toBe("Investigating a thing.");
    // Later non-marker payload is left untouched.
    expect(expectDefined(payloads.at(1), "second payload").text).toBe(
      "warning: tool call failed, will retry",
    );
  });

  it("when two payloads carry markers, the latest one wins (regression)", () => {
    const payloads = [
      { text: "earlier intent\n[[CONTINUE_DELEGATE: stale-task]]" },
      { text: "actual final intent\n[[CONTINUE_DELEGATE: real-task]]" },
    ];
    const result = extractContinuationSignal({
      payloads,
      enabled: true,
    });
    expect(result.signal?.kind).toBe("delegate");
    if (result.signal?.kind === "delegate") {
      expect(result.signal.task).toBe("real-task");
    }
    // Only the winning payload's text should be stripped.
    expect(expectDefined(payloads.at(1), "second payload").text).toBe("actual final intent");
    // The earlier payload's text is left untouched (not consulted further).
    expect(expectDefined(payloads.at(0), "first payload").text).toBe(
      "earlier intent\n[[CONTINUE_DELEGATE: stale-task]]",
    );
  });
});
