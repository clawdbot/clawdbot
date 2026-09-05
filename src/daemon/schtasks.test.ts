// Windows schtasks tests cover scheduled task service lifecycle behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import {
  isScheduledTaskDefinitelyNotRunning,
  probeScheduledTaskExists,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import {
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  resolveTaskScriptPath,
} from "./schtasks.js";

const schtasksResponses = vi.hoisted(
  (): Array<{ code: number; stdout: string; stderr: string }> => [],
);
const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));
const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync,
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async () => schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" },
}));

vi.mock("./gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));

vi.mock("../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/windows-encoding.js")>(
    "../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => resolveWindowsOemEncodingMock(),
  };
});

beforeEach(() => {
  schtasksResponses.length = 0;
  spawnSync.mockReset();
  resolveWindowsOemEncodingMock.mockReset();
  resolveWindowsOemEncodingMock.mockReturnValue(null);
});

describe("scheduled task runtime derivation", () => {
  async function readRuntimeFromQueryOutput(output: string) {
    schtasksResponses.push(
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: output, stderr: "" },
    );
    return await readScheduledTaskRuntime({
      USERPROFILE: "C:\\Users\\test",
      OPENCLAW_PROFILE: "default",
    });
  }

  it.each([
    { state: 3, result: 0, expected: "stopped", label: "Bereit" },
    { state: 4, result: 0, expected: "running", label: "Wird ausgeführt" },
    { state: 2, result: 0, expected: "unknown", label: "In Warteschlange" },
    { state: 0, result: 0, expected: "unknown", label: "Unbekannt" },
  ])("uses numeric task state $state on a fully localized Windows host", async (task) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        state: task.state,
        lastRunResult: task.result,
        lastRunTime: "2026-08-02T12:00:00.0000000Z",
      }),
      stderr: "",
    });
    const runtime = await readRuntimeFromQueryOutput(
      [
        "Aufgabenname: \\OpenClaw Gateway",
        `Status: ${task.label}`,
        "Letzte Laufzeit: 02.08.2026 14:00:00",
        "Letztes Ergebnis: 0",
      ].join("\r\n"),
    );
    expect(runtime.status).toBe(task.expected);
  });

  it.each([
    { state: 1, result: 267009, expected: "stopped", name: "Disabled" },
    { state: 3, result: 267009, expected: "stopped", name: "Ready" },
    { state: 4, result: -2147024891, expected: "running", name: "Running" },
    { state: 2, result: 0, expected: "unknown", name: "Queued" },
    { state: 0, result: 267009, expected: "unknown", name: "Unknown" },
  ])("uses $name rather than stale last-run result $result", async (task) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ state: task.state, lastRunResult: task.result }),
    });
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: task.expected,
      state: task.name,
      lastRunResult: String(task.result),
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
    expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(
      task.expected === "stopped",
    );
  });

  it.each([
    { state: 3 },
    { state: 3, lastRunResult: null, lastRunTime: null },
    { state: 3, lastRunResult: "unavailable", lastRunTime: false },
  ])("preserves task state and existence without optional history: %j", async (snapshot) => {
    spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(snapshot) });
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: "stopped",
      state: "Ready",
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
    expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(true);
  });

  it.each([null, "3", 5])(
    "preserves existence but not offline proof for state %j",
    async (state) => {
      spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify({ state }) });
      await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({ status: "unknown" });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
    },
  );

  it.each(["-2147024894", "-2147024893"])(
    "recognizes lookup HRESULT %s as missing",
    async (stdout) => {
      spawnSync.mockReturnValue({ status: 1, stdout });
      await expect(readRuntimeFromQueryOutput("")).resolves.toEqual({
        status: "stopped",
        missingUnit: true,
      });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(false);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
    },
  );

  it.each([
    { name: "access denied", status: 1, stdout: "-2147024891" },
    { name: "COM activation missing", status: 2, stdout: "-2147221164" },
    { name: "connection missing file", status: 2, stdout: "-2147024894" },
    { name: "malformed HRESULT", status: 1, stdout: "-2147024894 trailing" },
    { name: "invalid JSON", status: 0, stdout: "not JSON" },
    { name: "non-object JSON", status: 0, stdout: "null" },
    { name: "spawn failure", status: null, stdout: "", error: new Error("ENOENT") },
    { name: "timeout", status: null, stdout: "", error: new Error("ETIMEDOUT") },
  ])("keeps $name unavailable, not missing or stopped", async (response) => {
    spawnSync.mockReturnValue(response);
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: "unknown",
      missingUnit: false,
      inspectionFailure: { code: "service-runtime-inspection-failed" },
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBeNull();
  });

  it("requires current Scheduler running state before retiring the Startup owner", async () => {
    spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ state: 3, lastRunResult: 267009 }),
      })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ state: 4, lastRunResult: 0 }) });
    await expect(waitForScheduledTaskRunningEvidence({})).resolves.toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});

describe("resolveTaskScriptPath", () => {
  it.each([
    {
      name: "uses default path when OPENCLAW_PROFILE is unset",
      env: { USERPROFILE: "C:\\Users\\test" },
      expected: path.join("C:\\Users\\test", ".openclaw", "gateway.cmd"),
    },
    {
      name: "uses profile-specific path when OPENCLAW_PROFILE is set to a custom value",
      env: { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "jbphoenix" },
      expected: path.join("C:\\Users\\test", ".openclaw-jbphoenix", "gateway.cmd"),
    },
    {
      name: "prefers OPENCLAW_STATE_DIR over profile-derived defaults",
      env: {
        USERPROFILE: "C:\\Users\\test",
        OPENCLAW_PROFILE: "rescue",
        OPENCLAW_STATE_DIR: "C:\\State\\openclaw",
      },
      expected: path.join("C:\\State\\openclaw", "gateway.cmd"),
    },
    {
      name: "falls back to HOME when USERPROFILE is not set",
      env: { HOME: "/home/test", OPENCLAW_PROFILE: "default" },
      expected: path.join("/home/test", ".openclaw", "gateway.cmd"),
    },
    {
      name: "uses a custom task script file name inside the state directory",
      env: {
        USERPROFILE: "C:\\Users\\test",
        OPENCLAW_TASK_SCRIPT_NAME: "gateway-node.cmd",
      },
      expected: path.join("C:\\Users\\test", ".openclaw", "gateway-node.cmd"),
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveTaskScriptPath(env)).toBe(expected);
  });

  it.each([
    "../gateway.cmd",
    "..\\gateway.cmd",
    "nested/gateway.cmd",
    "nested\\gateway.cmd",
    "gateway..cmd",
  ])("rejects non-file task script name %s", (scriptName) => {
    expect(() =>
      resolveTaskScriptPath({
        USERPROFILE: "C:\\Users\\test",
        OPENCLAW_TASK_SCRIPT_NAME: scriptName,
      }),
    ).toThrow("OPENCLAW_TASK_SCRIPT_NAME must be a file name only");
  });
});

describe("readScheduledTaskCommand", () => {
  async function withScheduledTaskScript(
    options: {
      scriptLines?: string[];
      scriptEncoding?: "utf8" | "gbk";
      env?:
        | Record<string, string | undefined>
        | ((tmpDir: string) => Record<string, string | undefined>);
    },
    run: (env: Record<string, string | undefined>) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const extraEnv = typeof options.env === "function" ? options.env(tmpDir) : options.env;
      const env = {
        USERPROFILE: tmpDir,
        OPENCLAW_PROFILE: "default",
        ...extraEnv,
      };
      if (options.scriptLines) {
        const scriptPath = resolveTaskScriptPath(env);
        const script = options.scriptLines.join("\r\n");
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        let scriptBytes: Buffer = Buffer.from(script, "utf8");
        if (options.scriptEncoding === "gbk") {
          // Production bytes for a code-page install: marker line + GBK body.
          resolveWindowsOemEncodingMock.mockReturnValueOnce("gbk");
          scriptBytes = encodeWindowsLauncherScript({ format: "cmd", content: script });
        }
        await fs.writeFile(scriptPath, scriptBytes);
      }
      await run(env);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("parses script with quoted arguments containing spaces", async () => {
    await withScheduledTaskScript(
      {
        // Use forward slashes which work in Windows cmd and avoid escape parsing issues.
        scriptLines: ["@echo off", '"C:/Program Files/Node/node.exe" gateway.js'],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["C:/Program Files/Node/node.exe", "gateway.js"],
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("reads legacy UTF-8 scripts with CJK paths written before the encoding fix", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: ["@echo off", 'cd /d "C:\\Users\\苗振\\.openclaw"', "node gateway.js"],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js"],
          workingDirectory: "C:\\Users\\苗振\\.openclaw",
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("reads marked ANSI scripts with CJK paths under a CJK code page (#107416)", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: ["@echo off", 'cd /d "C:\\Users\\苗振\\.openclaw"', "node gateway.js"],
        scriptEncoding: "gbk",
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js"],
          workingDirectory: "C:\\Users\\苗振\\.openclaw",
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("reads back GBK launchers whose bytes are also valid UTF-8 (隆) without corruption", async () => {
    // GBK "隆" is C2 A1, which UTF-8 accepts as "¡"; the marker keeps readback
    // from sniffing these bytes as UTF-8 and parsing a corrupted path.
    await withScheduledTaskScript(
      {
        scriptLines: ["@echo off", 'cd /d "C:\\Users\\隆\\.openclaw"', "node gateway.js"],
        scriptEncoding: "gbk",
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js"],
          workingDirectory: "C:\\Users\\隆\\.openclaw",
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("returns null when script does not exist", async () => {
    await withScheduledTaskScript({}, async (env) => {
      const result = await readScheduledTaskCommand(env);
      expect(result).toBeNull();
    });
  });

  it("returns null when script has no command", async () => {
    await withScheduledTaskScript(
      { scriptLines: ["@echo off", "rem This is just a comment"] },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toBeNull();
      },
    );
  });

  it("parses full script with all components", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          "rem OpenClaw Gateway",
          "cd /d C:\\Projects\\openclaw",
          "set NODE_ENV=production",
          "set OPENCLAW_PORT=18789",
          "node gateway.js --verbose",
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js", "--verbose"],
          workingDirectory: "C:\\Projects\\openclaw",
          environment: {
            NODE_ENV: "production",
            OPENCLAW_PORT: "18789",
          },
          environmentValueSources: {
            NODE_ENV: "inline",
            OPENCLAW_PORT: "inline",
          },
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("parses command with Windows backslash paths", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js gateway --port 18789',
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("preserves UNC paths in command arguments", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          '"\\\\fileserver\\OpenClaw Share\\node.exe" "\\\\fileserver\\OpenClaw Share\\dist\\index.js" gateway --port 18789',
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: [
            "\\\\fileserver\\OpenClaw Share\\node.exe",
            "\\\\fileserver\\OpenClaw Share\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("reads script from OPENCLAW_STATE_DIR override", async () => {
    await withScheduledTaskScript(
      {
        env: (tmpDir) => ({ OPENCLAW_STATE_DIR: path.join(tmpDir, "custom-state") }),
        scriptLines: ["@echo off", "node gateway.js --from-state-dir"],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js", "--from-state-dir"],
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("parses quoted set assignments with escaped metacharacters", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          'set "OC_AMP=left & right"',
          'set "OC_PIPE=a | b"',
          'set "OC_CARET=^^"',
          'set "OC_PERCENT=%%TEMP%%"',
          'set "OC_BANG=^!token^!"',
          'set "OC_QUOTE=he said ^"hi^""',
          "node gateway.js --verbose",
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result?.environment).toEqual({
          OC_AMP: "left & right",
          OC_PIPE: "a | b",
          OC_CARET: "^",
          OC_PERCENT: "%TEMP%",
          OC_BANG: "!token!",
          OC_QUOTE: 'he said "hi"',
        });
      },
    );
  });
});
