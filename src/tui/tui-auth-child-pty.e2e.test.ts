import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../utils/sleep.js";
import {
  disposeActiveTuiFixtures,
  startTuiFixture,
} from "./tui-pty-harness-fixture-test-support.js";

const STARTUP_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 4_000;
const tempDirs: string[] = [];

async function createCodexFixture(exitMs?: number, exitCode = 0) {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-auth-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "codex-fixture.cjs");
  await writeFile(
    scriptPath,
    [
      'console.log("AUTH_CHILD_STARTED:" + process.pid);',
      exitMs === undefined
        ? "setInterval(() => {}, 1000);"
        : `setTimeout(() => process.exit(${String(exitCode)}), ${String(exitMs)});`,
    ].join("\n"),
    "utf8",
  );
  if (process.platform === "win32") {
    await writeFile(
      path.join(dir, "codex.cmd"),
      `@"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8",
    );
  } else {
    const launcherPath = path.join(dir, "codex");
    await writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    await chmod(launcherPath, 0o755);
  }
  return {
    pathEnv: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(10);
  }
  throw new Error(`auth child ${String(pid)} remained alive`);
}

describe("TUI auth child lifecycle", { concurrent: false }, () => {
  afterEach(async () => {
    await disposeActiveTuiFixtures();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "terminates the foreground auth child when SIGTERM exits the TUI",
    async () => {
      const auth = await createCodexFixture();
      const fixture = await startTuiFixture({
        env: {
          PATH: auth.pathEnv,
        },
      });
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      await fixture.run.write("/auth openai\r", { delay: false });
      await fixture.run.waitForOutput("AUTH_CHILD_STARTED:", STARTUP_TIMEOUT_MS);
      const pidMatch = fixture.run.visibleOutput().match(/AUTH_CHILD_STARTED:(\d+)/u);
      expect(pidMatch).not.toBeNull();
      const authPid = Number(pidMatch?.[1]);

      process.kill(fixture.run.pid, "SIGTERM");

      await expect(fixture.run.waitForExit(EXIT_TIMEOUT_MS)).resolves.toBeDefined();
      await expect(waitForProcessExit(authPid, 750)).resolves.toBeUndefined();
    },
    STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS,
  );

  it(
    "resumes the TUI after normal auth completion",
    async () => {
      const auth = await createCodexFixture(50);
      const fixture = await startTuiFixture({
        env: {
          PATH: auth.pathEnv,
        },
      });
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      await fixture.run.write("/auth openai\r", { delay: false });
      await fixture.run.waitForOutput("auth flow finished for openai", STARTUP_TIMEOUT_MS);
      await fixture.run.write("/gateway-status\r", { delay: false });
      await fixture.run.waitForOutput("fixture gateway ok", STARTUP_TIMEOUT_MS);
    },
    STARTUP_TIMEOUT_MS * 2,
  );

  it(
    "keeps a failed auth command visible after the TUI resumes",
    async () => {
      const auth = await createCodexFixture(50, 1);
      const fixture = await startTuiFixture({
        env: {
          PATH: auth.pathEnv,
        },
      });
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      await fixture.run.write("/auth openai\r", { delay: false });
      await fixture.run.waitForOutput("auth flow failed (exit 1)", STARTUP_TIMEOUT_MS);
      await fixture.run.waitForOutput(
        "in a regular terminal to see its output",
        STARTUP_TIMEOUT_MS,
      );
    },
    STARTUP_TIMEOUT_MS * 2,
  );
});
