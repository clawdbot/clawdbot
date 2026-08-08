import { describe, expect, it } from "vitest";
import { buildExecAutoReviewInputForShellCommand } from "./agent-harness-exec-review-runtime.js";

describe("agent harness exec auto-review input", () => {
  it.runIf(process.platform !== "win32").each(["bash", "sh", "/bin/sh"])(
    "does not bind %s login-shell startup as a reviewable command",
    async (shell) => {
      await expect(
        buildExecAutoReviewInputForShellCommand({
          command: `${shell} -lc "echo auto-review-startup-proof"`,
          cwd: process.cwd(),
          host: "codex-app-server",
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("preserves ordinary single-command auto-review input", async () => {
    await expect(
      buildExecAutoReviewInputForShellCommand({
        command: "node --version",
        cwd: process.cwd(),
        host: "codex-app-server",
      }),
    ).resolves.toMatchObject({
      command: "node --version",
      argv: ["node", "--version"],
      host: "codex-app-server",
      reason: "approval-required",
    });
  });
});
