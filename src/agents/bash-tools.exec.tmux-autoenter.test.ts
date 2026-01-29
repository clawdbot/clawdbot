import { afterEach, describe, expect, test } from "vitest";

import { resetProcessRegistryForTests } from "./bash-process-registry";
import { createExecTool } from "./bash-tools.exec";

afterEach(() => {
  resetProcessRegistryForTests();
});

describe("tmux send-keys autoEnter", () => {
  test("regular exec commands unchanged when autoEnter is true", async () => {
    const execTool = createExecTool();
    const result = await execTool.execute("toolcall", {
      command: "echo hello",
      autoEnter: true,
    });
    // Should complete normally without modification
    expect(result.details.status).toBe("completed");
    expect((result.details as { aggregated?: string }).aggregated).toContain("hello");
  });

  test("tmux send-keys with Enter unchanged when autoEnter is true", async () => {
    const execTool = createExecTool();
    // This command already has Enter, so it shouldn't be added again
    // We use echo to simulate the command (can't actually run tmux in test)
    const result = await execTool.execute("toolcall", {
      command: 'echo "tmux send-keys -t test echo hello Enter"',
      autoEnter: true,
    });
    expect(result.details.status).toBe("completed");
    // The echo should show the command unchanged (only one Enter)
    const output = (result.details as { aggregated?: string }).aggregated ?? "";
    expect(output).toContain("Enter");
    // Should not have "Enter Enter" (double Enter)
    expect(output).not.toMatch(/Enter\s+Enter/);
  });

  test("tmux send-keys without Enter gets Enter appended when autoEnter is true", async () => {
    const execTool = createExecTool();
    // We can verify the auto-enter logic by checking that the command runs with Enter appended.
    // Since we can't run actual tmux in tests, we use a marker approach:
    // The command will include 'send-keys' and we can verify via echo that Enter is appended.
    const result = await execTool.execute("toolcall", {
      command: 'sh -c \'echo "$0" "$@"\' tmux send-keys -t test "hello"',
      autoEnter: true,
    });
    expect(result.details.status).toBe("completed");
    const output = (result.details as { aggregated?: string }).aggregated ?? "";
    // Since autoEnter is true and the command contains 'tmux send-keys' without Enter,
    // Enter should be appended. The echo will show the arguments including Enter.
    expect(output).toContain("Enter");
  });

  test("tmux send-keys unchanged when autoEnter is false", async () => {
    const execTool = createExecTool();
    const result = await execTool.execute("toolcall", {
      command: 'sh -c \'echo "$0" "$@"\' tmux send-keys -t test "hello"',
      autoEnter: false,
    });
    expect(result.details.status).toBe("completed");
    const output = (result.details as { aggregated?: string }).aggregated ?? "";
    // autoEnter is false, so Enter should NOT be appended
    expect(output).not.toContain("Enter");
  });

  test("tmux send-keys unchanged when autoEnter is not set", async () => {
    const execTool = createExecTool();
    const result = await execTool.execute("toolcall", {
      command: 'sh -c \'echo "$0" "$@"\' tmux send-keys -t test "hello"',
    });
    expect(result.details.status).toBe("completed");
    const output = (result.details as { aggregated?: string }).aggregated ?? "";
    // autoEnter defaults to undefined/false, so Enter should NOT be appended
    expect(output).not.toContain("Enter");
  });

  test("tmux send-keys with trailing quote and Enter unchanged", async () => {
    const execTool = createExecTool();
    const result = await execTool.execute("toolcall", {
      command: 'echo "tmux send-keys -t test hello Enter"',
      autoEnter: true,
    });
    expect(result.details.status).toBe("completed");
    const output = (result.details as { aggregated?: string }).aggregated ?? "";
    // Should have exactly one Enter, not double
    const enterCount = (output.match(/Enter/g) || []).length;
    expect(enterCount).toBe(1);
  });

  test("handles tmux -S socket send-keys pattern", async () => {
    const execTool = createExecTool();
    const result = await execTool.execute("toolcall", {
      command: 'sh -c \'echo "$0" "$@"\' tmux -S /tmp/socket send-keys -t test "cmd"',
      autoEnter: true,
    });
    expect(result.details.status).toBe("completed");
    const output = (result.details as { aggregated?: string }).aggregated ?? "";
    // Should detect 'tmux ... send-keys' and append Enter
    expect(output).toContain("Enter");
  });
});
