import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const CHILD_TIMEOUT_MS = 3_000;
const CLEANUP_DELAY_MS = 400;
const interruptsModuleUrl = pathToFileURL(
  path.resolve("extensions/qa-lab/src/mantis/cli-interrupts.ts"),
).href;

async function waitForMarker(readOutput: () => string, marker: string): Promise<void> {
  const deadlineAt = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadlineAt) {
    if (readOutput().includes(marker)) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`timeout waiting for child marker: ${marker}`);
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error(message)), CHILD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
}

it.skipIf(process.platform === "win32")(
  "keeps repeated SIGINT ownership until Mantis cleanup completes",
  async () => {
    const script = `
      import { writeSync } from "node:fs";
      import { runWithMantisCliInterrupts } from ${JSON.stringify(interruptsModuleUrl)};

      await runWithMantisCliInterrupts(async (signal) => {
        writeSync(1, "ready\\n");
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        writeSync(1, "cleanup-started\\n");
        await new Promise((resolve) => setTimeout(resolve, ${CLEANUP_DELAY_MS}));
        writeSync(1, "cleanup-complete\\n");
        throw signal.reason;
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: path.resolve("."),
        env: { ...process.env, VITEST: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    try {
      await waitForMarker(() => stdout, "ready\n");
      expect(child.kill("SIGINT")).toBe(true);
      await waitForMarker(() => stdout, "cleanup-started\n");
      expect(child.kill("SIGINT")).toBe(true);
      const outcome = await withTimeout(exited, "timeout waiting for Mantis signal child");
      const diagnostics = JSON.stringify({ outcome, stderr, stdout }, null, 2);

      expect(stdout, diagnostics).toContain("cleanup-complete\n");
      expect(outcome.code, diagnostics).toBe(130);
      expect(outcome.signal, diagnostics).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  },
);
