// Control Ui I18N tests cover control ui i18n script behavior.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appendBoundedProcessOutput,
  buildBatchPrompt,
  parseTranslationBatchReply,
  runProcess,
  shouldReuseExistingTranslation,
} from "../../scripts/control-ui-i18n.ts";
import { createTempDirTracker } from "../helpers/temp-dir.js";

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

async function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 2_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe("control-ui-i18n process runner", () => {
  it("rejects placeholder-corrupt batch replies before they leave the retry loop", () => {
    const items = [
      {
        cacheKey: "cache-key",
        key: "configView.viewPendingChange",
        text: "View pending change ({count})",
        textHash: "text-hash",
      },
    ];

    expect(() =>
      parseTranslationBatchReply(
        JSON.stringify({ "configView.viewPendingChange": "Pending change" }),
        items,
        "ar",
      ),
    ).toThrow("ar:configView.viewPendingChange expected {count} got {}");
    expect(
      parseTranslationBatchReply(
        JSON.stringify({ "configView.viewPendingChange": "Pending change ({count})" }),
        items,
        "ar",
      ),
    ).toEqual(new Map([["configView.viewPendingChange", "Pending change ({count})"]]));
  });

  it("feeds the exact validation failure back into a retry prompt", () => {
    const items = [
      {
        cacheKey: "cache-key",
        key: "configView.viewPendingChange",
        text: "View pending change ({count})",
        textHash: "text-hash",
      },
    ];
    const validationError = "ar:configView.viewPendingChange expected {count} got {}";

    expect(buildBatchPrompt(items, validationError)).toContain(
      `failed validation. Correct that exact failure in the new response:\n${validationError}`,
    );
  });

  it("ships no recorded English fallbacks", () => {
    const metaDir = path.resolve("ui/src/i18n/.i18n");
    const fallbacks = readdirSync(metaDir)
      .filter((fileName) => fileName.endsWith(".meta.json"))
      .flatMap((fileName) => {
        const meta = JSON.parse(readFileSync(path.join(metaDir, fileName), "utf8")) as {
          fallbackKeys?: string[];
          locale?: string;
        };
        return (meta.fallbackKeys ?? []).map((key) => `${meta.locale ?? fileName}:${key}`);
      });

    expect(fallbacks).toEqual([]);
  });

  it("refreshes recorded fallback copy when sync is forced without a provider", () => {
    expect(
      shouldReuseExistingTranslation({
        allowTranslate: false,
        force: true,
        isFallback: true,
      }),
    ).toBe(false);
    expect(
      shouldReuseExistingTranslation({
        allowTranslate: false,
        force: false,
        isFallback: true,
      }),
    ).toBe(true);
  });

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
      const tempDirs = createTempDirTracker();
      const tempDir = tempDirs.make("openclaw-control-ui-i18n-timeout-");
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
        tempDirs.cleanup();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits for all process groups before re-raising parent signals",
    async () => {
      const tempDirs = createTempDirTracker();
      const tempDir = tempDirs.make("openclaw-control-ui-i18n-signal-");
      const fastReadyPath = path.join(tempDir, "fast-ready");
      const fastCommandPath = path.join(tempDir, "fast-command.mjs");
      const commandPath = path.join(tempDir, "command.mjs");
      const runnerPath = path.join(tempDir, "runner.mjs");
      const grandchildPidPath = path.join(tempDir, "grandchild.pid");
      let grandchildPid = 0;

      try {
        const grandchildScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        writeFileSync(
          fastCommandPath,
          [
            "import { writeFileSync } from 'node:fs';",
            `writeFileSync(${JSON.stringify(fastReadyPath)}, "ready");`,
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          commandPath,
          [
            "import { spawn } from 'node:child_process';",
            "import { writeFileSync } from 'node:fs';",
            `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(
              grandchildScript,
            )}], { stdio: "ignore" });`,
            `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          runnerPath,
          [
            `const { runProcess } = await import(${JSON.stringify(
              pathToFileURL(path.resolve("scripts/control-ui-i18n.ts")).href,
            )});`,
            "void runProcess(process.execPath,",
            `  [${JSON.stringify(fastCommandPath)}],`,
            "  { killGraceMs: 100, timeoutMs: 30_000 },",
            ").catch(() => undefined);",
            "void runProcess(process.execPath,",
            `  [${JSON.stringify(commandPath)}],`,
            "  { killGraceMs: 100, timeoutMs: 30_000 },",
            ").catch(() => undefined);",
          ].join("\n"),
          "utf8",
        );

        const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
          cwd: process.cwd(),
          stdio: "ignore",
        });

        try {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            let fastReady = false;
            try {
              fastReady = readFileSync(fastReadyPath, "utf8") === "ready";
            } catch {}
            try {
              grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
            } catch {}
            if (fastReady && grandchildPid > 0 && processIsAlive(grandchildPid)) {
              break;
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 10);
            });
          }
          expect(readFileSync(fastReadyPath, "utf8")).toBe("ready");
          expect(grandchildPid).toBeGreaterThan(0);
          expect(processIsAlive(grandchildPid)).toBe(true);

          runner.kill("SIGTERM");

          await expect(waitForChildClose(runner)).resolves.toEqual({
            code: null,
            signal: "SIGTERM",
          });
          await waitForProcessExit(grandchildPid, 2_000);
        } finally {
          if (runner.pid && processIsAlive(runner.pid)) {
            runner.kill("SIGKILL");
          }
          if (grandchildPid > 0 && processIsAlive(grandchildPid)) {
            process.kill(grandchildPid, "SIGKILL");
          }
        }
      } finally {
        tempDirs.cleanup();
      }
    },
  );
});
