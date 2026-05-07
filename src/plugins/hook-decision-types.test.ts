import { describe, expect, it } from "vitest";
import {
  BLOCK_MESSAGE_PREFIX,
  type HookDecision,
  type HookDecisionBlock,
  mergeHookDecisions,
  isHookDecision,
  resolveBlockMessage,
} from "./hook-decision-types.js";

describe("HookDecision helpers", () => {
  describe("isHookDecision", () => {
    it("recognizes supported outcomes", () => {
      expect(isHookDecision({ outcome: "pass" })).toBe(true);
      expect(isHookDecision({ outcome: "block", reason: "policy" })).toBe(true);
    });

    it("rejects non-decision values", () => {
      expect(isHookDecision(null)).toBe(false);
      expect(isHookDecision(undefined)).toBe(false);
      expect(isHookDecision("pass")).toBe(false);
      expect(isHookDecision({ block: true })).toBe(false);
      expect(isHookDecision({ outcome: "ask", reason: "check" })).toBe(false);
      expect(isHookDecision({ outcome: "invalid" })).toBe(false);
      expect(isHookDecision({ outcome: "pass", message: "typo" })).toBe(false);
      expect(isHookDecision({ outcome: "pass", reason: "typo" })).toBe(false);
      expect(isHookDecision({ outcome: "block" })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "" })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", message: "" })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", message: 3 })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", ask: true })).toBe(false);
      expect(isHookDecision({ outcome: "block", reason: "policy", metadata: [] })).toBe(false);
    });
  });

  describe("mergeHookDecisions", () => {
    const passDecision: HookDecision = { outcome: "pass" };
    const blockDecision: HookDecision = { outcome: "block", reason: "policy" };

    it("uses most-restrictive-wins ordering", () => {
      expect(mergeHookDecisions(undefined, passDecision)).toBe(passDecision);
      expect(mergeHookDecisions(passDecision, blockDecision)).toBe(blockDecision);
      expect(mergeHookDecisions(blockDecision, passDecision)).toBe(blockDecision);
    });

    it("keeps the first decision when outcomes have the same severity", () => {
      const secondBlock: HookDecision = { outcome: "block", reason: "second" };

      expect(mergeHookDecisions(passDecision, { outcome: "pass" })).toBe(passDecision);
      expect(mergeHookDecisions(blockDecision, secondBlock)).toBe(blockDecision);
    });
  });

  describe("resolveBlockMessage", () => {
    it("returns explicit or default block messages", () => {
      const explicit: HookDecisionBlock = {
        outcome: "block",
        reason: "policy",
        message: "Please rephrase your request.",
      };
      const fallback: HookDecisionBlock = {
        outcome: "block",
        reason: "policy",
      };

      expect(resolveBlockMessage(explicit)).toBe(
        `${BLOCK_MESSAGE_PREFIX}: Please rephrase your request.`,
      );
      expect(resolveBlockMessage(fallback)).toBe(`${BLOCK_MESSAGE_PREFIX}: blocked`);
      expect(resolveBlockMessage(fallback, { blockedBy: "policy-plugin" })).toBe(
        `${BLOCK_MESSAGE_PREFIX}: blocked by policy-plugin`,
      );
      expect(resolveBlockMessage(explicit, { blockedBy: "policy-plugin" })).toBe(
        `${BLOCK_MESSAGE_PREFIX}: Please rephrase your request. (blocked by policy-plugin)`,
      );
      expect(resolveBlockMessage({ ...explicit, message: "   " })).toBe(
        `${BLOCK_MESSAGE_PREFIX}: blocked`,
      );
    });
  });
});
