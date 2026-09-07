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

  it("still rejects /approve after a quoted here-document whose body ends in a backslash", async () => {
    // The review's case: joining `x\` + `EOF` would move the terminator and
    // swallow the command into the body only in the rewritten input, while
    // the shell executes it (verified vs sh: body prints `x\`, then
    // `/approve` runs).
    const command = "cat <<'EOF'\nx\\\nEOF\n/approve abc123 allow-once\nEOF\n";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("does not treat a quoted here-document body as commands", async () => {
    const command = "cat <<'EOF'\n/approve abc123 allow-once\nEOF\necho done";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBeNull();
  });

  it("treats an empty here-document followed by a command normally", async () => {
    const command = "cat <<EOF\nEOF\n/approve abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("does not let a commented-out heredoc operator shield later lines", async () => {
    const command = "# cat <<EOF\n/approve abc123 allow-once";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("does not treat a herestring as a here-document body", async () => {
    const command = 'cat <<< "x"\n/approve abc123 allow-once';

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("honors tab-stripped terminators of <<- here-documents", async () => {
    const command = "cat <<-'EOF'\nx\\\n\tEOF\n/approve abc123 allow-once\nEOF\n";

    await expect(detectUnsafeExecControlShellCommand(command)).resolves.toBe("approve");
  });

  it("mirrors the shell joining continuations inside unquoted here-document bodies", async () => {
    // Verified vs sh: `x\` + `EOF` joins, destroying the terminator, so the
    // rest is body (nothing executes) — the guard must agree (null), not
    // report a swallowed command.
    const joinedTerminator = "cat <<EOF\nx\\\nEOF\necho done";

    await expect(detectUnsafeExecControlShellCommand(joinedTerminator)).resolves.toBeNull();
  });

  it("treats a split terminator inside an unquoted here-document as terminating", async () => {
    // Verified vs sh: `E\` + `OF` joins into the `EOF` terminator, so the
    // body ends and the following command runs (it is allowed → null).
    const splitTerminator = "cat <<EOF\nE\\\nOF\necho done";

    await expect(detectUnsafeExecControlShellCommand(splitTerminator)).resolves.toBeNull();
  });

  it("treats a continuation-joined operator line as opening its here-document", async () => {
    // Verified vs sh: `cat <<EOF \` + `body1` joins first, so `body1` is a
    // file argument and the body is empty — the following command runs.
    const joinedOperator = "cat <<EOF \\\nbody1\nEOF\necho done";

    await expect(detectUnsafeExecControlShellCommand(joinedOperator)).resolves.toBeNull();
  });
});
