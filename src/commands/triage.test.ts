import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { triageAfterFailure } from "./triage-failure.js";
import { triageCommand } from "./triage.js";
import { createTriageRuntime, withTriageTerminal } from "./triage.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  callGatewayFromCliWithTransport: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  gatherDaemonStatus: vi.fn(),
  runUpdateRepairLoop: vi.fn(),
  agentExecCommand: vi.fn(),
  resolveExecutablePath: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("./doctor-lint.js", () => ({
  collectDoctorFindings: mocks.collectDoctorFindings,
}));

vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: mocks.resolveExecutablePath,
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

vi.mock("../infra/update-repair-agent.js", () => ({
  runUpdateRepairLoop: mocks.runUpdateRepairLoop,
}));

vi.mock("./agent-exec.js", () => ({ agentExecCommand: mocks.agentExecCommand }));

describe("triageCommand", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = tempDirs.make("openclaw-triage-test-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_SHELL", "");
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    vi.stubEnv("CODEX_THREAD_ID", "");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", undefined);
    mocks.collectDoctorFindings.mockResolvedValue([]);
    mocks.runUpdateRepairLoop.mockResolvedValue({
      status: "repaired",
      attempts: [],
      finalValidation: { ok: true, score: 0, summary: "Doctor lint reports no errors." },
    });
    mocks.resolveExecutablePath.mockReturnValue(undefined);
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("runs one selected automatic route with the original failure prompt", async () => {
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: "openai/gpt-5.6-luna" } } }),
    );
    mocks.agentExecCommand.mockResolvedValue({ exitCode: 1 });
    const runtime = createTriageRuntime();
    await expect(
      triageCommand(
        runtime,
        {},
        {
          signal: new AbortController().signal,
          assertCurrent: vi.fn(),
          failure: {
            kind: "update",
            phase: "restart-unhealthy",
            error: "listener never became healthy",
            gateway: "verify-running",
            expectedVersion: "2026.8.31",
          },
        },
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(mocks.agentExecCommand).toHaveBeenCalledOnce();
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.writeStdout).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.agentExecCommand.mock.calls[0]?.[0]).toContain("listener never became healthy");
  });

  it("fences the selected embedded effect after source loss without watchdog cancellation", async () => {
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: "openai/gpt-5.6-luna" } } }),
    );
    const controller = new AbortController();
    let current = true;
    let effectCount = 0;
    mocks.agentExecCommand.mockImplementation(async (_prompt, _options, _runtime, deps) => {
      await Promise.resolve();
      current = false;
      deps.assertSourceCurrent?.();
      effectCount += 1;
      return { exitCode: 0 };
    });
    await expect(
      triageCommand(
        createTriageRuntime(),
        {},
        {
          signal: controller.signal,
          assertCurrent: () => {
            if (!current) {
              throw new Error("repair claim lost");
            }
          },
          failure: {
            kind: "update",
            phase: "build",
            error: "original failure",
            gateway: "preserve",
          },
        },
      ),
    ).rejects.toThrow("repair claim lost");
    expect(controller.signal.aborted).toBe(false);
    expect(effectCount).toBe(0);
  });

  it.each(["nested", "codex-shell", "external", "cancelled"])(
    "does not auto-triage %s commands",
    async (kind) => {
      vi.stubEnv("OPENCLAW_SHELL", kind === "nested" ? "exec" : "");
      vi.stubEnv("CODEX_THREAD_ID", kind === "codex-shell" ? "synthetic-thread" : "");
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", kind === "external" ? "external" : "");
      const signal = AbortSignal.abort();
      await triageAfterFailure(
        createTriageRuntime(),
        {
          kind: "gateway-startup",
          phase: "startup",
          error: "failed",
          gateway: "verify-running",
        },
        kind === "cancelled" ? signal : undefined,
      );
      expect(mocks.collectDoctorFindings).not.toHaveBeenCalled();
      expect(mocks.agentExecCommand).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "retains a private manual handoff when no agent can run (configured=%s)",
    async (configured) => {
      if (configured) {
        await fs.writeFile(
          path.join(stateDir, "openclaw.json"),
          JSON.stringify({ agents: { defaults: { model: "openai/gpt-5.6-luna" } } }),
        );
        mocks.agentExecCommand.mockRejectedValue(new Error("Authentication required"));
      }
      const runtime = createTriageRuntime();
      await triageCommand(
        runtime,
        {},
        {
          signal: new AbortController().signal,
          assertCurrent: vi.fn(),
          failure: {
            kind: "update",
            phase: "build",
            error: "original build failure",
            gateway: "preserve",
          },
        },
      ).catch((error: unknown) =>
        runtime.error(error instanceof Error ? error.message : String(error)),
      );
      const output = [...runtime.error.mock.calls, ...runtime.log.mock.calls].flat().join("\n");
      expect(output).toContain(
        configured ? "Authentication required" : "No configured embedded agent",
      );
      expect(output).toContain("openclaw triage --run");
      expect(output).toContain("codex exec --skip-git-repo-check - <");
      const promptFile = (await fs.readdir(path.join(stateDir, "logs/support"))).find((file) =>
        file.endsWith(".md"),
      );
      expect(await fs.readFile(path.join(stateDir, "logs/support", promptFile!), "utf8")).toContain(
        "original build failure",
      );
      expect(mocks.agentExecCommand).toHaveBeenCalledTimes(configured ? 1 : 0);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("keeps unsupported managed recovery diagnostic-only", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.gateway");
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: "openai/gpt-5.6-luna" } } }),
    );
    mocks.agentExecCommand.mockResolvedValue({ exitCode: 0 });
    const runtime = createTriageRuntime();

    await triageAfterFailure(runtime, {
      kind: "gateway-startup",
      phase: "startup",
      error: "certificate failed",
      gateway: "verify-running",
    });

    expect(mocks.agentExecCommand).not.toHaveBeenCalled();
    expect(runtime.error.mock.calls.flat().join("\n")).toContain("manual");
  });

  it.each([
    { agent: "claude", exitCode: 0 },
    { agent: "claude", exitCode: 17 },
    { agent: "codex", exitCode: 0 },
    { agent: "codex", exitCode: 17 },
  ])(
    "preserves external $agent exit $exitCode without certifying descendant cleanup",
    async ({ agent, exitCode }) => {
      if (process.platform === "win32") {
        return;
      }
      const executablePath = path.join(stateDir, agent);
      const targetPath = path.join(stateDir, "headless-target.json");
      await fs.writeFile(
        executablePath,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(targetPath)}, JSON.stringify([process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_CONFIG_PATH, process.env.OPENCLAW_WORKSPACE_DIR])); let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { console.log(JSON.stringify({ args: process.argv.slice(2), shell: process.env.OPENCLAW_SHELL, hasPrompt: input.includes('original symptom') })); console.error('Diagnostic detail '.repeat(200) + '\\n${exitCode ? "Authentication required" : "Repair completed"}'); process.exitCode = ${exitCode}; });\n`,
        { mode: 0o700 },
      );
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      mocks.spawn.mockImplementation(actual.spawn);
      mocks.resolveExecutablePath.mockImplementation((binary) =>
        binary === agent ? executablePath : undefined,
      );
      const runtime = createTriageRuntime();
      const cleanup = createAgentCleanupScope();
      const result = cleanup.run(() =>
        triageCommand(
          runtime,
          {},
          {
            signal: new AbortController().signal,
            assertCurrent: vi.fn(),
            failure: {
              kind: "gateway-startup",
              phase: "startup",
              error: "failed",
              gateway: "verify-running",
            },
          },
        ),
      );
      if (exitCode) {
        await expect(result).rejects.toMatchObject({ code: exitCode });
      } else {
        await result;
      }
      expect(cleanup.outcome).toBe("uncertain");
      const output = [...runtime.error.mock.calls, ...runtime.log.mock.calls].flat().join("\n");
      expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual([
        stateDir,
        path.join(stateDir, "openclaw.json"),
        path.join(stateDir, "workspace"),
      ]);
      expect(output).toContain('"shell":"exec"');
      expect(output).toContain('"hasPrompt":true');
      expect(output).toContain(
        agent === "claude"
          ? '"args":["--safe-mode","-p"]'
          : '"args":["exec","--skip-git-repo-check","-"]',
      );
      if (exitCode) {
        expect(output).toContain("Authentication required");
        expect(output).toContain("17");
        expect(output).toContain("Run manually:");
        expect(runtime.exit).toHaveBeenCalledWith(exitCode);
      } else {
        expect(output).toContain("Repair completed");
        expect(runtime.exit).not.toHaveBeenCalled();
      }
      expect(runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it("cancels a headless child before returning to the failure owner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const executablePath = path.join(stateDir, "claude");
    const pidPath = path.join(stateDir, "child.pid");
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    mocks.spawn.mockImplementation(actual.spawn);
    mocks.resolveExecutablePath.mockImplementation((binary) =>
      binary === "claude" ? executablePath : undefined,
    );
    const controller = new AbortController();
    const result = triageCommand(
      createTriageRuntime(),
      {},
      {
        signal: controller.signal,
        assertCurrent: vi.fn(),
        failure: {
          kind: "gateway-startup",
          phase: "startup",
          error: "failed",
          gateway: "verify-running",
        },
      },
    );
    let pid = 0;
    try {
      await vi.waitFor(async () => {
        pid = Number(await fs.readFile(pidPath, "utf8"));
        expect(pid).toBeGreaterThan(0);
      });
    } finally {
      controller.abort();
      await expect(result).rejects.toMatchObject({ code: 1 });
    }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(process.env.OPENCLAW_SHELL).toBe("");
  });

  it("writes one stable JSON handoff without probing inference or starting an agent", async () => {
    const findings: HealthFinding[] = [
      { checkId: "core/error", severity: "error", message: "broken" },
      { checkId: "core/warning", severity: "warning", message: "warn" },
      { checkId: "core/info", severity: "info", message: "detail" },
    ];
    mocks.collectDoctorFindings.mockResolvedValue(findings);
    const runtime = createTriageRuntime();

    await triageCommand(runtime, { json: true, noExport: true });

    const promptPath = runtime.writeJson.mock.calls[0]?.[0]?.promptPath as string;
    const targetEnv = `env OPENCLAW_STATE_DIR='${stateDir}' OPENCLAW_CONFIG_PATH='${path.join(stateDir, "openclaw.json")}' OPENCLAW_WORKSPACE_DIR='${path.join(stateDir, "workspace")}'`;
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
              expect.stringContaining("| & opencode run"),
              expect.stringContaining("| & pi --print"),
              expect.stringContaining("& openclaw triage --run"),
            ]
          : [
              `${targetEnv} claude -p < '${promptPath}'`,
              `${targetEnv} codex exec --skip-git-repo-check - < '${promptPath}'`,
              `${targetEnv} opencode run < '${promptPath}'`,
              `${targetEnv} pi --print < '${promptPath}'`,
              `${targetEnv} openclaw triage --run`,
            ],
    });
    expect(await fs.readFile(promptPath, "utf8")).toContain("[error] core/error: broken");
    expect(mocks.callGatewayFromCliWithTransport).not.toHaveBeenCalled();
    expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
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
      for (const command of ["claude", "codex", "opencode", "pi", "openclaw"]) {
        await fs.writeFile(
          path.join(bin, command),
          `#!/bin/sh\nprintf "%s\\n" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_WORKSPACE_DIR"\n${command === "openclaw" ? "" : "cat\n"}`,
          { mode: 0o700 },
        );
      }
      const runtime = createTriageRuntime();
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
          `${originalState}\n${configPath}\n${defaultWorkspaceDir}\n${index < 4 ? prompt : ""}`,
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
    const runtime = createTriageRuntime();

    await triageCommand(runtime, { json: true, noExport: true });

    expect(runtime.writeJson.mock.calls[0]?.[0]).toMatchObject({ detectedAgents: ["codex"] });
    expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves manual non-TTY semantics (run=%s)", async (run) => {
    await withTriageTerminal(false, async () => {
      const invocation = triageCommand(createTriageRuntime(), { noExport: true, run });
      if (run) {
        await expect(invocation).rejects.toThrow("requires an interactive terminal");
      } else {
        await invocation;
      }
    });
    expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    expect(mocks.agentExecCommand).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("degrades to a sanitized prompt when the diagnostics export fails", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    mocks.callGatewayFromCliWithTransport.mockResolvedValue({ ok: true });
    mocks.writeDiagnosticSupportExport.mockRejectedValue(
      new Error(
        `Gateway unreachable: Config: ${stateDir}/openclaw.json; Authorization: Bearer ${secret}`,
      ),
    );
    const runtime = createTriageRuntime();

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
      const runtime = createTriageRuntime();
      const updateResult = path.join(stateDir, "failed-update.json");
      await fs.writeFile(
        updateResult,
        JSON.stringify({ error: `Original update failed at ${stateDir}; token=${secret}` }),
      );

      await withTriageTerminal(true, async () => {
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
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    },
  );

  it("keeps the saved failed-update handoff usable after its temporary input is removed", async () => {
    const inputPath = path.join(stateDir, "temporary-update-result.json");
    const secret = "sk-test-update-triage-secret-1234567890";
    await fs.writeFile(
      inputPath,
      JSON.stringify({ error: `Original update failed token=${secret}` }),
    );
    const runtime = createTriageRuntime();
    await triageCommand(runtime, { json: true, noExport: true, updateResult: inputPath });
    const report = runtime.writeJson.mock.calls[0]?.[0] as { suggestedCommands: string[] };
    const savedArgument = report.suggestedCommands
      .at(-1)
      ?.match(/ --update-result (?:'([^']+)'|(\S+))/u);
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
    const runtime = createTriageRuntime();

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
    const runtime = createTriageRuntime();

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

  it.each([false, true])(
    "does not start a closed recovery after writing its prompt (embedded=%s)",
    async (run) => {
      mocks.resolveExecutablePath.mockImplementation((agent: string) =>
        agent === "claude" ? "/usr/local/bin/claude" : undefined,
      );
      let current = true;
      const writeFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await writeFile(...args);
        if (typeof args[0] === "string" && args[0].includes("openclaw-triage-prompt-")) {
          current = false;
        }
      });
      const runtime = createTriageRuntime();
      await withTriageTerminal(true, () =>
        triageCommand(runtime, {
          run,
          recovery: {
            target: resolveInstallationTarget(),
            updateFailure: { error: "Captured update failure" },
            isCurrent: () => current,
          },
        }),
      );
      expect(current).toBe(false);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
      expect(runtime.log).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each(["current", "PATH"])(
    "launches a recognized Windows npm agent shim with a literal prompt using %s Node",
    async (nodeSource) => {
      const binDir = path.join(stateDir, "Windows npm bins");
      const entrypoint = path.join(binDir, "agent.cjs");
      const shimPath = path.join(binDir, "claude.cmd");
      const pathNode = path.join(binDir, "node.exe");
      const currentNode = process.execPath;
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(entrypoint, "", "utf8");
      await fs.writeFile(pathNode, "", "utf8");
      await fs.writeFile(
        shimPath,
        [
          "@ECHO off",
          "GOTO start",
          ":find_dp0",
          "SET dp0=%~dp0",
          "EXIT /b",
          ":start",
          "SETLOCAL",
          "CALL :find_dp0",
          'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\agent.cjs" %*',
          "",
        ].join("\r\n"),
        "utf8",
      );
      const executablePaths = await vi.importActual<typeof import("../infra/executable-path.js")>(
        "../infra/executable-path.js",
      );
      mocks.resolveExecutablePath.mockImplementation(executablePaths.resolveExecutablePath);
      mocks.collectDoctorFindings.mockResolvedValue([
        { checkId: "core/repair", severity: "error", message: 'Repair A&B at 100%: ! "quoted"' },
      ]);
      vi.stubEnv("PATH", binDir);
      vi.stubEnv("PATHEXT", ".EXE;.CMD;.BAT");
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      vi.spyOn(process, "execPath", "get").mockReturnValue(
        nodeSource === "current" ? currentNode : path.join(binDir, "openclaw.exe"),
      );
      const runtime = createTriageRuntime();

      await withTriageTerminal(true, () => triageCommand(runtime, { noExport: true }));

      expect(mocks.spawn).toHaveBeenCalledOnce();
      const [command, argv, options] = mocks.spawn.mock.calls[0] ?? [];
      const promptPath = String(runtime.log.mock.calls[0]?.[0]).replace("Debugging prompt: ", "");
      const prompt = await fs.readFile(promptPath, "utf8");
      expect(prompt).toContain('Repair A&B at 100%: ! "quoted"');
      expect(prompt).toContain("\n");
      expect(command).toBe(nodeSource === "current" ? currentNode : pathNode);
      expect(argv).toEqual([entrypoint, prompt]);
      expect(options?.stdio).toBe("inherit");
      expect(options?.shell).not.toBe(true);
      expect(options?.windowsHide).not.toBe(true);
      expect(options?.env.OPENCLAW_STATE_DIR).toBe(stateDir);
      expect(options?.env.OPENCLAW_CONFIG_PATH).toBe(path.join(stateDir, "openclaw.json"));
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each([
    { agent: "claude", executablePath: "C:\\tools\\claude.cmd" },
    { agent: "codex", executablePath: "C:\\tools\\codex.BAT" },
  ])(
    "keeps unresolved Windows $agent wrappers as executable PowerShell manual handoffs",
    async ({ agent, executablePath }) => {
      const configPath = path.join(stateDir, "operator's $config`file.json");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mocks.resolveExecutablePath.mockImplementation((binary: string) =>
        binary === agent ? executablePath : undefined,
      );
      const runtime = createTriageRuntime();

      await withTriageTerminal(true, () => triageCommand(runtime, { noExport: true }));

      const commands = runtime.log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("  "));
      expect(commands).toHaveLength(5);
      for (const command of commands) {
        expect(command).not.toMatch(/^ {2}env /u);
        expect(command).toContain(`'${configPath.replaceAll("'", "''")}'`);
      }
      expect(commands[0]).toContain("| & claude -p");
      expect(commands[1]).toContain("| & codex exec --skip-git-repo-check -");
      expect(commands[1]).toContain("Get-Content -Raw -Encoding UTF8 -LiteralPath ");
      expect(commands[2]).toContain("| & opencode run");
      expect(commands[3]).toContain("| & pi --print");
      expect(commands[4]).toContain("& openclaw triage --run");
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
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", exitCode, null));
      return child;
    });
    const runtime = createTriageRuntime();

    await withTriageTerminal(true, async () => {
      if (exitCode === 0) {
        await triageCommand(runtime, { noExport: true });
      } else {
        await expect(triageCommand(runtime, { noExport: true })).rejects.toMatchObject({
          code: exitCode,
        });
      }
    });

    const promptPath = String(runtime.log.mock.calls[0]?.[0]).replace("Debugging prompt: ", "");
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
    expect(mocks.runUpdateRepairLoop).not.toHaveBeenCalled();
    if (exitCode === 0) {
      expect(runtime.exit).not.toHaveBeenCalled();
    } else {
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
    }
  });

  it("reports a failed launch without trying another installed agent", async () => {
    mocks.resolveExecutablePath.mockImplementation((binary: string) => `/usr/local/bin/${binary}`);
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("permission denied")));
      return child;
    });
    const runtime = createTriageRuntime();

    await withTriageTerminal(true, async () => {
      await expect(triageCommand(runtime, { noExport: true })).rejects.toMatchObject({ code: 1 });
    });

    expect(mocks.spawn).toHaveBeenCalledOnce();
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
});
