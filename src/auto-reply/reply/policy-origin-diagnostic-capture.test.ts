/**
 * Focused privacy-safety tests for policy-origin-diagnostic-capture.ts
 * (OpenClaw #129635 regression coverage).
 *
 * Verifies:
 * 1. Unknown / unallowlisted fields are silently omitted before persistence.
 * 2. Valid allowlisted fields with correct value types pass through unchanged.
 * 3. No raw string values outside the per-field enum allowlists are persisted.
 * 4. Env-gate: capture is a no-op when the env var is unset.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePolicyOrigin } from "./policy-origin-diagnostic-capture.js";

const CAPTURE_ENV_VAR = "OPENCLAW_SOURCE_REPLY_POLICY_CAPTURE_PATH";

function readCapture(path: string): {
  schemaVersion: number;
  events: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    schemaVersion: number;
    events: Array<Record<string, unknown>>;
  };
}

describe("capturePolicyOrigin — allowlist enforcement", () => {
  let capturePath: string;
  const originalEnv = process.env[CAPTURE_ENV_VAR];

  beforeEach(() => {
    capturePath = join(
      tmpdir(),
      `policy-origin-capture-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env[CAPTURE_ENV_VAR] = capturePath;
    writeFileSync(capturePath, JSON.stringify({ schemaVersion: 1, events: [] }), "utf8");
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[CAPTURE_ENV_VAR];
    } else {
      process.env[CAPTURE_ENV_VAR] = originalEnv;
    }
    if (existsSync(capturePath)) {
      rmSync(capturePath);
    }
  });

  it("persists allowlisted boolean fields", () => {
    capturePolicyOrigin("get-reply-run-context.resolved-modes", {
      isSyntheticTurn: true,
    });
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(1);
    expect(events[0].isSyntheticTurn).toBe(true);
    expect(events[0].point).toBe("get-reply-run-context.resolved-modes");
  });

  it("persists allowlisted string enum fields with valid values", () => {
    capturePolicyOrigin("followup-delivery.decision", {
      sendPolicy: "allow",
      finalSuppressionCategory: "none",
    });
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(1);
    expect(events[0].sendPolicy).toBe("allow");
    expect(events[0].finalSuppressionCategory).toBe("none");
  });

  it("persists null values for nullable fields", () => {
    capturePolicyOrigin("followup-delivery.decision", {
      queuedEffectiveMode: null,
      sendPolicy: "deny",
      finalSuppressionCategory: "send-policy",
    });
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(1);
    expect(events[0].queuedEffectiveMode).toBeNull();
  });

  it("omits unknown fields entirely — raw prompt/session/message canaries are rejected", () => {
    capturePolicyOrigin("followup-delivery.decision", {
      sendPolicy: "allow",
      // These are the privacy-sensitive fields that must never be persisted:
      prompt: "some secret prompt text",
      sessionId: "sess-abc123",
      messageText: "raw message content",
      outboundId: "out-xyz",
      destinationTarget: "telegram:12345",
      rawError: "Error: something internal",
      arbitraryPayload: { nested: true },
    });
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(1);
    const event = events[0];
    // Allowlisted field should be present
    expect(event.sendPolicy).toBe("allow");
    // All non-allowlisted fields must be absent
    expect(Object.keys(event)).not.toContain("prompt");
    expect(Object.keys(event)).not.toContain("sessionId");
    expect(Object.keys(event)).not.toContain("messageText");
    expect(Object.keys(event)).not.toContain("outboundId");
    expect(Object.keys(event)).not.toContain("destinationTarget");
    expect(Object.keys(event)).not.toContain("rawError");
    expect(Object.keys(event)).not.toContain("arbitraryPayload");
  });

  it("omits string values that are not in the per-field enum allowlist", () => {
    capturePolicyOrigin("followup-delivery.decision", {
      sendPolicy: "ARBITRARY_VALUE_NOT_IN_ENUM" as unknown as "allow",
      finalSuppressionCategory: "unknown-category" as unknown as "none",
    });
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(Object.keys(event)).not.toContain("sendPolicy");
    expect(Object.keys(event)).not.toContain("finalSuppressionCategory");
  });

  it("rejects numeric and object values for all fields", () => {
    capturePolicyOrigin("followup-delivery.source-policy-resolved", {
      queuedEffectiveMode: 42 as unknown as null,
      sendPolicy: { nested: "object" } as unknown as "allow",
    });
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(Object.keys(event)).not.toContain("queuedEffectiveMode");
    expect(Object.keys(event)).not.toContain("sendPolicy");
  });

  it("accumulates multiple events without overwriting", () => {
    capturePolicyOrigin("followup-delivery.decision", { sendPolicy: "allow" });
    capturePolicyOrigin("followup-delivery.decision", { sendPolicy: "deny" });
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(2);
    expect(events[0].sendPolicy).toBe("allow");
    expect(events[1].sendPolicy).toBe("deny");
  });

  it("is a no-op when the env var is unset", () => {
    delete process.env[CAPTURE_ENV_VAR];
    // Should not throw and should not create any files
    expect(() => capturePolicyOrigin("test-point", { prompt: "secret" })).not.toThrow();
    // Our pre-created file should remain as-is (empty events list)
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(0);
  });

  it("rejects unknown points — arbitrary point strings cannot persist", () => {
    capturePolicyOrigin("unknown.custom-point", { sendPolicy: "allow" });
    capturePolicyOrigin("", { sendPolicy: "allow" });
    capturePolicyOrigin("injection; DROP TABLE", { sendPolicy: "allow" });
    const { events } = readCapture(capturePath);
    // None of the unknown-point calls should have written an event.
    expect(events).toHaveLength(0);
  });

  it("persists allowlisted points and rejects unknown point in the same session", () => {
    capturePolicyOrigin("followup-delivery.decision", { sendPolicy: "allow" });
    capturePolicyOrigin("unknown-point", { sendPolicy: "deny" });
    capturePolicyOrigin("get-reply-run-context.resolved-modes", { isSyntheticTurn: false });
    const { events } = readCapture(capturePath);
    // Only the two allowlisted-point calls produce events.
    expect(events).toHaveLength(2);
    expect(events[0].point).toBe("followup-delivery.decision");
    expect(events[0].sendPolicy).toBe("allow");
    expect(events[1].point).toBe("get-reply-run-context.resolved-modes");
    expect(events[1].isSyntheticTurn).toBe(false);
  });

  it("point canary: raw error/session/prompt data in point string cannot persist", () => {
    // Supply a point that embeds what looks like sensitive data; it must be dropped.
    capturePolicyOrigin("prompt=secret&sessionId=sess-abc123", { isSyntheticTurn: true });
    const { events } = readCapture(capturePath);
    expect(events).toHaveLength(0);
  });
});
