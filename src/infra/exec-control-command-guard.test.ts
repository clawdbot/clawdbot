import { describe, expect, it } from "vitest";
import {
  detectUnsafeExecControlShellCommand,
  rejectUnsafeExecControlShellCommand,
} from "./exec-control-command-guard.js";

describe("Skill Workshop lifecycle exec guard", () => {
  it.each(["apply", "reject", "quarantine"])(
    "detects openclaw skills workshop %s",
    async (action) => {
      await expect(
        detectUnsafeExecControlShellCommand(`openclaw skills workshop ${action} proposal-123`),
      ).resolves.toBe("skill-workshop-lifecycle");
    },
  );

  it("detects package-runner and nested shell variants", async () => {
    await expect(
      detectUnsafeExecControlShellCommand(
        "bash -lc 'pnpm exec openclaw skills workshop apply proposal-123'",
      ),
    ).resolves.toBe("skill-workshop-lifecycle");
  });

  it("allows read-only workshop commands", async () => {
    await expect(
      detectUnsafeExecControlShellCommand("openclaw skills workshop list"),
    ).resolves.toBeNull();
  });

  it("rejects lifecycle commands with a tool-specific message", async () => {
    await expect(
      rejectUnsafeExecControlShellCommand("openclaw skills workshop apply proposal-123"),
    ).rejects.toThrow("Use the skill_workshop tool");
  });
});

describe("approval command exec guard", () => {
  it.each([
    "/approve exec-123 allow-once",
    "/approve exec-123 always",
    "/approve always exec-123",
    "/approve@openclaw plugin:approval-123 reject",
  ])("uses the shared approval grammar for %s", async (command) => {
    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });
});
