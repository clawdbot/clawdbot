import { afterEach, expect, test } from "vitest";

import { createExecTool } from "./bash-tools.exec";
import { resetProcessRegistryForTests } from "./bash-process-registry";

afterEach(() => {
  resetProcessRegistryForTests();
});

test("exec supports pty output", async () => {
  const tool = createExecTool({ allowBackground: false });
  const result = await tool.execute("toolcall", {
    command: 'node -e "process.stdout.write(String.fromCharCode(111,107))"',
    pty: true,
  });

  expect(result.details.status).toBe("completed");
  const text = result.content?.[0]?.text ?? "";
  expect(text).toContain("ok");
});

test("exec uses pty when defaults.pty is true", async () => {
  const tool = createExecTool({ allowBackground: false, pty: true });
  // Note: pty is NOT passed in params - should use default
  const result = await tool.execute("toolcall", {
    command: 'node -e "process.stdout.write(String.fromCharCode(111,107))"',
  });

  expect(result.details.status).toBe("completed");
  const text = result.content?.[0]?.text ?? "";
  expect(text).toContain("ok");
});

test("exec params.pty overrides defaults.pty", async () => {
  const tool = createExecTool({ allowBackground: false, pty: true });
  // Explicitly set pty: false to override default
  const result = await tool.execute("toolcall", {
    command: "echo override",
    pty: false,
  });

  expect(result.details.status).toBe("completed");
  const text = result.content?.[0]?.text ?? "";
  expect(text).toContain("override");
});
