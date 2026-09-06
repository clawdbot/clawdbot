import { describe, expect, it } from "vitest";
import {
  detectUnsafeExecControlShellCommand,
  rejectUnsafeExecControlShellCommand,
} from "./exec-control-command-guard.js";

function nestedCommandSubstitution(inner: string, depth: number): string {
  return "$( ".repeat(depth) + inner + " )".repeat(depth);
}

describe("exec control command guard", () => {
  it("rejects a control command below deeply nested command substitutions", async () => {
    const command = nestedCommandSubstitution("/approve abc123 allow-once", 5_000);

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
    await expect(rejectUnsafeExecControlShellCommand(command)).rejects.toThrow(
      /exec cannot run \/approve commands/,
    );
  });

  it("rejects commands that exceed the explanation work limit", async () => {
    const command = nestedCommandSubstitution("echo hi", 11_000);

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("incomplete-analysis");
    await expect(rejectUnsafeExecControlShellCommand(command)).rejects.toThrow(
      /exceeds the command explanation work limit/,
    );
  });

  it("rejects /approve hidden behind a shell line continuation", async () => {
    const command = "echo hi; /appr\\\nove abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
    await expect(rejectUnsafeExecControlShellCommand(command)).rejects.toThrow(
      /exec cannot run \/approve commands/,
    );
  });

  it("rejects /approve hidden behind a line continuation inside sh -c", async () => {
    const command = "sh -c 'echo hi; /appr\\\nove abc123 allow-once'";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("keeps an escaped backslash before a newline as a command separator", async () => {
    const command = "echo \\\\\n/approve abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("leaves backslash-CRLF alone (not a shell continuation, must not false-positive)", async () => {
    const command = "echo hi; /appr\\\r\nove abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBeNull();
  });

  it("still rejects /approve on the line after a backslash-ended comment", async () => {
    // A `#` comment ends at the newline: joining it would swallow the command.
    const command = "# note \\\n/approve abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("still rejects /approve after a mid-line backslash-ended comment", async () => {
    const command = "echo hi # c \\\n/approve abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("still rejects /approve after an even backslash run (real separator)", async () => {
    // `\\` is a literal backslash; the newline stays a separator, so the
    // prohibition arrives as its own command and must be caught as-is.
    const command = "echo X \\\\\n/approve abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });
});
