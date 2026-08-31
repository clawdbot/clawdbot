import { describe, expect, it } from "vitest";
import { SESSION_PERMISSION_BY_EXEC_MODE } from "./session-permission-exec-mode.js";

describe("session permission modes for exec policies", () => {
  it.each([
    ["deny", "read-only"],
    ["allowlist", "guarded"],
    ["ask", "guarded"],
    ["auto", "workspace"],
    ["full", "full"],
  ] as const)("maps %s to %s", (execMode, permissionMode) => {
    expect(SESSION_PERMISSION_BY_EXEC_MODE[execMode]).toBe(permissionMode);
  });
});
