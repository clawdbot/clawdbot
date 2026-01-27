import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const waitForReady = async (
  proc: ReturnType<typeof spawn>,
  chunksOut: string[],
  chunksErr: string[],
  timeoutMs: number,
) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const stdout = chunksOut.join("");
      const stderr = chunksErr.join("");
      cleanup();
      reject(
        new Error(
          `timeout waiting for gateway to start\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      proc.off("message", onMessage);
      proc.stdout?.off("data", onStdout);
    };

    const onExit = () => {
      const stdout = chunksOut.join("");
      const stderr = chunksErr.join("");
      cleanup();
      reject(
        new Error(
          `gateway exited before ready (code=${String(proc.exitCode)} signal=${String(proc.signalCode)})\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    };

    const onMessage = (msg: unknown) => {
      if (msg && typeof msg === "object" && "ready" in msg) {
        cleanup();
        resolve();
      }
    };

    const onStdout = (chunk: unknown) => {
      if (String(chunk).includes("READY")) {
        cleanup();
        resolve();
      }
    };

    proc.once("exit", onExit);
    proc.on("message", onMessage);
    proc.stdout?.on("data", onStdout);
  });
};

describe("gateway SIGTERM", () => {
  let child: ReturnType<typeof spawn> | null = null;

  afterEach(() => {
    if (!child || child.killed) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    child = null;
  });

  it("exits 0 on SIGTERM", { timeout: 180_000 }, async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-gateway-test-"));
    const out: string[] = [];
    const err: string[] = [];

    const nodeBin = process.execPath;
    const env = {
      ...process.env,
      CLAWDBOT_NO_RESPAWN: "1",
      CLAWDBOT_STATE_DIR: stateDir,
      CLAWDBOT_SKIP_CHANNELS: "1",
      CLAWDBOT_SKIP_GMAIL_WATCHER: "1",
      CLAWDBOT_SKIP_CRON: "1",
      CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER: "1",
      CLAWDBOT_SKIP_CANVAS_HOST: "1",
    };
    const bootstrapPath = path.join(stateDir, "moltbot-entry-bootstrap.mjs");
    const runLoopPath = path.resolve("src/cli/gateway-cli/run-loop.ts");
    const runtimePath = path.resolve("src/runtime.ts");
    fs.writeFileSync(
      bootstrapPath,
      [
        'import { pathToFileURL } from "node:url";',
        `const runLoopUrl = ${JSON.stringify(pathToFileURL(runLoopPath).href)};`,
        `const runtimeUrl = ${JSON.stringify(pathToFileURL(runtimePath).href)};`,
        "const { runGatewayLoop } = await import(runLoopUrl);",
        "const { defaultRuntime } = await import(runtimeUrl);",
        "await runGatewayLoop({",
        "  start: async () => {",
        '    process.stdout.write("READY\\\\n");',
        "    if (process.send) process.send({ ready: true });",
        "    const keepAlive = setInterval(() => {}, 1000);",
        "    return { close: async () => clearInterval(keepAlive) };",
        "  },",
        "  runtime: defaultRuntime,",
        "});",
      ].join("\n"),
      "utf8",
    );
    const childArgs = ["--import", "tsx", bootstrapPath];

    child = spawn(nodeBin, childArgs, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const proc = child;
    if (!proc) throw new Error("failed to spawn gateway");

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => out.push(String(d)));
    child.stderr?.on("data", (d) => err.push(String(d)));

    await waitForReady(proc, out, err, 150_000);

    proc.kill("SIGTERM");

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));

    if (result.code !== 0 && !(result.code === null && result.signal === "SIGTERM")) {
      const stdout = out.join("");
      const stderr = err.join("");
      throw new Error(
        `expected exit code 0, got code=${String(result.code)} signal=${String(result.signal)}\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }
    if (result.code === null && result.signal === "SIGTERM") return;
    expect(result.signal).toBeNull();
  });
});
