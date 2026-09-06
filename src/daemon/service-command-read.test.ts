import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLaunchAgentPlist,
  LAUNCH_AGENT_ENV_WRAPPER_SHELL,
  quoteLaunchAgentEnvironmentValue,
} from "./launchd-plist.js";
import { readLaunchAgentProgramArguments } from "./launchd-runtime.js";
import {
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import {
  buildTaskScript,
  readScheduledTaskCommand,
  resolveStartupEntryPaths,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceReadOptions,
} from "./service-types.js";

const native = vi.hoisted(() => ({
  launchctl: vi.fn(),
  scheduler: vi.fn(),
  plutil: vi.fn(),
  plistRecords: new Map<string, unknown>(),
}));
vi.mock("./exec-file.js", () => ({ execFileUtf8: native.launchctl }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: native.plutil,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: native.scheduler,
}));

const label = "ai.openclaw.gateway";
const programArguments = ["node", "gateway.js"];
const environment = { HOME: "/service-home", OPENCLAW_STATE_DIR: "/service-state" };
const renderPlist = (args: string[]) => {
  const contents = buildLaunchAgentPlist({
    label,
    programArguments: args,
    stdoutPath: "/service-stdout.log",
    stderrPath: "/service-stderr.log",
    environment,
  });
  native.plistRecords.set(contents, { ProgramArguments: args, EnvironmentVariables: environment });
  return contents;
};
const readers: Array<{
  name: string;
  read: (
    env: GatewayServiceEnv,
    options?: GatewayServiceReadOptions,
  ) => Promise<GatewayServiceCommandConfig | null>;
  resolvePath: (env: GatewayServiceEnv) => string;
  render: (args: string[]) => string;
}> = [
  {
    name: "LaunchAgent",
    read: readLaunchAgentProgramArguments,
    resolvePath: resolveLaunchAgentPlistPath,
    render: renderPlist,
  },
  {
    name: "Scheduled Task",
    read: readScheduledTaskCommand,
    resolvePath: resolveTaskScriptPath,
    render: (args) => buildTaskScript({ programArguments: args, environment }),
  },
];

describe("native service command inspection", () => {
  let root: string;
  let env: GatewayServiceEnv;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-command-"));
    env = { HOME: root, USERPROFILE: root, OPENCLAW_LAUNCHD_LABEL: label };
    native.launchctl.mockReset().mockResolvedValue({
      code: 113,
      termination: "exit",
      stdout: "",
      stderr: "Could not find service",
    });
    native.scheduler.mockReset().mockReturnValue({ status: 1, stdout: "-2147024894" });
    native.plistRecords.clear();
    native.plutil.mockReset().mockImplementation(async (_command, _args, options) => {
      const captured = Buffer.from(options.input).toString("utf8");
      if (!native.plistRecords.has(captured)) {
        throw new Error("native-plist-inspection-secret-canary");
      }
      return { stdout: JSON.stringify(native.plistRecords.get(captured)), stderr: "" };
    });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeFile(filename: string, contents: string) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, contents);
  }

  describe.each(readers)("$name", ({ name, read, resolvePath, render }) => {
    it("does not infer absence from a dangling definition link", async () => {
      const filename = resolvePath(env);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.symlink(path.join(root, "absent-definition"), filename, "junction");
      await expect(read(env)).resolves.toBeNull();
      await expect(read(env, { requireEffective: true })).rejects.toThrow(
        `Effective ${name} service command could not be inspected.`,
      );
    });

    it.each(["registered", "unavailable"])(
      "does not infer absence from a missing file when native inspection is %s",
      async (condition) => {
        native.launchctl.mockResolvedValue(
          condition === "registered"
            ? { code: 0, termination: "exit", stdout: "state = waiting", stderr: "" }
            : {
                code: 1,
                termination: "error",
                stdout: "",
                stderr: "native-inspection-secret-canary",
              },
        );
        native.scheduler.mockReturnValue(
          condition === "registered"
            ? { status: 0, stdout: JSON.stringify({ state: 3 }) }
            : { status: 2, stdout: "native-inspection-secret-canary" },
        );
        await expect(read(env)).resolves.toBeNull();
        await expect(read(env, { requireEffective: true })).rejects.toThrow(
          `Effective ${name} service command could not be inspected.`,
        );
      },
    );

    it("keeps missing definitions distinct from failed inspection", async () => {
      await expect(read(env, { requireEffective: true })).resolves.toBeNull();
      await fs.mkdir(resolvePath(env), { recursive: true });
      await expect(read(env)).resolves.toBeNull();
      await expect(read(env, { requireEffective: true })).rejects.toThrow(
        `Effective ${name} service command could not be inspected.`,
      );
    });

    it("rejects an existing definition without an effective command in strict mode", async () => {
      await writeFile(resolvePath(env), render([]));
      await expect(read(env, { requireEffective: true })).rejects.toThrow(
        `Effective ${name} service command could not be inspected.`,
      );
    });

    it("preserves readable recorded paths in both inspection modes", async () => {
      await writeFile(resolvePath(env), render(programArguments));
      for (const requireEffective of [false, true]) {
        await expect(read(env, { requireEffective })).resolves.toMatchObject({
          programArguments,
          environment,
        });
      }
    });
  });

  it("does not infer Windows service absence while a Startup launcher remains", async () => {
    for (const pathname of resolveStartupEntryPaths(env)) {
      await writeFile(pathname, "@echo off\n");
    }
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow();
  });

  it.each([
    "set MALFORMED",
    "set =invalid",
    'set "OPENCLAW_STATE_DIR=%USERPROFILE%\\.openclaw"',
    'set "OPENCLAW_STATE_DIR=%~dp0state"',
    'set "OPENCLAW_STATE_DIR=!USERPROFILE!\\.openclaw"',
    'set "OPENCLAW_STATE_DIR=C:\\literal^^caret"',
    "set OPENCLAW_STATE_DIR=C:\\first & echo second",
    "set /a HOME=1",
    "set /p HOME=prompt",
  ])("rejects an unresolved Windows assignment in strict mode: %s", async (line) => {
    await writeFile(
      resolveTaskScriptPath(env),
      `@echo off\nset HOME=/partial-home\n${line}\nnode gateway.js\n`,
    );
    await expect(readScheduledTaskCommand(env)).resolves.toMatchObject({
      environment: { HOME: "/partial-home" },
    });
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow(
      "Effective Scheduled Task service command could not be inspected.",
    );
  });

  it("preserves literal Windows assignments without borrowing the caller's environment", async () => {
    await writeFile(
      resolveTaskScriptPath(env),
      [
        "@echo off",
        "set HOME=/literal-home",
        "set home=/effective-home",
        'set "OPENCLAW_STATE_DIR=C:\\literal%%USERPROFILE%% & (state)"',
        'set "NODE_OPTIONS="',
        'set "QUOTED=  literal spaces  "',
        "set UNQUOTED=  literal spaces  ",
        "set PERCENT=%%USERPROFILE%%",
        "node gateway.js",
      ].join("\r\n"),
    );
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).resolves.toMatchObject({
      programArguments,
      environment: {
        HOME: "/effective-home",
        OPENCLAW_STATE_DIR: "C:\\literal%USERPROFILE% & (state)",
        NODE_OPTIONS: "",
        QUOTED: "  literal spaces  ",
        UNQUOTED: "  literal spaces  ",
        PERCENT: "%USERPROFILE%",
      },
    });
  });

  it("rejects a malformed existing plist only in strict mode", async () => {
    await writeFile(resolveLaunchAgentPlistPath(env), "<plist><dict/></plist>");
    await expect(readLaunchAgentProgramArguments(env)).resolves.toBeNull();
    await expect(
      readLaunchAgentProgramArguments(env, { requireEffective: true }),
    ).rejects.toThrow();
  });

  it("rejects a truncated plist even when its command and environment are readable", async () => {
    const truncated = renderPlist(programArguments).replace(/\s*<\/dict>\s*<\/plist>\s*$/, "");
    await writeFile(resolveLaunchAgentPlistPath(env), truncated);
    await expect(readLaunchAgentProgramArguments(env)).resolves.toBeNull();
    await expect(readLaunchAgentProgramArguments(env, { requireEffective: true })).rejects.toThrow(
      "Effective LaunchAgent service command could not be inspected.",
    );
  });

  it.each([
    { decoded: [] },
    { decoded: { ProgramArguments: "node gateway.js" } },
    { decoded: { ProgramArguments: ["node", 42] } },
    { decoded: { ProgramArguments: programArguments, WorkingDirectory: 42 } },
    { decoded: { ProgramArguments: programArguments, EnvironmentVariables: { HOME: 42 } } },
  ])("rejects unsupported native plist field types: $decoded", async ({ decoded }) => {
    await writeFile(resolveLaunchAgentPlistPath(env), renderPlist(programArguments));
    native.plutil.mockResolvedValue({ stdout: JSON.stringify(decoded), stderr: "" });
    await expect(readLaunchAgentProgramArguments(env, { requireEffective: true })).rejects.toThrow(
      "Effective LaunchAgent service command could not be inspected.",
    );
  });

  it("preserves the native command without trimming or dropping arguments", async () => {
    const recordedArguments = ["node", "  spaced argument  ", ""];
    const contents = renderPlist(recordedArguments);
    await writeFile(resolveLaunchAgentPlistPath(env), contents);
    for (const requireEffective of [false, true]) {
      await expect(
        readLaunchAgentProgramArguments(env, { requireEffective, timeoutMs: 750 }),
      ).resolves.toMatchObject({ programArguments: recordedArguments });
    }
    expect(native.plutil).toHaveBeenCalledWith(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", "-"],
      expect.objectContaining({ input: Buffer.from(contents), timeoutMs: 750, logOutput: false }),
    );
  });

  it.each(["missing", "unreadable"])(
    "keeps %s generated environment recovery out of strict inspection",
    async (failure) => {
      const expectedEnvFile = resolveLaunchAgentEnvFilePath(env, label);
      const recordedEnvFile = path.join(root, "other", "service-env", `${label}.env`);
      const recordedWrapper = path.join(root, "other", "service-env", `${label}-env-wrapper.sh`);
      await writeFile(expectedEnvFile, "export OPENCLAW_STATE_DIR='/recovered-state'\n");
      if (failure === "unreadable") {
        await fs.mkdir(recordedEnvFile, { recursive: true });
      }
      await writeFile(
        resolveLaunchAgentPlistPath(env),
        renderPlist([
          LAUNCH_AGENT_ENV_WRAPPER_SHELL,
          recordedWrapper,
          recordedEnvFile,
          ...programArguments,
        ]),
      );
      await expect(readLaunchAgentProgramArguments(env)).resolves.toMatchObject({
        programArguments,
        environment: { OPENCLAW_STATE_DIR: "/recovered-state" },
      });
      await expect(
        readLaunchAgentProgramArguments(env, { requireEffective: true }),
      ).rejects.toThrow();
    },
  );

  it.each(["o'brien\\cash$", "first line\r\n  second line\nthird 'quoted' \\cash$"])(
    "reads the recorded generated literal in strict mode: %j",
    async (literal) => {
      const envFile = resolveLaunchAgentEnvFilePath(env, label);
      await writeFile(
        envFile,
        `export OPENCLAW_STATE_DIR='/recorded-state'\nexport NODE_OPTIONS=''\nexport QUOTE=${quoteLaunchAgentEnvironmentValue(literal)}\n`,
      );
      await writeFile(
        resolveLaunchAgentPlistPath(env),
        renderPlist([
          LAUNCH_AGENT_ENV_WRAPPER_SHELL,
          resolveLaunchAgentEnvWrapperPath(env, label),
          envFile,
          ...programArguments,
        ]),
      );
      await expect(
        readLaunchAgentProgramArguments(env, { requireEffective: true }),
      ).resolves.toMatchObject({
        programArguments,
        environment: { OPENCLAW_STATE_DIR: "/recorded-state", NODE_OPTIONS: "", QUOTE: literal },
      });
    },
  );

  it.each([
    "echo unsupported-command",
    "export OPENCLAW_STATE_DIR='unterminated",
    "export OPENCLAW_STATE_DIR=$(printf unsupported)",
    "export OPENCLAW_STATE_DIR='/partial'; echo unsupported-command",
  ])("rejects unsupported generated environment syntax: %s", async (line) => {
    const envFile = resolveLaunchAgentEnvFilePath(env, label);
    await writeFile(envFile, `export HOME='/partial-home'\n${line}\n`);
    await writeFile(
      resolveLaunchAgentPlistPath(env),
      renderPlist([
        LAUNCH_AGENT_ENV_WRAPPER_SHELL,
        resolveLaunchAgentEnvWrapperPath(env, label),
        envFile,
        ...programArguments,
      ]),
    );
    await expect(readLaunchAgentProgramArguments(env)).resolves.toMatchObject({ programArguments });
    await expect(readLaunchAgentProgramArguments(env, { requireEffective: true })).rejects.toThrow(
      "Effective LaunchAgent service command could not be inspected.",
    );
  });
});
