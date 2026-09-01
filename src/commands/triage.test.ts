import { execFile } from "node:child_process";
// Triage tests protect bounded prompts, sanitized handoffs, and embedded-run gating.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { triageCommand } from "./triage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  callGatewayFromCliWithTransport: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  gatherDaemonStatus: vi.fn(),
  verifySetupInference: vi.fn(),
  agentExecCommand: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveExecutablePath: vi.fn(),
  select: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("./doctor-lint.js", () => ({
  collectDoctorFindings: mocks.collectDoctorFindings,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: mocks.resolveExecutablePath,
}));

vi.mock("./configure.shared.js", () => ({
  select: mocks.select,
}));

vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGatewayFromCliWithTransport,
}));

vi.mock("../logging/diagnostic-support-export.js", () => ({
  writeDiagnosticSupportExport: mocks.writeDiagnosticSupportExport,
}));

vi.mock("../cli/daemon-cli/status.gather.js", () => ({
  gatherDaemonStatus: mocks.gatherDaemonStatus,
}));

vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInference: mocks.verifySetupInference,
}));

vi.mock("./agent-exec.js", () => ({
  agentExecCommand: mocks.agentExecCommand,
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

async function withInteractiveTerminal(run: () => Promise<void>): Promise<void> {
  const descriptors = [process.stdin, process.stdout].map((stream) =>
    Object.getOwnPropertyDescriptor(stream, "isTTY"),
  );
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    await run();
  } finally {
    for (const [index, stream] of [process.stdin, process.stdout].entries()) {
      const descriptor = descriptors[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    }
  }
}

describe("triageCommand", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = tempDirs.make("openclaw-triage-test-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", undefined);
    mocks.collectDoctorFindings.mockResolvedValue([]);
    mocks.readConfigFileSnapshot.mockResolvedValue({ exists: false, valid: true, config: {} });
    mocks.resolveExecutablePath.mockReturnValue(undefined);
    mocks.select.mockResolvedValue({ kind: "print" });
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes one stable JSON handoff without probing inference or starting an agent", async () => {
    const findings: HealthFinding[] = [
      { checkId: "core/error", severity: "error", message: "broken" },
      { checkId: "core/warning", severity: "warning", message: "warn" },
      { checkId: "core/info", severity: "info", message: "detail" },
    ];
    mocks.collectDoctorFindings.mockResolvedValue(findings);
    const runtime = createRuntime();

    await triageCommand(runtime, { json: true, noExport: true });

    const promptPath = runtime.writeJson.mock.calls[0]?.[0]?.promptPath as string;
    expect(runtime.writeJson).toHaveBeenCalledOnce();
    expect(path.isAbsolute(promptPath)).toBe(true);
    expect(promptPath.startsWith(stateDir)).toBe(true);
    expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual({
      promptPath,
      bundlePath: null,
      bundleError: null,
      findings: { error: 1, warning: 1, info: 1 },
      detectedAgents: [],
      suggestedCommands:
        process.platform === "win32"
          ? [
              expect.stringContaining("| & claude -p"),
              expect.stringContaining("| & codex exec --skip-git-repo-check -"),
              expect.stringContaining("& openclaw triage --run"),
            ]
          : [
              `env OPENCLAW_STATE_DIR='${stateDir}' OPENCLAW_CONFIG_PATH='${path.join(stateDir, "openclaw.json")}' OPENCLAW_WORKSPACE_DIR='${path.join(stateDir, "workspace")}' claude -p < '${promptPath}'`,
              `env OPENCLAW_STATE_DIR='${stateDir}' OPENCLAW_CONFIG_PATH='${path.join(stateDir, "openclaw.json")}' OPENCLAW_WORKSPACE_DIR='${path.join(stateDir, "workspace")}' codex exec --skip-git-repo-check - < '${promptPath}'`,
              `env OPENCLAW_STATE_DIR='${stateDir}' OPENCLAW_CONFIG_PATH='${path.join(stateDir, "openclaw.json")}' OPENCLAW_WORKSPACE_DIR='${path.join(stateDir, "workspace")}' openclaw triage --run`,
            ],
    });
    expect(await fs.readFile(promptPath, "utf8")).toContain("[error] core/error: broken");
    expect(mocks.callGatewayFromCliWithTransport).not.toHaveBeenCalled();
    expect(mocks.verifySetupInference).not.toHaveBeenCalled();
    expect(mocks.agentExecCommand).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32").each(["default", "custom"])(
    "pins state, config and %s workspace in executable, POSIX-quoted manual handoffs",
    async (workspaceSelector) => {
      const home = path.join(stateDir, "operator's $fixture");
      const originalState = path.join(home, ".openclaw");
      const configPath = path.join(home, "custom config.json");
      const defaultWorkspaceDir =
        workspaceSelector === "custom"
          ? path.join(home, "custom workspace")
          : path.join(originalState, "workspace");
      const bin = path.join(home, "bin");
      await fs.mkdir(bin, { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("OPENCLAW_HOME", home);
      vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
      // Doctor's dotenv phase can establish the original custom selectors.
      mocks.collectDoctorFindings.mockImplementation(async () => {
        process.env.OPENCLAW_CONFIG_PATH = configPath;
        if (workspaceSelector === "custom") {
          process.env.OPENCLAW_WORKSPACE_DIR = defaultWorkspaceDir;
        }
        return [];
      });
      for (const command of ["claude", "codex", "openclaw"]) {
        await fs.writeFile(
          path.join(bin, command),
          `#!/bin/sh\nprintf "%s\\n" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_WORKSPACE_DIR"\n${command === "openclaw" ? "" : "cat\n"}`,
          { mode: 0o700 },
        );
      }
      const runtime = createRuntime();
      await triageCommand(runtime, { json: true, noExport: true });
      const report = runtime.writeJson.mock.calls[0]?.[0] as {
        promptPath: string;
        suggestedCommands: string[];
      };
      const prompt = await fs.readFile(report.promptPath, "utf8");
      for (const [index, command] of report.suggestedCommands.entries()) {
        const { stdout } = await promisify(execFile)("/bin/sh", ["-c", command], {
          env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
          timeout: 10_000,
        });
        expect(stdout).toBe(
          `${originalState}\n${configPath}\n${defaultWorkspaceDir}\n${index < 2 ? prompt : ""}`,
        );
      }
      expect(await fs.readFile(report.promptPath, "utf8")).not.toContain(home);
      expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
    },
  );

  it("reports only external agents resolved on PATH without checking their credentials", async () => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) =>
      binary === "codex" ? "/usr/local/bin/codex" : undefined,
    );
    const runtime = createRuntime();

    await triageCommand(runtime, { json: true, noExport: true });

    expect(runtime.writeJson.mock.calls[0]?.[0]).toMatchObject({ detectedAgents: ["codex"] });
    expect(mocks.resolveExecutablePath.mock.calls).toEqual([["claude"], ["codex"]]);
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.verifySetupInference).not.toHaveBeenCalled();
  });

  it("degrades to a sanitized prompt when the diagnostics export fails", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    mocks.callGatewayFromCliWithTransport.mockResolvedValue({ ok: true });
    mocks.writeDiagnosticSupportExport.mockRejectedValue(
      new Error(
        `Gateway unreachable: Config: ${stateDir}/openclaw.json; Authorization: Bearer ${secret}`,
      ),
    );
    const runtime = createRuntime();

    await triageCommand(runtime, { json: true });

    const report = runtime.writeJson.mock.calls[0]?.[0] as {
      promptPath: string;
      bundlePath: null;
      bundleError: string;
    };
    expect(report.bundlePath).toBeNull();
    expect(report.bundleError).toContain("Gateway unreachable");
    expect(report.bundleError).toContain("Config: $OPENCLAW_STATE_DIR/openclaw.json");
    expect(report.bundleError).not.toContain(secret);
    const prompt = await fs.readFile(report.promptPath, "utf8");
    expect(prompt).toContain("Diagnostics export unavailable: Gateway unreachable");
    expect(prompt).toContain("Config: $OPENCLAW_STATE_DIR/openclaw.json");
    expect(prompt).not.toContain(stateDir);
  });

  it.each(["json", "nonInteractive"] as const)(
    "preserves a failed update when Doctor and export fail in %s mode on a terminal",
    async (mode) => {
      const secret = "sk-test-update-triage-secret-1234567890";
      mocks.collectDoctorFindings.mockRejectedValue(
        new Error(`Doctor unavailable token=${secret}`),
      );
      mocks.writeDiagnosticSupportExport.mockRejectedValue(
        new Error(`Export unavailable token=${secret}`),
      );
      const runtime = createRuntime();
      const updateResult = path.join(stateDir, "failed-update.json");
      await fs.writeFile(
        updateResult,
        JSON.stringify({ error: `Original update failed at ${stateDir}; token=${secret}` }),
      );

      await withInteractiveTerminal(async () => {
        await triageCommand(runtime, {
          [mode]: true,
          updateResult,
        });
      });

      const promptPath =
        mode === "json"
          ? runtime.writeJson.mock.calls[0]?.[0]?.promptPath
          : String(runtime.log.mock.calls[0]?.[0]).replace("Debugging prompt: ", "");
      const prompt = await fs.readFile(promptPath, "utf8");
      expect(prompt).toContain("Original update failed at $OPENCLAW_STATE_DIR");
      expect(prompt).toContain("Doctor checks unavailable:");
      expect(prompt).toContain("Diagnostics export unavailable:");
      expect(prompt).not.toContain(secret);
      expect(prompt).not.toContain(stateDir);
      const output = mode === "json" ? runtime.writeJson.mock.calls : runtime.log.mock.calls;
      expect(JSON.stringify(output)).toContain("--update-result");
      expect(JSON.stringify(output)).not.toContain(secret);
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.verifySetupInference).not.toHaveBeenCalled();
      expect(mocks.agentExecCommand).not.toHaveBeenCalled();
    },
  );

  it("keeps the saved failed-update handoff usable after its temporary input is removed", async () => {
    const inputPath = path.join(stateDir, "temporary-update-result.json");
    const secret = "sk-test-update-triage-secret-1234567890";
    await fs.writeFile(
      inputPath,
      JSON.stringify({ error: `Original update failed token=${secret}` }),
    );
    const runtime = createRuntime();
    await triageCommand(runtime, { json: true, noExport: true, updateResult: inputPath });
    const report = runtime.writeJson.mock.calls[0]?.[0] as { suggestedCommands: string[] };
    const savedArgument = report.suggestedCommands[2]?.match(
      / --update-result (?:'([^']+)'|(\S+))/u,
    );
    const savedPath = savedArgument?.[1] ?? savedArgument?.[2];
    if (!savedPath) {
      throw new Error("Saved triage command is missing its failed update input");
    }
    expect(savedPath.startsWith(path.join(stateDir, "logs", "support"))).toBe(true);
    expect(await fs.readFile(savedPath, "utf8")).not.toContain(secret);
    await fs.unlink(inputPath);

    await triageCommand(runtime, { json: true, noExport: true, updateResult: savedPath });
    const nextPromptPath = runtime.writeJson.mock.calls[1]?.[0]?.promptPath as string;
    expect(await fs.readFile(nextPromptPath, "utf8")).toContain("Original update failed");
  });

  it("preserves local diagnostics and redacted snapshot failures while the Gateway is offline", async () => {
    const { writeDiagnosticSupportExport } = await vi.importActual<
      typeof import("../logging/diagnostic-support-export.js")
    >("../logging/diagnostic-support-export.js");
    const secret = "sk-test-triage-offline-secret-1234567890";
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { token: secret } } }));
    mocks.callGatewayFromCliWithTransport.mockRejectedValue(new Error(`Offline token=${secret}`));
    mocks.gatherDaemonStatus.mockRejectedValue(new Error("Status unavailable"));
    mocks.writeDiagnosticSupportExport.mockImplementation((options) =>
      writeDiagnosticSupportExport({
        ...options,
        stateDir,
        env: { HOME: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        readLogTail: async () => ({
          file: path.join(stateDir, "gateway.log"),
          cursor: 0,
          size: 0,
          lines: [],
          truncated: false,
          reset: false,
        }),
      }),
    );
    const runtime = createRuntime();

    await triageCommand(runtime, { json: true });

    const report = runtime.writeJson.mock.calls[0]?.[0] as {
      promptPath: string;
      bundlePath: string;
      bundleError: string | null;
    };
    expect(report.bundleError).toBeNull();
    expect(report.bundlePath).toEqual(expect.any(String));
    const zip = await JSZip.loadAsync(await fs.readFile(report.bundlePath));
    const diagnostics = JSON.parse(await zip.file("diagnostics.json")!.async("string"));
    expect(diagnostics.config).toMatchObject({ exists: true, parseOk: true });
    expect(diagnostics.health).toMatchObject({ status: "failed" });
    expect(diagnostics.status).toMatchObject({ status: "failed" });
    const entries = await Promise.all(
      Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.async("string")),
    );
    expect(entries.join("\n")).not.toContain(secret);
    expect(entries.join("\n")).not.toContain(stateDir);
    expect(await fs.readFile(report.promptPath, "utf8")).toContain("Sanitized ZIP:");
    if (process.platform !== "win32") {
      for (const file of [report.promptPath, report.bundlePath]) {
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
      expect((await fs.stat(path.dirname(report.promptPath))).mode & 0o777).toBe(0o700);
    }
  });

  it("reuses the sanitized support exporter with Gateway status and health snapshots", async () => {
    const health = { ok: true };
    const status = { gateway: { reachable: true } };
    const bundlePath = path.join(stateDir, "diagnostics.zip");
    mocks.callGatewayFromCliWithTransport.mockResolvedValue(health);
    mocks.gatherDaemonStatus.mockResolvedValue(status);
    mocks.writeDiagnosticSupportExport.mockImplementation(async (options) => {
      expect(await options.readHealthSnapshot()).toBe(health);
      expect(await options.readStatusSnapshot()).toBe(status);
      return { path: bundlePath };
    });
    const runtime = createRuntime();

    await triageCommand(runtime, { json: true });

    const report = runtime.writeJson.mock.calls[0]?.[0] as {
      promptPath: string;
      bundlePath: string;
      bundleError: null;
      suggestedCommands: string[];
    };
    expect(report).toMatchObject({ bundlePath, bundleError: null });
    expect(path.isAbsolute(report.promptPath)).toBe(true);
    expect(path.isAbsolute(report.bundlePath)).toBe(true);
    expect(report.suggestedCommands[0]).toContain(report.promptPath);
    expect(report.suggestedCommands[1]).toContain(report.promptPath);
    expect(await fs.readFile(report.promptPath, "utf8")).toContain(
      "Sanitized ZIP: $OPENCLAW_STATE_DIR/diagnostics.zip",
    );
    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: { timeout: "3000", json: true },
      probe: true,
      requireRpc: false,
      deep: false,
    });
  });

  it.each([true, false])(
    "refuses embedded execution when inference fails (run=%s)",
    async (run) => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: true,
        config: { agents: { defaults: { model: "openai/gpt-5.6-luna" } } },
      });
      mocks.select.mockResolvedValue({ kind: "embedded" });
      mocks.verifySetupInference.mockResolvedValue({
        ok: false,
        status: "auth",
        error: "The configured model is unavailable",
      });
      const runtime = createRuntime();

      await withInteractiveTerminal(async () => {
        await expect(triageCommand(runtime, { noExport: true, run })).rejects.toThrow(
          "Run `openclaw onboard` or use a suggested handoff command.",
        );
      });

      expect(mocks.verifySetupInference).toHaveBeenCalledWith({ runtime, timeoutMs: 15_000 });
      expect(mocks.agentExecCommand).not.toHaveBeenCalled();
    },
  );

  it("passes the saved prompt to one embedded agent turn after a healthy live probe", async () => {
    mocks.verifySetupInference.mockResolvedValue({
      ok: true,
      modelRef: "openai/gpt-5.6-luna",
      latencyMs: 12,
    });
    mocks.agentExecCommand.mockResolvedValue({ exitCode: 0 });
    const runtime = createRuntime();

    await withInteractiveTerminal(async () => {
      await triageCommand(runtime, { noExport: true, run: true });
    });

    expect(mocks.agentExecCommand).toHaveBeenCalledExactlyOnceWith(
      undefined,
      { messageFile: expect.stringMatching(/openclaw-triage-prompt-.*\.md$/u) },
      runtime,
    );
  });

  it("offers configured and installed agents in handoff order without probing before selection", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { agents: { defaults: { model: "openai/gpt-5.6-luna" } } },
    });
    mocks.resolveExecutablePath.mockImplementation((binary: string) => `/usr/local/bin/${binary}`);
    mocks.select.mockImplementation(async () => {
      expect(mocks.verifySetupInference).not.toHaveBeenCalled();
      return { kind: "print" };
    });
    const runtime = createRuntime();

    await withInteractiveTerminal(async () => {
      await triageCommand(runtime, { noExport: true });
    });

    expect(mocks.select).toHaveBeenCalledWith({
      message: "Choose an agent to investigate this OpenClaw installation",
      options: [
        { value: { kind: "embedded" }, label: "OpenClaw embedded agent" },
        {
          value: { kind: "external", agent: "claude", executablePath: "/usr/local/bin/claude" },
          label: "Claude Code",
        },
        {
          value: { kind: "external", agent: "codex", executablePath: "/usr/local/bin/codex" },
          label: "Codex CLI",
        },
        { value: { kind: "print" }, label: "Just print the commands" },
      ],
    });
    expect(runtime.log).toHaveBeenCalledWith("Ready-to-run agent handoffs:");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.verifySetupInference).not.toHaveBeenCalled();
  });

  it("omits unavailable embedded and external agents from the interactive picker", async () => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) =>
      binary === "codex" ? "/usr/local/bin/codex" : undefined,
    );
    const runtime = createRuntime();

    await withInteractiveTerminal(async () => {
      await triageCommand(runtime, { noExport: true });
    });

    expect(mocks.select.mock.calls[0]?.[0]?.options).toEqual([
      {
        value: { kind: "external", agent: "codex", executablePath: "/usr/local/bin/codex" },
        label: "Codex CLI",
      },
      { value: { kind: "print" }, label: "Just print the commands" },
    ]);
    expect(mocks.verifySetupInference).not.toHaveBeenCalled();
  });

  it.each([
    { agent: "claude", executablePath: "C:\\tools\\claude.cmd" },
    { agent: "codex", executablePath: "C:\\tools\\codex.BAT" },
  ])(
    "keeps Windows $agent command shims as executable PowerShell manual handoffs",
    async ({ agent, executablePath }) => {
      const configPath = path.join(stateDir, "operator's $config`file.json");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mocks.resolveExecutablePath.mockImplementation((binary: string) =>
        binary === agent ? executablePath : undefined,
      );
      const runtime = createRuntime();

      try {
        await withInteractiveTerminal(async () => {
          await triageCommand(runtime, { noExport: true });
        });
      } finally {
        platform.mockRestore();
      }

      expect(mocks.select.mock.calls[0]?.[0]?.options).toEqual([
        { value: { kind: "print" }, label: "Just print the commands" },
      ]);
      const commands = runtime.log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("  "));
      expect(commands).toHaveLength(3);
      for (const command of commands) {
        expect(command).not.toMatch(/^ {2}env /u);
        expect(command).toContain(`'${configPath.replaceAll("'", "''")}'`);
      }
      expect(commands[0]).toContain("| & claude -p");
      expect(commands[1]).toContain("| & codex exec --skip-git-repo-check -");
      expect(commands[1]).toContain("Get-Content -Raw -Encoding UTF8 -LiteralPath ");
      expect(commands[2]).toContain("& openclaw triage --run");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { agent: "claude", exitCode: 0 },
    { agent: "codex", exitCode: 17 },
  ])("launches $agent interactively and propagates its exit code", async ({ agent, exitCode }) => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) =>
      binary === agent ? `/usr/local/bin/${binary}` : undefined,
    );
    mocks.select.mockResolvedValue({
      kind: "external",
      agent,
      executablePath: `/usr/local/bin/${agent}`,
    });
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", exitCode, null));
      return child;
    });
    const runtime = createRuntime();

    await withInteractiveTerminal(async () => {
      await triageCommand(runtime, { noExport: true });
    });

    const promptLog = runtime.log.mock.calls[0]?.[0];
    if (typeof promptLog !== "string") {
      throw new Error("Expected triage to log the saved prompt path.");
    }
    const promptPath = promptLog.replace("Debugging prompt: ", "");
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      `/usr/local/bin/${agent}`,
      [await fs.readFile(promptPath, "utf8")],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
        },
      },
    );
    expect(mocks.verifySetupInference).not.toHaveBeenCalled();
    if (exitCode === 0) {
      expect(runtime.exit).not.toHaveBeenCalled();
    } else {
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
    }
  });

  it("prints the selected manual command and exits nonzero when launching an agent fails", async () => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) =>
      binary === "claude" ? "/usr/local/bin/claude" : undefined,
    );
    mocks.select.mockResolvedValue({
      kind: "external",
      agent: "claude",
      executablePath: "/usr/local/bin/claude",
    });
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("permission denied")));
      return child;
    });
    const runtime = createRuntime();

    await withInteractiveTerminal(async () => {
      await triageCommand(runtime, { noExport: true });
    });

    expect(runtime.error).toHaveBeenCalledWith("Failed to launch claude: permission denied");
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(
        process.platform === "win32"
          ? /Run manually: .*\| & claude -p/u
          : /^Run manually: env .* claude /u,
      ),
    );
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("probes inference only after the configured embedded agent is selected", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { agents: { defaults: { model: "openai/gpt-5.6-luna" } } },
    });
    mocks.select.mockResolvedValue({ kind: "embedded" });
    mocks.verifySetupInference.mockResolvedValue({
      ok: true,
      modelRef: "openai/gpt-5.6-luna",
      latencyMs: 12,
    });
    mocks.agentExecCommand.mockResolvedValue({ exitCode: 0 });
    const runtime = createRuntime();

    await withInteractiveTerminal(async () => {
      await triageCommand(runtime, { noExport: true });
    });

    expect(mocks.select.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verifySetupInference.mock.invocationCallOrder[0]!,
    );
    expect(mocks.agentExecCommand).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
