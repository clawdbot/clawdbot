// Triage tests protect bounded prompts, sanitized handoffs, and embedded-run gating.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { renderTriagePrompt } from "./triage-prompt.js";
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

describe("renderTriagePrompt", () => {
  const homeDir = "/home/triage-test";
  const redaction = {
    env: { HOME: homeDir },
    stateDir: `${homeDir}/.openclaw`,
  };

  it("orders sanitized findings by severity and includes repair hints and bundle details", () => {
    const findings: HealthFinding[] = [
      { checkId: "core/info", severity: "info", message: "informational" },
      { checkId: "core/warning", severity: "warning", message: "needs attention" },
      {
        checkId: "core/error",
        severity: "error",
        message: "model routing failed",
        fixHint: "Run `openclaw doctor --fix`.",
      },
    ];

    const prompt = renderTriagePrompt({
      findings,
      bundle: { kind: "available", path: `${redaction.stateDir}/diagnostics.zip` },
      redaction,
    });

    expect(prompt.indexOf("[error]")).toBeLessThan(prompt.indexOf("[warning]"));
    expect(prompt.indexOf("[warning]")).toBeLessThan(prompt.indexOf("[info]"));
    expect(prompt).toContain("Fix: Run `openclaw doctor --fix`.");
    expect(prompt).toContain("Sanitized ZIP: $OPENCLAW_STATE_DIR/diagnostics.zip");
    expect(prompt).toContain("Secrets, tokens, raw chat payloads, and raw logs are excluded");
  });

  it("redacts home and state paths across finding fields and diagnostics handoffs", () => {
    const prompt = renderTriagePrompt({
      findings: [
        {
          checkId: `${homeDir}/checks/config`,
          severity: "error",
          message: `Config: ${redaction.stateDir}/openclaw.json\nneeds repair`,
          fixHint: `Inspect ${homeDir}/logs/gateway.log`,
        },
      ],
      bundle: { kind: "available", path: `${homeDir}/Downloads/diagnostics.zip` },
      redaction,
    });

    expect(prompt).toContain(
      "[error] ~/checks/config: Config: $OPENCLAW_STATE_DIR/openclaw.json needs repair",
    );
    expect(prompt).toContain("Fix: Inspect ~/logs/gateway.log");
    expect(prompt).toContain("Sanitized ZIP: ~/Downloads/diagnostics.zip");
    expect(prompt).not.toContain(homeDir);
  });

  it("hard-bounds multibyte findings and explicitly reports omitted findings", () => {
    const findings: HealthFinding[] = Array.from({ length: 25 }, (_, index) => ({
      checkId: `core/check-${index}`,
      severity: "warning",
      message: "🦞".repeat(4_000),
      fixHint: "修".repeat(4_000),
    }));

    const prompt = renderTriagePrompt({ findings, bundle: { kind: "skipped" }, redaction });

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(8 * 1024);
    // Every finding is either rendered or explicitly counted as omitted, and the
    // trailing sections survive because findings are fitted to the byte budget.
    const rendered = prompt.match(/^- \[warning\]/gmu)?.length ?? 0;
    expect(rendered).toBeGreaterThan(0);
    expect(prompt).toContain(
      `${findings.length - rendered} more findings omitted; run \`openclaw doctor\` for the full list.`,
    );
    expect(prompt).toContain("## Privacy");
    expect(prompt).not.toContain("\uFFFD");
    expect(prompt).toContain("...");
  });

  it.each([
    {
      bundle: { kind: "unavailable" as const, reason: "Gateway unreachable" },
      text: "Diagnostics export unavailable: Gateway unreachable",
    },
    {
      bundle: {
        kind: "unavailable" as const,
        reason: `Gateway config: ${redaction.stateDir}/openclaw.json`,
      },
      text: "Diagnostics export unavailable: Gateway config: $OPENCLAW_STATE_DIR/openclaw.json",
    },
    {
      bundle: { kind: "skipped" as const },
      text: "Diagnostics export skipped with `--no-export`.",
    },
  ])("explains absent diagnostics archives: $text", ({ bundle, text }) => {
    expect(renderTriagePrompt({ findings: [], bundle, redaction })).toContain(text);
  });
});

describe("triageCommand", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = tempDirs.make("openclaw-triage-test-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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
      suggestedCommands: [
        `claude "$(cat '${promptPath}')"`,
        `codex exec --skip-git-repo-check - < '${promptPath}'`,
        "openclaw triage --run",
      ],
    });
    expect(await fs.readFile(promptPath, "utf8")).toContain("[error] core/error: broken");
    expect(mocks.callGatewayFromCliWithTransport).not.toHaveBeenCalled();
    expect(mocks.verifySetupInference).not.toHaveBeenCalled();
    expect(mocks.agentExecCommand).not.toHaveBeenCalled();
  });

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
    "keeps Windows $agent command shims as manual-only handoffs",
    async ({ agent, executablePath }) => {
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
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^  ${agent} `, "u")),
      );
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
      { stdio: "inherit" },
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
    expect(runtime.log).toHaveBeenCalledWith(expect.stringMatching(/^Run manually: claude /u));
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
