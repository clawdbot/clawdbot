// Triage tests protect bounded prompts, sanitized handoffs, and embedded-run gating.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthFinding } from "../flows/health-checks.js";
import { renderTriagePrompt } from "./triage-prompt.js";
import { triageCommand } from "./triage.js";

const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  callGatewayFromCliWithTransport: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  gatherDaemonStatus: vi.fn(),
  verifySetupInference: vi.fn(),
  agentExecCommand: vi.fn(),
}));

vi.mock("./doctor-lint.js", () => ({
  collectDoctorFindings: mocks.collectDoctorFindings,
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
      bundle: { kind: "available", path: "/tmp/openclaw-diagnostics.zip" },
    });

    expect(prompt.indexOf("[error]")).toBeLessThan(prompt.indexOf("[warning]"));
    expect(prompt.indexOf("[warning]")).toBeLessThan(prompt.indexOf("[info]"));
    expect(prompt).toContain("Fix: Run `openclaw doctor --fix`.");
    expect(prompt).toContain("Sanitized ZIP: /tmp/openclaw-diagnostics.zip");
    expect(prompt).toContain("secrets, tokens, raw chat payloads, and raw logs are excluded");
  });

  it("hard-bounds multibyte findings and explicitly reports omitted findings", () => {
    const findings: HealthFinding[] = Array.from({ length: 25 }, (_, index) => ({
      checkId: `core/check-${index}`,
      severity: "warning",
      message: "🦞".repeat(4_000),
      fixHint: "修".repeat(4_000),
    }));

    const prompt = renderTriagePrompt({ findings, bundle: { kind: "skipped" } });

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(prompt).toContain("15 more findings omitted; run `openclaw doctor` for the full list.");
    expect(prompt).not.toContain("\uFFFD");
    expect(prompt).toContain("...");
  });

  it.each([
    {
      bundle: { kind: "unavailable" as const, reason: "Gateway unreachable" },
      text: "Diagnostics export unavailable: Gateway unreachable",
    },
    {
      bundle: { kind: "skipped" as const },
      text: "Diagnostics export skipped with `--no-export`.",
    },
  ])("explains absent diagnostics archives: $text", ({ bundle, text }) => {
    expect(renderTriagePrompt({ findings: [], bundle })).toContain(text);
  });
});

describe("triageCommand", () => {
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-triage-test-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    mocks.collectDoctorFindings.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
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
    expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual({
      promptPath,
      bundlePath: null,
      bundleError: null,
      findings: { error: 1, warning: 1, info: 1 },
      suggestedCommands: [
        `claude "$(cat '${promptPath}')"`,
        `codex exec - < '${promptPath}'`,
        "openclaw triage --run",
      ],
    });
    expect(await fs.readFile(promptPath, "utf8")).toContain("[error] core/error: broken");
    expect(mocks.callGatewayFromCliWithTransport).not.toHaveBeenCalled();
    expect(mocks.verifySetupInference).not.toHaveBeenCalled();
    expect(mocks.agentExecCommand).not.toHaveBeenCalled();
  });

  it("degrades to a sanitized prompt when the Gateway cannot provide diagnostics", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    mocks.callGatewayFromCliWithTransport.mockRejectedValue(
      new Error(`Gateway unreachable: Authorization: Bearer ${secret}`),
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
    expect(report.bundleError).not.toContain(secret);
    expect(await fs.readFile(report.promptPath, "utf8")).toContain(
      "Diagnostics export unavailable: Gateway unreachable",
    );
    expect(mocks.writeDiagnosticSupportExport).not.toHaveBeenCalled();
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

    expect(runtime.writeJson.mock.calls[0]?.[0]).toMatchObject({ bundlePath, bundleError: null });
    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: { timeout: "3000", json: true },
      probe: true,
      requireRpc: false,
      deep: false,
    });
  });

  it("refuses embedded execution when the live inference probe fails", async () => {
    mocks.verifySetupInference.mockResolvedValue({
      ok: false,
      status: "auth",
      error: "The configured model is unavailable",
    });
    const runtime = createRuntime();

    await withInteractiveTerminal(async () => {
      await expect(triageCommand(runtime, { noExport: true, run: true })).rejects.toThrow(
        "Run `openclaw onboard` or use a suggested handoff command.",
      );
    });

    expect(mocks.verifySetupInference).toHaveBeenCalledWith({ runtime, timeoutMs: 15_000 });
    expect(mocks.agentExecCommand).not.toHaveBeenCalled();
  });

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
});
