/** Verifies Telegram update outcomes stay attached to their durable ingress owner. */
import { describe, expect, it } from "vitest";
import {
  ensureTelegramMessageProcessingResult,
  recordTelegramMessageProcessingResult,
  runWithTelegramUpdateProcessingFrame,
} from "./bot-processing-outcome.js";

describe("Telegram update processing outcomes", () => {
  it("reuses the ingress outcome frame across nested bot middleware", async () => {
    const outer = await runWithTelegramUpdateProcessingFrame(async () => {
      const inner = await runWithTelegramUpdateProcessingFrame(async () => {
        ensureTelegramMessageProcessingResult({ kind: "completed" });
        return "middleware-finished";
      });

      expect(inner).toEqual({ value: "middleware-finished", result: { kind: "completed" } });
      return "update-finished";
    });

    expect(outer).toEqual({ value: "update-finished", result: { kind: "completed" } });
  });

  it.each([
    { kind: "skipped" as const },
    { kind: "failed-retryable" as const, error: new Error("retry") },
  ])(
    "does not replace an explicit $kind disposition with middleware completion",
    async (expected) => {
      const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
        recordTelegramMessageProcessingResult(expected);
        ensureTelegramMessageProcessingResult({ kind: "completed" });
      });

      expect(result).toBe(expected);
    },
  );

  it("keeps deferred owners outcome-free until their participant settles", async () => {
    const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
      await runWithTelegramUpdateProcessingFrame(async () => {});
    });

    expect(result).toBeUndefined();
  });
});
