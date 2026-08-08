import { describe, expect, it } from "vitest";
import {
  digestMemoryPersistenceFact,
  resolveMemoryPersistenceOutcomeObservation,
} from "./memory-persistence-outcome.js";

const confirmedReceipt = {
  version: 1,
  status: "created",
  backend: "memory-core",
  target: { kind: "file", path: "memory/2026-08-08.md" },
} as const;

describe("memory persistence outcome projection", () => {
  it("projects a valid receipt as confirmed host state", () => {
    const outcome = resolveMemoryPersistenceOutcomeObservation({
      toolName: "memory_store",
      memoryPersistenceReceiptVersion: 1,
      toolCallId: "store-confirmed",
      toolParams: { text: "The user prefers concise replies." },
      result: { details: { action: "created", memoryPersistence: confirmedReceipt } },
    });

    expect(outcome).toEqual({
      attemptDigest: digestMemoryPersistenceFact("call:store-confirmed"),
      factDigest: digestMemoryPersistenceFact("The user prefers concise replies."),
      status: "confirmed",
    });
  });

  it.each([
    ["incognito rejection", { action: "rejected", reason: "incognito_session" }],
    ["prompt-injection rejection", { action: "rejected", reason: "prompt_injection_detected" }],
    ["semantic-near duplicate", { action: "duplicate", existingId: "near-only" }],
  ])("projects a receiptless non-error %s as persistence not confirmed", (_name, details) => {
    expect(
      resolveMemoryPersistenceOutcomeObservation({
        toolName: "memory_store",
        memoryPersistenceReceiptVersion: 1,
        toolCallId: `store-${_name}`,
        toolParams: { text: "The user prefers concise replies." },
        result: { details },
      }),
    ).toEqual({
      attemptDigest: digestMemoryPersistenceFact(`call:store-${_name}`),
      factDigest: digestMemoryPersistenceFact("The user prefers concise replies."),
      status: "not-confirmed",
    });
  });

  it("projects an execution error as persistence not confirmed", () => {
    expect(
      resolveMemoryPersistenceOutcomeObservation({
        toolName: "memory_store",
        memoryPersistenceReceiptVersion: 1,
        toolCallId: "store-error",
        toolParams: { text: "The user prefers concise replies." },
        error: new Error("429 insufficient_quota"),
      }),
    ).toEqual({
      attemptDigest: digestMemoryPersistenceFact("call:store-error"),
      factDigest: digestMemoryPersistenceFact("The user prefers concise replies."),
      status: "not-confirmed",
    });
  });

  it("preserves case and meaningful internal whitespace in the non-sensitive fact digest", () => {
    expect(digestMemoryPersistenceFact("  ALPHA-7\r\n")).toBe(
      digestMemoryPersistenceFact("ALPHA-7"),
    );
    expect(digestMemoryPersistenceFact("caf\u00e9\rline two")).toBe(
      digestMemoryPersistenceFact("cafe\u0301\nline two"),
    );
    expect(digestMemoryPersistenceFact("ALPHA-7")).not.toBe(digestMemoryPersistenceFact("alpha-7"));
    expect(digestMemoryPersistenceFact("first  second")).not.toBe(
      digestMemoryPersistenceFact("first second"),
    );
  });

  it("ignores non-memory tools without hashing their inputs", () => {
    expect(
      resolveMemoryPersistenceOutcomeObservation({
        toolName: "memory_recall",
        toolParams: { text: "sensitive" },
        result: { details: {} },
      }),
    ).toBeUndefined();
  });

  it("leaves a receiptless legacy memory_store success compatible without an opt-in marker", () => {
    expect(
      resolveMemoryPersistenceOutcomeObservation({
        toolName: "memory_store",
        toolCallId: "legacy-store",
        toolParams: { text: "The user prefers concise replies." },
        result: { details: { action: "created" } },
      }),
    ).toBeUndefined();
  });
});
