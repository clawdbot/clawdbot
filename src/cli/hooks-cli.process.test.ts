// Hooks CLI process tests cover plugin-owned handles that outlive command output.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildNativeHookRelayCommand,
  registerNativeHookRelay,
  testing as nativeHookRelayTesting,
} from "../agents/harness/native-hook-relay.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
// Process startup includes TS transforms and plugin discovery, both of which can
// stall behind neighboring CI shards. Bound observable milestones, not runner speed.
const outputTimeoutMs = 45_000;
const exitAfterOutputTimeoutMs = 30_000;
const exitOnlyTimeoutMs = 60_000;

afterEach(async () => {
  nativeHookRelayTesting.clearNativeHookRelaysForTests();
  await Promise.all(Array.from(activeChildren, terminateChild));
});

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "close");
}

async function createLingeringPluginFixture(): Promise<{
  configPath: string;
  markerPath: string;
  stateDir: string;
}> {
  const root = tempDirs.make("openclaw-hooks-cli-");
  const stateDir = path.join(root, "state");
  const pluginDir = path.join(root, "linger-plugin");
  const markerPath = path.join(root, "registered");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "linger-plugin",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "linger",
      name: "Linger",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      'import fs from "node:fs";',
      "export default {",
      '  id: "linger",',
      '  name: "Linger",',
      "  register() {",
      '    fs.writeFileSync(process.env.LINGER_MARKER, "registered\\n");',
      "    setInterval(() => {}, 60_000);",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        load: { paths: [pluginDir] },
        entries: { linger: { enabled: true } },
      },
    }),
  );
  return { configPath, markerPath, stateDir };
}

async function createLingeringPreloadFixture(): Promise<{
  markerPath: string;
  preloadPath: string;
  stateDir: string;
}> {
  const root = tempDirs.make("openclaw-hooks-relay-");
  const markerPath = path.join(root, "loaded");
  const preloadPath = path.join(root, "linger.mjs");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.LINGER_MARKER, "loaded\\n");',
      "setInterval(() => {}, 60_000);",
      "",
    ].join("\n"),
  );
  return { markerPath, preloadPath, stateDir };
}

async function createTimeoutOwnershipFixture(): Promise<{
  nodeWrapperPath: string;
  pidLogPath: string;
  preloadPath: string;
  readyMarkerPath: string;
  stateDir: string;
}> {
  const root = tempDirs.make("openclaw-hooks-timeout-owner-");
  const nodeWrapperPath = path.join(root, "node-with-tsx");
  const pidLogPath = path.join(root, "pids");
  const preloadPath = path.join(root, "track-relay-pid.mjs");
  const readyMarkerPath = path.join(root, "ready");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      "fs.appendFileSync(process.env.RELAY_PID_LOG, `${process.pid}\\n`);",
      "const originalAsyncIterator = process.stdin[Symbol.asyncIterator].bind(process.stdin);",
      "process.stdin[Symbol.asyncIterator] = function () {",
      "  fs.writeFileSync(process.env.RELAY_READY_MARKER, `${process.pid}\\n`);",
      "  return originalAsyncIterator();",
      "};",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    nodeWrapperPath,
    ["#!/bin/sh", 'exec "$OPENCLAW_TEST_NODE" --import tsx "$@"', ""].join("\n"),
  );
  await fs.chmod(nodeWrapperPath, 0o755);
  return { nodeWrapperPath, pidLogPath, preloadPath, readyMarkerPath, stateDir };
}

async function readPidFile(filePath: string): Promise<number[]> {
  try {
    return (await fs.readFile(filePath, "utf8"))
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runHooksCli(params: {
  args: string[];
  completion: "exit" | "output-then-exit";
  label: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/entry.ts", ...params.args], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      NODE_ENV: undefined,
      VITEST: undefined,
      ...params.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.end(params.stdin ?? "");

  return await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    let timedOut = false;
    let outputObserved = false;
    // Silent relay success has no stream milestone. Give it an exit deadline
    // while keeping the tighter post-output deadline for leaked handles.
    const initialTimeoutMs = params.completion === "exit" ? exitOnlyTimeoutMs : outputTimeoutMs;
    let timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, initialTimeoutMs);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (params.completion === "exit" || outputObserved) {
        return;
      }
      outputObserved = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, exitAfterOutputTimeoutMs);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (timedOut) {
        const timeoutMessage =
          params.completion === "exit"
            ? `${params.label} did not exit within ${exitOnlyTimeoutMs}ms`
            : outputObserved
              ? `${params.label} did not exit within ${exitAfterOutputTimeoutMs}ms after emitting output`
              : `${params.label} did not emit output within ${outputTimeoutMs}ms`;
        reject(new Error(`${timeoutMessage}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ code, signal, stderr, stdout });
    });
  });
}

async function runHooksRelay(params: { event: "post_tool_use" | "pre_tool_use"; stdin: string }) {
  const fixture = await createLingeringPreloadFixture();
  const result = await runHooksCli({
    args: [
      "hooks",
      "relay",
      "--provider",
      "codex",
      "--relay-id",
      "missing-relay",
      "--event",
      params.event,
      "--timeout",
      "50",
    ],
    completion: params.event === "post_tool_use" ? "exit" : "output-then-exit",
    label: `hooks relay ${params.event}`,
    env: {
      LINGER_MARKER: fixture.markerPath,
      NODE_OPTIONS: `--import=${pathToFileURL(fixture.preloadPath).href}`,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: fixture.stateDir,
    },
    stdin: params.stdin,
  });
  await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("loaded\n");
  return result;
}

describe("hooks CLI process lifecycle", () => {
  it.runIf(process.platform !== "win32")(
    "keeps the relay on the timeout-owned shell PID",
    async () => {
      const fixture = await createTimeoutOwnershipFixture();
      const command = buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "timeout-owner",
        event: "post_tool_use",
        executable: path.resolve("src/entry.ts"),
        nodeExecutable: fixture.nodeWrapperPath,
        timeoutMs: 60_000,
      });
      const child = spawn("/bin/sh", ["-lc", command], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          NODE_ENV: undefined,
          VITEST: undefined,
          NODE_COMPILE_CACHE: path.join(fixture.stateDir, "node-compile-cache"),
          NODE_OPTIONS: `--import=${pathToFileURL(fixture.preloadPath).href}`,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: fixture.stateDir,
          OPENCLAW_TEST_NODE: process.execPath,
          RELAY_PID_LOG: fixture.pidLogPath,
          RELAY_READY_MARKER: fixture.readyMarkerPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      activeChildren.add(child);
      child.once("close", () => activeChildren.delete(child));
      const timeoutOwnedPid = child.pid;
      if (!timeoutOwnedPid) {
        throw new Error("Expected native hook relay shell PID");
      }

      try {
        await expect
          .poll(async () => (await readPidFile(fixture.readyMarkerPath))[0], {
            interval: 100,
            timeout: outputTimeoutMs,
          })
          .toBe(timeoutOwnedPid);
        expect(new Set(await readPidFile(fixture.pidLogPath))).toEqual(new Set([timeoutOwnedPid]));

        const closed = once(child, "close");
        expect(child.kill("SIGKILL")).toBe(true);
        await closed;
        await expect
          .poll(() => isProcessAlive(timeoutOwnedPid), { interval: 50, timeout: 5_000 })
          .toBe(false);
        await expect
          .poll(
            async () =>
              (await readPidFile(fixture.pidLogPath)).filter((pid) => isProcessAlive(pid)),
            { interval: 50, timeout: 5_000 },
          )
          .toEqual([]);
      } finally {
        await terminateChild(child);
        for (const pid of await readPidFile(fixture.pidLogPath)) {
          if (pid !== timeoutOwnedPid && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    },
    60_000,
  );

  it("uses the explicit relay database when the child has a different state directory", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "process-explicit-state-db",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    await expect
      .poll(() => nativeHookRelayTesting.getNativeHookRelayBridgeRecordForTests(relay.relayId))
      .toBeDefined();

    const childStateDir = path.join(tempDirs.make("openclaw-hooks-relay-other-state-"), "state");
    await fs.mkdir(childStateDir, { recursive: true });
    const result = await runHooksCli({
      args: [
        "hooks",
        "relay",
        "--provider",
        "codex",
        "--relay-id",
        relay.relayId,
        "--state-db",
        resolveOpenClawStateSqlitePath(),
        "--generation",
        relay.generation,
        "--event",
        "post_tool_use",
        "--timeout",
        "5000",
      ],
      completion: "exit",
      label: "hooks relay explicit state database",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: childStateDir,
      },
      stdin: JSON.stringify({ hook_event_name: "PostToolUse" }),
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  }, 90_000);

  it("exits after one-shot outputs when plugins leave ref'd handles", async () => {
    const fixture = await createLingeringPluginFixture();

    // Both command families need real process coverage. Keep their expensive CLI
    // bootstraps sequential so low-core shards test lifecycle, not startup contention.
    const listResult = await runHooksCli({
      args: ["hooks", "list", "--json"],
      completion: "output-then-exit",
      label: "hooks list",
      env: {
        LINGER_MARKER: fixture.markerPath,
        OPENCLAW_CONFIG_PATH: fixture.configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: fixture.stateDir,
      },
    });
    const relayResult = await runHooksRelay({ event: "pre_tool_use", stdin: "{}" });

    expect(listResult, listResult.stderr).toMatchObject({ code: 0, signal: null });
    expect(listResult.stderr).not.toContain("Error:");
    expect(JSON.parse(listResult.stdout)).toMatchObject({ hooks: expect.any(Array) });
    await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("registered\n");
    expect(relayResult, relayResult.stderr).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(relayResult.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.any(String),
      },
    });
  }, 150_000);
});
