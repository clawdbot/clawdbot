import { describe, expect, it } from "vitest";
import {
  resolveGroupMessageGate,
  type GroupMessageGateInput,
  type GroupMessageGateResult,
} from "./message-gating.js";

// Compose a full input so each test can override just the interesting axis.
function input(overrides: Partial<GroupMessageGateInput>): GroupMessageGateInput {
  return {
    ignoreOtherMentions: false,
    hasAnyMention: false,
    wasMentioned: false,
    implicitMention: false,
    allowTextCommands: true,
    isControlCommand: false,
    commandAuthorized: false,
    requireMention: true,
    canDetectMention: true,
    ...overrides,
  };
}

function expectAction(
  result: GroupMessageGateResult,
  action: GroupMessageGateResult["action"],
): void {
  expect(result.action).toBe(action);
}

describe("engine/group/message-gating", () => {
  describe("Layer 1: ignoreOtherMentions", () => {
    it("drops messages that @other users when enabled", () => {
      const result = resolveGroupMessageGate(
        input({ ignoreOtherMentions: true, hasAnyMention: true }),
      );
      expectAction(result, "drop_other_mention");
    });

    it("does NOT drop when the bot itself was @-ed", () => {
      const result = resolveGroupMessageGate(
        input({ ignoreOtherMentions: true, hasAnyMention: true, wasMentioned: true }),
      );
      expectAction(result, "pass");
    });

    it("does NOT drop when implicitly mentioned via quote", () => {
      const result = resolveGroupMessageGate(
        input({ ignoreOtherMentions: true, hasAnyMention: true, implicitMention: true }),
      );
      expectAction(result, "pass");
    });

    it("is inactive when ignoreOtherMentions is off", () => {
      const result = resolveGroupMessageGate(
        input({ ignoreOtherMentions: false, hasAnyMention: true }),
      );
      // Falls through to mention gate — requireMention on, so skipped.
      expectAction(result, "skip_no_mention");
    });
  });

  describe("Layer 2: unauthorized control command", () => {
    it("silently blocks an unauthorized /stop", () => {
      const result = resolveGroupMessageGate(
        input({ isControlCommand: true, commandAuthorized: false }),
      );
      expectAction(result, "block_unauthorized_command");
    });

    it("passes through when sender is authorized", () => {
      const result = resolveGroupMessageGate(
        input({ isControlCommand: true, commandAuthorized: true, wasMentioned: true }),
      );
      expectAction(result, "pass");
    });

    it("does not trigger when text commands are disabled", () => {
      const result = resolveGroupMessageGate(
        input({
          allowTextCommands: false,
          isControlCommand: true,
          commandAuthorized: false,
          wasMentioned: true,
        }),
      );
      // allowTextCommands=false skips the block, so the mention gate decides.
      expectAction(result, "pass");
    });
  });

  describe("Layer 3: mention gating", () => {
    it("requires @bot when requireMention is on", () => {
      const result = resolveGroupMessageGate(input({ requireMention: true }));
      expectAction(result, "skip_no_mention");
      expect(result.effectiveWasMentioned).toBe(false);
    });

    it("passes through when explicitly mentioned", () => {
      const result = resolveGroupMessageGate(input({ requireMention: true, wasMentioned: true }));
      expectAction(result, "pass");
      expect(result.effectiveWasMentioned).toBe(true);
    });

    it("passes through on implicit mention", () => {
      const result = resolveGroupMessageGate(
        input({ requireMention: true, implicitMention: true }),
      );
      expectAction(result, "pass");
      expect(result.effectiveWasMentioned).toBe(true);
    });

    it("passes through when requireMention is off", () => {
      const result = resolveGroupMessageGate(input({ requireMention: false }));
      expectAction(result, "pass");
    });

    it("passes through when mention cannot be detected (DMs)", () => {
      const result = resolveGroupMessageGate(
        input({ requireMention: true, canDetectMention: false }),
      );
      expectAction(result, "pass");
    });
  });

  describe("command bypass", () => {
    it("bypasses mention gate for an authorized control command", () => {
      const result = resolveGroupMessageGate(
        input({
          requireMention: true,
          isControlCommand: true,
          commandAuthorized: true,
          allowTextCommands: true,
        }),
      );
      expectAction(result, "pass");
      expect(result.shouldBypassMention).toBe(true);
      expect(result.effectiveWasMentioned).toBe(true);
    });

    it("does NOT bypass when the command @-s another user", () => {
      const result = resolveGroupMessageGate(
        input({
          requireMention: true,
          isControlCommand: true,
          commandAuthorized: true,
          hasAnyMention: true,
        }),
      );
      expectAction(result, "skip_no_mention");
      expect(result.shouldBypassMention).toBe(false);
    });

    it("is a no-op when requireMention is off", () => {
      const result = resolveGroupMessageGate(
        input({
          requireMention: false,
          isControlCommand: true,
          commandAuthorized: true,
        }),
      );
      expectAction(result, "pass");
      // requireMention=false means bypass is unnecessary (condition 1 fails).
      expect(result.shouldBypassMention).toBe(false);
    });
  });

  describe("priority ordering", () => {
    it("layer 1 wins over layer 2 (ignoreOtherMentions before block)", () => {
      const result = resolveGroupMessageGate(
        input({
          ignoreOtherMentions: true,
          hasAnyMention: true,
          isControlCommand: true,
          commandAuthorized: false,
        }),
      );
      expectAction(result, "drop_other_mention");
    });

    it("layer 2 wins over layer 3 (unauthorized command before skip)", () => {
      const result = resolveGroupMessageGate(
        input({ requireMention: true, isControlCommand: true, commandAuthorized: false }),
      );
      expectAction(result, "block_unauthorized_command");
    });
  });
});
