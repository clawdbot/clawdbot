// Copilot tests cover usage bridge plugin behavior.
import type { NormalizedUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  buildCopilotAssistantUsage,
  deriveCopilotUsageTotal,
  normalizeCopilotUsage,
} from "./usage-bridge.js";

const ZERO_SNAPSHOT: NormalizedUsage = {
  cacheRead: undefined,
  cacheWrite: undefined,
  input: undefined,
  output: undefined,
  total: 0,
};

describe("usage-bridge", () => {
  describe("normalizeCopilotUsage", () => {
    it("normalizes SDK inputTokens and outputTokens into NormalizedUsage", () => {
      expect(normalizeCopilotUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 10,
        output: 5,
        total: 15,
      });
    });

    it("normalizes SDK cacheReadTokens and cacheWriteTokens when present", () => {
      expect(normalizeCopilotUsage({ cacheReadTokens: 3, cacheWriteTokens: 4 })).toEqual({
        cacheRead: 3,
        cacheWrite: 4,
        input: undefined,
        output: undefined,
        total: 7,
      });
    });

    it("leaves missing cache token fields undefined rather than zero", () => {
      const usage = normalizeCopilotUsage({ inputTokens: 2 });

      expect(usage).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 2,
        output: undefined,
        total: 2,
      });
      expect(usage?.cacheRead).toBeUndefined();
      expect(usage?.cacheWrite).toBeUndefined();
    });

    it("returns a defined zero-snapshot when SDK event is an object with no valid fields", () => {
      expect(normalizeCopilotUsage({})).toEqual(ZERO_SNAPSHOT);
      expect(normalizeCopilotUsage({ inputTokens: undefined })).toEqual(ZERO_SNAPSHOT);
    });

    it("returns undefined for null / non-object input", () => {
      expect(normalizeCopilotUsage(null)).toBeUndefined();
      expect(normalizeCopilotUsage(undefined)).toBeUndefined();
      expect(normalizeCopilotUsage("usage")).toBeUndefined();
    });

    it("ignores string-typed token counts", () => {
      expect(normalizeCopilotUsage({ inputTokens: "5" })).toEqual(ZERO_SNAPSHOT);
    });

    it("ignores NaN and Infinity token counts", () => {
      expect(normalizeCopilotUsage({ inputTokens: Number.NaN })).toEqual(ZERO_SNAPSHOT);
      expect(normalizeCopilotUsage({ outputTokens: Number.POSITIVE_INFINITY })).toEqual(
        ZERO_SNAPSHOT,
      );
      expect(normalizeCopilotUsage({ cacheReadTokens: Number.NEGATIVE_INFINITY })).toEqual(
        ZERO_SNAPSHOT,
      );
      expect(normalizeCopilotUsage({ inputTokens: 2, outputTokens: Number.NaN })).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 2,
        output: undefined,
        total: 2,
      });
    });

    it("clamps negative token counts to zero", () => {
      expect(normalizeCopilotUsage({ inputTokens: -3 })).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 0,
        output: undefined,
        total: 0,
      });
    });

    it("truncates fractional token counts", () => {
      expect(normalizeCopilotUsage({ inputTokens: 3.7 })).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 3,
        output: undefined,
        total: 3,
      });
    });

    it("derives total from normalized SDK component counts for compatibility", () => {
      expect(
        normalizeCopilotUsage({
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          inputTokens: 1,
          outputTokens: 2,
        }),
      ).toEqual({
        cacheRead: 3,
        cacheWrite: 4,
        input: 1,
        output: 2,
        total: 10,
      });
    });

    it("does not mutate the caller-provided SDK event data", () => {
      const data = Object.freeze({ inputTokens: 4, outputTokens: 6 });

      expect(normalizeCopilotUsage(data)).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 4,
        output: 6,
        total: 10,
      });
      expect(data).toEqual({ inputTokens: 4, outputTokens: 6 });
    });

    it("only whitelists known SDK fields and ignores unrelated input keys", () => {
      expect(
        normalizeCopilotUsage({
          inputTokens: 5,
          malicious_field: 999,
          outputTokens: "bad",
          prompt_tokens: 100,
        }),
      ).toEqual({
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 5,
        output: undefined,
        total: 5,
      });
    });
  });

  describe("buildCopilotAssistantUsage", () => {
    it("builds rich AssistantMessage usage with zero cost fields", () => {
      expect(
        buildCopilotAssistantUsage({
          usage: { cacheRead: 3, cacheWrite: 4, input: 1, output: 2, total: 10 },
        }),
      ).toEqual({
        cacheRead: 3,
        cacheWrite: 4,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 1,
        output: 2,
        totalTokens: 10,
      });
    });

    it("defaults missing usage fields to zero in the rich block only", () => {
      expect(
        buildCopilotAssistantUsage({
          usage: { input: 4 },
        }),
      ).toEqual({
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 4,
        output: 0,
        totalTokens: 0,
      });
    });

    it("uses fallback outputTokens when no usage event was captured", () => {
      expect(buildCopilotAssistantUsage({ fallbackOutputTokens: 7 })).toEqual({
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 0,
        output: 7,
        totalTokens: 7,
      });
    });

    it("does not use fallback outputTokens when normalized usage is already present", () => {
      expect(
        buildCopilotAssistantUsage({
          fallbackOutputTokens: 9,
          usage: { input: 4, total: 4 },
        }),
      ).toEqual({
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 4,
        output: 0,
        totalTokens: 4,
      });
    });

    it("returns an all-zero block when both usage and fallback are missing", () => {
      expect(buildCopilotAssistantUsage({})).toEqual({
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
          total: 0,
        },
        input: 0,
        output: 0,
        totalTokens: 0,
      });
    });
  });

  describe("deriveCopilotUsageTotal", () => {
    it("returns undefined when usage is undefined", () => {
      expect(deriveCopilotUsageTotal(undefined)).toBeUndefined();
    });

    it("sums input/output/cacheRead/cacheWrite for total", () => {
      const usage: NormalizedUsage = {
        cacheRead: 3,
        cacheWrite: 4,
        input: 1,
        output: 2,
        total: 999,
      };

      expect(deriveCopilotUsageTotal(usage)).toBe(10);
    });
  });
});
