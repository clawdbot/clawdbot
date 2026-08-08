// Process coverage for `openclaw mcp call` stdout integrity on a nonzero exit.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
// A pipe holds ~64KB in the kernel; anything past that lives in the writer's
// userspace queue, which a synchronous process.exit() would drop.
const LARGE_TOOL_RESULT_BYTES = 1024 * 1024;
// The child cannot finish draining until this side reads. Hold the read side
// closed long enough that a synchronous exit would already have happened.
const DRAIN_HOLD_MS = 500;
const OUTPUT_TIMEOUT_MS = 60_000;
const EXIT_AFTER_OUTPUT_TIMEOUT_MS = 30_000;

afterEach(async () => {
  await Promise.all(Array.from(activeChildren, terminateChild));
});

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "close");
}

async function createLargeResultFixture(): Promise<{
  configPath: string;
  home: string;
  stateDir: string;
  payload: string;
}> {
  const root = tempDirs.make("openclaw-mcp-call-exit-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const serverPath = path.join(root, "large-result-server.mjs");
  await fs.mkdir(stateDir, { recursive: true });
  const payload = "x".repeat(LARGE_TOOL_RESULT_BYTES);
  await fs.writeFile(
    serverPath,
    `const PAYLOAD = "x".repeat(${LARGE_TOOL_RESULT_BYTES});
let buffer = "";
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "cli-call-large-result", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "bulk", inputSchema: { type: "object" } }] },
    });
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { isError: true, content: [{ type: "text", text: PAYLOAD }] },
    });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
    "utf8",
  );
  await fs.writeFile(
    configPath,
    JSON.stringify({
      mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } },
    }),
  );
  return { configPath, home: root, stateDir, payload };
}

async function runMcpCallWithHeldStdout(fixture: {
  configPath: string;
  home: string;
  stateDir: string;
}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    OPENCLAW_CONFIG_PATH: fixture.configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: fixture.stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
  // The child must take the real one-shot exit path, not the in-worker bail.
  delete env.NODE_ENV;
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/entry.ts", "mcp", "call", "docs", "bulk"],
    { cwd: path.resolve("."), env, stdio: ["pipe", "pipe", "pipe"] },
  );
  activeChildren.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.end("");
  // Keep stdout paused until output is pending, so the kernel pipe fills and the
  // rest stays queued inside the child while it decides how to exit.
  child.stdout.pause();

  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      let timedOut = false;
      let timeoutMessage = `mcp call did not emit output within ${OUTPUT_TIMEOUT_MS}ms`;
      let timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, OUTPUT_TIMEOUT_MS);
      child.stdout.once("readable", () => {
        clearTimeout(timer);
        timeoutMessage = `mcp call did not exit within ${EXIT_AFTER_OUTPUT_TIMEOUT_MS}ms after emitting output`;
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, EXIT_AFTER_OUTPUT_TIMEOUT_MS);
        setTimeout(() => {
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stdout.resume();
        }, DRAIN_HOLD_MS);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        activeChildren.delete(child);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        activeChildren.delete(child);
        if (timedOut) {
          reject(
            new Error(`${timeoutMessage}\nstdout bytes: ${stdout.length}\nstderr:\n${stderr}`),
          );
          return;
        }
        resolve({ code, stdout, stderr });
      });
    },
  );
}

describe("mcp call process exit", () => {
  it(
    "writes the whole tool result before exiting nonzero on isError",
    async () => {
      const fixture = await createLargeResultFixture();
      const result = await runMcpCallWithHeldStdout(fixture);

      expect(result.stderr).toContain(`MCP tool "bulk" on server "docs" returned isError=true.`);
      // Truncated JSON would fail to parse here, which is the regression.
      const parsed = JSON.parse(result.stdout) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      expect(parsed.isError).toBe(true);
      expect(parsed.content?.[0]?.text).toBe(fixture.payload);
      expect(result.code).toBe(1);
    },
    OUTPUT_TIMEOUT_MS + EXIT_AFTER_OUTPUT_TIMEOUT_MS + 15_000,
  );
});
