import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveScheduledTaskRuntimeStatus,
  parseSchtasksQuery,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
} from "./schtasks.js";

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
  it("treats Running + 0x41301 as running", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Running",
        lastRunResult: "0x41301",
      }),
    ).toEqual({ status: "running" });
  });

  it("treats Running + decimal 267009 as running", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Running",
        lastRunResult: "267009",
      }),
    ).toEqual({ status: "running" });
  });

  it("treats Running without numeric result as unknown", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Running",
      }),
    ).toEqual({
      status: "unknown",
      detail: "Task status is locale-dependent and no numeric Last Run Result was available.",
    });
  });

  it("treats non-running result codes as stopped", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Running",
        lastRunResult: "0x0",
      }),
    ).toEqual({
      status: "stopped",
      detail: "Task Last Run Result=0x0; treating as not running.",
    });
  });

  it("detects running via result code when status is localized (German)", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Wird ausgeführt",
        lastRunResult: "0x41301",
      }),
    ).toEqual({ status: "running" });
  });

  it("detects running via result code when status is localized (French)", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "En cours",
        lastRunResult: "267009",
      }),
    ).toEqual({ status: "running" });
  });

  it("treats localized status as stopped when result code is not a running code", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Wird ausgeführt",
        lastRunResult: "0x0",
      }),
    ).toEqual({
      status: "stopped",
      detail: "Task Last Run Result=0x0; treating as not running.",
    });
  });

  it("treats localized status without result code as unknown", () => {
    expect(
      deriveScheduledTaskRuntimeStatus({
        status: "Wird ausgeführt",
      }),
    ).toEqual({
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
  ])("$name", ({ env, expected }) => {
    expect(resolveTaskScriptPath(env)).toBe(expected);
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
