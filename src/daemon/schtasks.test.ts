import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseSchtasksQuery,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  resolveTaskScriptPath,
} from "./schtasks.js";

const schtasksResponses = vi.hoisted(
  (): Array<{ code: number; stdout: string; stderr: string }> => [],
);

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async () => schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" },
}));

beforeEach(() => {
  schtasksResponses.length = 0;
});

describe("schtasks runtime parsing", () => {
  it.each(["Ready", "Running"])("parses %s status", (status) => {
    const output = [
      "TaskName: \\OpenClaw Gateway",
      `Status: ${status}`,
      "Last Run Time: 1/8/2026 1:23:45 AM",
      "Last Run Result: 0x0",
    ].join("\r\n");
    expect(parseSchtasksQuery(output)).toEqual({
      status,
      lastRunTime: "1/8/2026 1:23:45 AM",
      lastRunResult: "0x0",
    });
  });

  it("parses 'Last Result' key variant (without 'Run') (#47726)", () => {
    const output = [
      "TaskName: \\OpenClaw Gateway",
      "Status: Running",
      "Last Run Time: 2026/3/16 8:34:15",
      "Last Result: 267009",
    ].join("\r\n");
    expect(parseSchtasksQuery(output)).toEqual({
      status: "Running",
      lastRunTime: "2026/3/16 8:34:15",
      lastRunResult: "267009",
    });
  });
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

  function taskQueryOutput(lines: string[]): string {
    return [
      "TaskName: \\OpenClaw Gateway",
      "Last Run Time: 1/8/2026 1:23:45 AM",
      ...lines,
      "",
    ].join("\r\n");
  }

  it("treats Running + 0x41301 as running", async () => {
    await expect(
      readRuntimeFromQueryOutput(taskQueryOutput(["Status: Running", "Last Run Result: 0x41301"])),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("treats Running + decimal 267009 as running", async () => {
    await expect(
      readRuntimeFromQueryOutput(taskQueryOutput(["Status: Running", "Last Run Result: 267009"])),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("treats Running without numeric result as unknown", async () => {
    await expect(
      readRuntimeFromQueryOutput(taskQueryOutput(["Status: Running"])),
    ).resolves.toMatchObject({
      status: "unknown",
      detail: "Task status is locale-dependent and no numeric Last Run Result was available.",
    });
  });

  it("treats non-running result codes as stopped", async () => {
    await expect(
      readRuntimeFromQueryOutput(taskQueryOutput(["Status: Running", "Last Run Result: 0x0"])),
    ).resolves.toMatchObject({
      status: "stopped",
      detail: "Task Last Run Result=0x0; treating as not running.",
    });
  });

  it("detects running via result code when status is localized (German)", async () => {
    await expect(
      readRuntimeFromQueryOutput(
        taskQueryOutput(["Status: Wird ausgeführt", "Last Run Result: 0x41301"]),
      ),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("detects running via result code when status is localized (French)", async () => {
    await expect(
      readRuntimeFromQueryOutput(taskQueryOutput(["Status: En cours", "Last Run Result: 267009"])),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("treats localized status as stopped when result code is not a running code", async () => {
    await expect(
      readRuntimeFromQueryOutput(
        taskQueryOutput(["Status: Wird ausgeführt", "Last Run Result: 0x0"]),
      ),
    ).resolves.toMatchObject({
      status: "stopped",
      detail: "Task Last Run Result=0x0; treating as not running.",
    });
  });

  it("treats localized status without result code as unknown", async () => {
    await expect(
      readRuntimeFromQueryOutput(taskQueryOutput(["Status: Wird ausgeführt"])),
    ).resolves.toMatchObject({
      status: "unknown",
      detail: "Task status is locale-dependent and no numeric Last Run Result was available.",
    });
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
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        await fs.writeFile(scriptPath, options.scriptLines.join("\r\n"), "utf8");
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
