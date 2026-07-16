// Hooks CLI process tests cover plugin-owned handles that outlive command output.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const outputTimeoutMs = 20_000;
const exitAfterOutputTimeoutMs = 5_000;

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

async function runHooksCli(params: {
  args: string[];
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
    let timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, outputTimeoutMs);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (outputObserved) {
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
        const timeoutMessage = outputObserved
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
    label: `hooks relay ${params.event}`,
    env: {
      LINGER_MARKER: fixture.markerPath,
      NODE_OPTIONS: `--import=${pathToFileURL(fixture.preloadPath).href}`,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: fixture.stateDir,
    },
    stdin: params.stdin,
  });
  await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("loaded\n");
  return result;
}

describe("hooks CLI process lifecycle", () => {
  it("exits after one-shot outputs when plugins leave ref'd handles", async () => {
    const fixture = await createLingeringPluginFixture();

    // Both command families need real process coverage. Keep their expensive CLI
    // bootstraps sequential so low-core shards test lifecycle, not startup contention.
    const listResult = await runHooksCli({
      args: ["hooks", "list", "--json"],
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
  }, 60_000);
});
