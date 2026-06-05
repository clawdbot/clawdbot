// Control Ui I18N tests cover control ui i18n script behavior.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { appendBoundedProcessOutput, runProcess } from "../../scripts/control-ui-i18n.ts";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`process ${pid} was still alive after ${timeoutMs}ms`);
}

describe("control-ui-i18n process runner", () => {
  it("keeps a bounded process output tail", () => {
    const first = appendBoundedProcessOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    const second = appendBoundedProcessOutput(first, "ghij", 5);

    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
  });

  it("bounds failure diagnostics to the newest output", async () => {
    await expect(
      runProcess(
        process.execPath,
        [
          "-e",
          [
            "process.stderr.write('stderr-begin-' + 'x'.repeat(128) + '-stderr-end', () => process.exit(2));",
          ].join(" "),
        ],
        { maxOutputChars: 64, rejectOnFailure: true },
      ),
    ).rejects.toThrow(/output truncated[\s\S]*stderr-end/u);
  });

  it("rejects successful commands before returning truncated stdout", async () => {
    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(128), () => process.exit(0));"],
        {
          maxOutputChars: 12,
        },
      ),
    ).rejects.toThrow("produced more than 12 stdout chars");
  });

  it.runIf(process.platform !== "win32")(
    "kills descendant processes after the process timeout",
    async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-control-ui-i18n-timeout-"));
      try {
        const markerPath = path.join(tempDir, "grandchild.pid");
        const grandchildScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
          `writeFileSync(${JSON.stringify(markerPath)}, String(grandchild.pid));`,
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");

        await expect(
          runProcess(process.execPath, ["-e", parentScript], {
            cwd: tempDir,
            killGraceMs: 25,
            timeoutMs: 500,
          }),
        ).rejects.toThrow(`timed out after 500ms`);

        const grandchildPid = Number(readFileSync(markerPath, "utf8"));
        await waitForProcessExit(grandchildPid);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );
});
