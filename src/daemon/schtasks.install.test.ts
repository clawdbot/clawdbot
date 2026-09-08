// Windows schtasks install tests cover scheduled task installation behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import {
  installScheduledTask,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
  stageScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import { auditGatewayServiceConfig, SERVICE_AUDIT_CODES } from "./service-audit.js";
import { buildServiceEnvironment } from "./service-env.js";

// Install tests control registration separately; runtime probes never inspect host tasks.
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '{"state":4}', stderr: "" })),
}));

const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));

// Pin code page detection so launcher encoding never depends on the host ACP.
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

const schtasksCalls: string[][] = [];
const schtasksResponses: { code: number; stdout: string; stderr: string }[] = [];
// Captures the XML payload at /Create /XML time before the production code's
// `finally` block deletes the temp file. Indexed by the position in
// `schtasksCalls` so individual tests can pin which create-call they assert on.
const xmlPayloadCaptures: Array<{ index: number; xml: string }> = [];

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    const index = schtasksCalls.length;
    schtasksCalls.push(argv);
    const xmlFlagPos = argv.indexOf("/XML");
    if (xmlFlagPos !== -1) {
      const xmlPath = argv[xmlFlagPos + 1];
      if (typeof xmlPath === "string") {
        try {
          const raw = await fs.readFile(xmlPath);
          // Strip the UTF-16 LE BOM and decode for readable assertions.
          xmlPayloadCaptures.push({ index, xml: raw.slice(2).toString("utf16le") });
        } catch {
          // Mock cannot block production cleanup; tests assert via captured payloads.
        }
      }
    }
    return schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" };
  },
}));

beforeEach(() => {
  schtasksCalls.length = 0;
  schtasksResponses.length = 0;
  xmlPayloadCaptures.length = 0;
  resolveWindowsOemEncodingMock.mockReset();
  resolveWindowsOemEncodingMock.mockReturnValue(null);
});

describe("installScheduledTask", () => {
  const okSchtasksResponse = { code: 0, stdout: "", stderr: "" };
  const accessDeniedResponse = { code: 1, stdout: "", stderr: "ERROR: Access is denied." };
  const missingTaskResponse = {
    code: 1,
    stdout: "",
    stderr: "ERROR: The system cannot find the file specified.",
  };

  async function withUserProfileDir(
    run: (tmpDir: string, env: Record<string, string>) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-install-"));
    const env = {
      USERPROFILE: tmpDir,
      OPENCLAW_PROFILE: "default",
    };
    try {
      await run(tmpDir, env);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  function installDefaultGatewayTask(env: Record<string, string>) {
    return installScheduledTask({
      env,
      stdout: new PassThrough(),
      programArguments: ["node", "gateway.js"],
      environment: {},
    });
  }

  function expectInitialTaskQuery(taskName = "OpenClaw Gateway"): void {
    expect(schtasksCalls[0]).toEqual(["/Query", "/TN", taskName]);
  }

  function expectTaskRunCall(index: number, taskName = "OpenClaw Gateway"): void {
    expect(schtasksCalls[index]).toEqual(["/Run", "/TN", taskName]);
  }

  it.each(["install", "stage"])(
    "%s redirects stdin from NUL so a hidden service console is never interactive (#112173)",
    async (mode) => {
      await withUserProfileDir(async (_tmpDir, env) => {
        const writeTask = mode === "stage" ? stageScheduledTask : installScheduledTask;
        const { scriptPath } = await writeTask({
          env,
          stdout: new PassThrough(),
          programArguments: ["node", "gateway.js"],
          environment: {},
        });
        if (mode === "stage") {
          expect(schtasksCalls).toEqual([]);
        }
        const script = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
        expect(script).toContain("node gateway.js < NUL");

        const parsed = await readScheduledTaskCommand(env);
        expect(parsed).toStrictEqual({
          programArguments: ["node", "gateway.js"],
          sourcePath: scriptPath,
        });
      });
    },
  );

  it("routes generated Gateway tasks through the private Job Object supervisor", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const { scriptPath } = await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: ["node", "gateway.js"],
        environment: { OPENCLAW_SERVICE_KIND: "gateway" },
      });

      const script = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
      expect(script).toContain("node gateway.js --task-supervisor < NUL");
      await expect(readScheduledTaskCommand(env)).resolves.toMatchObject({
        programArguments: ["node", "gateway.js"],
      });
    });
  });

  it("writes version-free gateway and node descriptions", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const gateway = await installDefaultGatewayTask(env);
      const gatewayScript = decodeWindowsLauncherScript({
        buffer: await fs.readFile(gateway.scriptPath),
      });
      expect(gatewayScript).toContain("rem OpenClaw Gateway");
      expect(gatewayScript).not.toContain("OPENCLAW_SERVICE_VERSION");
      expect(xmlPayloadCaptures.at(-1)?.xml).toContain(
        "<Description>OpenClaw Gateway</Description>",
      );

      const node = await installScheduledTask({
        env: {
          ...env,
          OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
          OPENCLAW_TASK_SCRIPT_NAME: "node.cmd",
        },
        stdout: new PassThrough(),
        programArguments: ["node", "node-host.js"],
        description: "OpenClaw Node Host",
        environment: {},
      });
      const nodeScript = decodeWindowsLauncherScript({
        buffer: await fs.readFile(node.scriptPath),
      });
      expect(nodeScript).toContain("rem OpenClaw Node Host");
      expect(nodeScript).not.toContain("OPENCLAW_SERVICE_VERSION");
      expect(xmlPayloadCaptures.at(-1)?.xml).toContain(
        "<Description>OpenClaw Node Host</Description>",
      );
    });
  });

  it("writes quoted set assignments and escapes metacharacters", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const { scriptPath } = await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: [
          "node",
          "gateway.js",
          "--display-name",
          "safe&whoami",
          "--percent",
          "%TEMP%",
          "--bang",
          "!token!",
        ],
        workingDirectory: "C:\\temp\\poc&calc",
        environment: {
          OC_INJECT: "safe & whoami | calc",
          OC_CARET: "a^b",
          OC_PERCENT: "%TEMP%",
          OC_BANG: "!token!",
          OC_SOURCE_PATH: "C:\\OpenClaw source & ^ %USERPROFILE%!",
          OC_QUOTE: 'he said "hi"',
          OC_EMPTY: "",
          NODE_OPTIONS: "",
        },
      });

      const script = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
      expect(script).toContain('cd /d "C:\\temp\\poc&calc"');
      expect(script).toContain(
        'node gateway.js --display-name "safe&whoami" --percent "%%TEMP%%" --bang "^!token^!"',
      );
      expect(script).toContain('set "OC_INJECT=safe & whoami | calc"');
      expect(script).toContain('set "OC_CARET=a^^b"');
      expect(script).toContain('set "OC_PERCENT=%%TEMP%%"');
      expect(script).toContain('set "OC_BANG=^!token^!"');
      expect(script).toContain('set "OC_SOURCE_PATH=C:\\OpenClaw source & ^^ %%USERPROFILE%%^!"');
      expect(script).toContain('set "OC_QUOTE=he said ^"hi^""');
      expect(script).not.toContain('set "OC_EMPTY=');
      expect(script).toContain('set "NODE_OPTIONS="');
      expect(script).not.toContain("set OC_INJECT=");

      const parsed = await readScheduledTaskCommand(env);
      expect(parsed).toStrictEqual({
        programArguments: [
          "node",
          "gateway.js",
          "--display-name",
          "safe&whoami",
          "--percent",
          "%TEMP%",
          "--bang",
          "!token!",
        ],
        workingDirectory: "C:\\temp\\poc&calc",
        environment: {
          OC_INJECT: "safe & whoami | calc",
          OC_CARET: "a^b",
          OC_PERCENT: "%TEMP%",
          OC_BANG: "!token!",
          OC_SOURCE_PATH: "C:\\OpenClaw source & ^ %USERPROFILE%!",
          OC_QUOTE: 'he said "hi"',
          NODE_OPTIONS: "",
        },
        environmentValueSources: {
          OC_INJECT: "inline",
          OC_CARET: "inline",
          OC_PERCENT: "inline",
          OC_BANG: "inline",
          OC_SOURCE_PATH: "inline",
          OC_QUOTE: "inline",
          NODE_OPTIONS: "inline",
        },
        sourcePath: scriptPath,
      });

      expect(schtasksCalls[0]).toEqual(["/Query", "/TN", "OpenClaw Gateway"]);
      expect(schtasksCalls[1]?.[0]).toBe("/Change");
      // Battery-flag XML re-apply runs between /Change and /Run on upgrades.
      expect(schtasksCalls[2]?.slice(0, 5)).toEqual([
        "/Create",
        "/F",
        "/TN",
        "OpenClaw Gateway",
        "/XML",
      ]);
      expect(schtasksCalls[3]).toEqual(["/Run", "/TN", "OpenClaw Gateway"]);
    });
  });

  it("rejects line breaks in command arguments, env vars, and descriptions", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: ["node", "gateway.js", "bad\narg"],
          environment: {},
        }),
      ).rejects.toThrow(/Command argument cannot contain CR or LF/);

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: ["node", "gateway.js"],
          environment: { BAD: "line1\r\nline2" },
        }),
      ).rejects.toThrow(/Environment variable value cannot contain CR or LF/);

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          description: "bad\ndescription",
          programArguments: ["node", "gateway.js"],
          environment: {},
        }),
      ).rejects.toThrow(/Task description cannot contain CR or LF/);
    });
  });

  it("uses /Create when the task does not exist yet", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(missingTaskResponse);

      await installDefaultGatewayTask(env);

      expectInitialTaskQuery();
      expect(schtasksCalls[1]?.[0]).toBe("/Create");
      expectTaskRunCall(2);
    });
  });

  it.each([
    { kind: "new", query: missingTaskResponse, marker: "1", xmlIndex: 1 },
    { kind: "existing", query: okSchtasksResponse, marker: "true", xmlIndex: 2 },
  ])("uses the requested hidden launcher for $kind tasks", async ({ query, marker, xmlIndex }) => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(query);
      const { scriptPath } = await installDefaultGatewayTask({
        ...env,
        USERDOMAIN: "WORKSTATION",
        USERNAME: "alice",
        OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: marker,
      });
      const launcherPath = scriptPath.replace(/\.cmd$/i, ".vbs");
      const rawLauncher = await fs.readFile(launcherPath);
      const launcher = decodeWindowsLauncherScript({ buffer: rawLauncher });

      expectInitialTaskQuery();
      if (xmlIndex === 2) {
        expect(schtasksCalls[1]).toEqual([
          "/Change",
          "/TN",
          "OpenClaw Gateway",
          "/TR",
          expect.stringContaining("gateway.vbs"),
        ]);
        expect(schtasksCalls[1]?.[4]).toContain(launcherPath);
      }
      // wscript requires a BOM for UTF-16; XML owns the interactive principal.
      expect(rawLauncher.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
      expect(schtasksCalls[xmlIndex]?.slice(0, 5)).toEqual([
        "/Create",
        "/F",
        "/TN",
        "OpenClaw Gateway",
        "/XML",
      ]);
      expect(schtasksCalls[xmlIndex]).not.toContain("/RU");
      expect(schtasksCalls[xmlIndex]).not.toContain("/NP");
      const xml = xmlPayloadCaptures.find((entry) => entry.index === xmlIndex)?.xml;
      expect(xml).toContain("<UserId>WORKSTATION\\alice</UserId>");
      expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
      expect(launcher).toContain(`WScript.Quit shell.Run("""${scriptPath}""", 0, True)`);
      expectTaskRunCall(xmlIndex + 1);
    });
  });

  it("writes hidden launchers wscript can decode for CJK profile paths (#107416)", async () => {
    await withUserProfileDir(async (tmpDir, _env) => {
      const cjkProfileDir = path.join(tmpDir, "苗振");
      await fs.mkdir(cjkProfileDir, { recursive: true });
      schtasksResponses.push(missingTaskResponse);

      const { scriptPath } = await installDefaultGatewayTask({
        USERPROFILE: cjkProfileDir,
        OPENCLAW_PROFILE: "default",
        OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
      });
      const launcherPath = scriptPath.replace(/\.cmd$/i, ".vbs");
      const rawLauncher = await fs.readFile(launcherPath);

      expect(scriptPath).toContain("苗振");
      expect(rawLauncher.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
      expect(rawLauncher.subarray(2).toString("utf16le")).toContain(
        `WScript.Quit shell.Run("""${scriptPath}""", 0, True)`,
      );
    });
  });

  it("fails the install instead of writing an unrepresentable cmd launcher", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      resolveWindowsOemEncodingMock.mockReturnValue("gbk");
      schtasksResponses.push(missingTaskResponse);

      await expect(
        installScheduledTask({
          env,
          stdout: new PassThrough(),
          programArguments: ["node", "gateway.js"],
          environment: { OC_LABEL: "🚀" },
        }),
      ).rejects.toThrow(/cannot be represented in the Windows console code page/);
      await expect(fs.access(resolveTaskScriptPath(env))).rejects.toThrow();
    });
  });

  it("uses the hidden launcher for generated Windows gateway service installs", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(missingTaskResponse);
      const callerEnv: Record<string, string | undefined> = {
        ...env,
        HOME: env.USERPROFILE,
        USERDOMAIN: "WORKSTATION",
        USERNAME: "alice",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Custom Gateway",
      };
      const gatewayEnv = buildServiceEnvironment({
        env: callerEnv,
        port: 18789,
        platform: "win32",
      });

      expect(callerEnv.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
      expect(gatewayEnv.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBe("1");
      expect(gatewayEnv.OPENCLAW_WINDOWS_TASK_NAME).toBe("OpenClaw Gateway");

      const { scriptPath } = await installScheduledTask({
        env: callerEnv,
        stdout: new PassThrough(),
        programArguments: ["node", "gateway.js"],
        environment: {
          ...gatewayEnv,
          USERDOMAIN: "EVIL",
          USERNAME: "mallory",
        },
      });
      const launcherPath = scriptPath.replace(/\.cmd$/i, ".vbs");
      const script = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
      const launcher = decodeWindowsLauncherScript({ buffer: await fs.readFile(launcherPath) });

      expect(schtasksCalls[1]?.slice(0, 5)).toEqual([
        "/Create",
        "/F",
        "/TN",
        "OpenClaw Custom Gateway",
        "/XML",
      ]);
      expect(schtasksCalls[1]).not.toContain("/RU");
      expect(schtasksCalls[1]).not.toContain("/NP");
      const captured = xmlPayloadCaptures.find((entry) => entry.index === 1);
      expect(captured?.xml).toContain("gateway.vbs</Command>");
      expect(captured?.xml).toContain("<UserId>WORKSTATION\\alice</UserId>");
      expect(captured?.xml).toContain("<LogonType>InteractiveToken</LogonType>");
      expect(script).toContain('set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Custom Gateway"');
      expect(script).not.toContain('set "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER=');
      expect(launcher).toContain(
        'shell.Environment("Process")("OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER") = "wscript"',
      );
      expect(launcher).toContain("WScript.Shell");
      expect(launcher).toContain(`WScript.Quit shell.Run("""${scriptPath}""", 0, True)`);
      expectTaskRunCall(2, "OpenClaw Custom Gateway");
    });
  });

  it("removes a generated hidden launcher when the caller env lacks its marker", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(okSchtasksResponse, missingTaskResponse);
      const scriptPath = resolveTaskScriptPath(env);
      const parsedScriptPath = path.parse(scriptPath);
      const launcherPath = path.join(parsedScriptPath.dir, `${parsedScriptPath.name}.vbs`);
      await fs.mkdir(parsedScriptPath.dir, { recursive: true });
      await fs.writeFile(scriptPath, "@echo off\n", "utf8");
      await fs.writeFile(launcherPath, 'CreateObject("WScript.Shell")\n', "utf8");

      await uninstallScheduledTask({
        env,
        stdout: new PassThrough(),
      });

      const remaining: string[] = [];
      for (const candidate of [scriptPath, launcherPath]) {
        try {
          await fs.access(candidate);
          remaining.push(candidate);
        } catch {}
      }
      expect(remaining).toEqual([]);
    });
  });

  it("preserves task scripts when Scheduled Task deletion fails", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(okSchtasksResponse, okSchtasksResponse, accessDeniedResponse);
      const scriptPath = resolveTaskScriptPath(env);
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, "@echo off\n", "utf8");

      await expect(uninstallScheduledTask({ env, stdout: new PassThrough() })).rejects.toThrow(
        "schtasks delete failed: ERROR: Access is denied.",
      );
      await fs.access(scriptPath);
    });
  });

  it.each([
    {
      kind: "new domain task",
      domain: "WORKSTATION",
      user: "WORKSTATION\\alice",
      query: missingTaskResponse,
      commands: ["/Query", "/Create", "/Run"],
      xmlIndex: 1,
    },
    {
      kind: "new workgroup task",
      domain: "WORKGROUP",
      user: "alice",
      query: missingTaskResponse,
      commands: ["/Query", "/Create", "/Run"],
      xmlIndex: 1,
    },
    {
      kind: "upgraded task",
      domain: "WORKSTATION",
      user: "WORKSTATION\\alice",
      query: okSchtasksResponse,
      commands: ["/Query", "/Change", "/Create", "/Run"],
      xmlIndex: 2,
    },
  ])(
    "preserves interactive identity and battery settings for a $kind (#59299)",
    async ({ domain, user, query, commands, xmlIndex }) => {
      await withUserProfileDir(async (_tmpDir, env) => {
        schtasksResponses.push(query);
        await installDefaultGatewayTask({ ...env, USERDOMAIN: domain, USERNAME: "alice" });

        expectInitialTaskQuery();
        expect(schtasksCalls.map((call) => call[0])).toEqual(commands);
        const createCall = schtasksCalls[xmlIndex];
        expect(createCall?.slice(0, 5)).toEqual([
          "/Create",
          "/F",
          "/TN",
          "OpenClaw Gateway",
          "/XML",
        ]);
        expect(createCall).not.toContain("/RU");
        expect(createCall).not.toContain("/NP");
        expectTaskRunCall(xmlIndex + 1);
        const xml = xmlPayloadCaptures.find((entry) => entry.index === xmlIndex)?.xml;
        expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
        expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
        expect(xml).toContain("<RestartOnFailure>");
        expect(xml).toContain("<Interval>PT1M</Interval>");
        expect(xml).toContain("<Count>3</Count>");
        expect(xml).toContain("<LogonTrigger>");
        expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
        expect(xml).toContain(`<UserId>${user}</UserId>`);
        expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
        expect(xml).not.toContain("<GroupId>S-1-5-32-545</GroupId>");
        expect(xml).toContain("<Exec>");
      });
    },
  );

  it("falls back to /Create when /Change fails on an existing task", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      schtasksResponses.push(okSchtasksResponse, accessDeniedResponse);

      await installDefaultGatewayTask(env);

      expectInitialTaskQuery();
      expect(schtasksCalls[1]?.[0]).toBe("/Change");
      expect(schtasksCalls[2]?.[0]).toBe("/Create");
      expectTaskRunCall(3);
    });
  });

  it.each([
    {
      kind: "existing",
      responses: [okSchtasksResponse, okSchtasksResponse, okSchtasksResponse, accessDeniedResponse],
      commands: ["/Query", "/Change", "/Create", "/Run"],
      runIndex: 3,
    },
    {
      kind: "new",
      responses: [missingTaskResponse, okSchtasksResponse, accessDeniedResponse],
      commands: ["/Query", "/Create", "/Run"],
      runIndex: 2,
    },
  ])(
    "propagates /Run failure after registering a $kind task",
    async ({ responses, commands, runIndex }) => {
      await withUserProfileDir(async (_tmpDir, env) => {
        schtasksResponses.push(...responses);
        await expect(installDefaultGatewayTask(env)).rejects.toThrow(
          "schtasks run failed: ERROR: Access is denied.",
        );
        expectInitialTaskQuery();
        expect(schtasksCalls.map((call) => call[0])).toEqual(commands);
        expectTaskRunCall(runIndex);
      });
    },
  );

  it("does not persist a frozen PATH snapshot into the generated task script", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const { scriptPath } = await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: ["node", "gateway.js"],
        environment: {
          PATH: "C:\\Windows\\System32;C:\\Program Files\\Docker\\Docker\\resources\\bin",
          OPENCLAW_GATEWAY_PORT: "18789",
        },
      });

      const script = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
      expect(script).not.toContain('set "PATH=');
      expect(script).toContain('set "OPENCLAW_GATEWAY_PORT=18789"');
    });
  });

  it("exposes Windows task script env values as inline for managed-env drift audit", async () => {
    await withUserProfileDir(async (_tmpDir, env) => {
      const { scriptPath } = await installScheduledTask({
        env,
        stdout: new PassThrough(),
        programArguments: ["node", "gateway.js"],
        environment: {
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
          TAVILY_API_KEY: "old-inline-value",
        },
      });

      const command = await readScheduledTaskCommand(env);
      expect(command).toStrictEqual({
        programArguments: ["node", "gateway.js"],
        environment: {
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
          TAVILY_API_KEY: "old-inline-value",
        },
        environmentValueSources: {
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "inline",
          TAVILY_API_KEY: "inline",
        },
        sourcePath: scriptPath,
      });

      const audit = await auditGatewayServiceConfig({
        env,
        platform: "win32",
        command,
        expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"],
      });
      expect(
        audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded),
      ).toBe(true);
    });
  });
});
