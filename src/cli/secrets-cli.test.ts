import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSecretsCli } from "./secrets-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  const runtime = createCliRuntimeMock(vi);
  return {
    callGatewayFromCli: vi.fn(),
    runSecretsAudit: vi.fn(),
    resolveSecretsAuditExitCode: vi.fn(),
    runSecretsConfigureInteractive: vi.fn(),
    runSecretsApply: vi.fn(),
    confirm: vi.fn(),
    ...runtime,
  };
});

const {
  callGatewayFromCli,
  runSecretsAudit,
  resolveSecretsAuditExitCode,
  runSecretsConfigureInteractive,
  runSecretsApply,
  confirm,
  defaultRuntime,
  runtimeLogs,
  runtimeErrors,
} = mocks;

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (cmd: Command) => cmd,
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../secrets/audit.js", () => ({
  runSecretsAudit: (options: unknown) => mocks.runSecretsAudit(options),
  resolveSecretsAuditExitCode: (report: unknown, check: boolean) =>
    mocks.resolveSecretsAuditExitCode(report, check),
}));

vi.mock("../secrets/configure.js", () => ({
  runSecretsConfigureInteractive: (options: unknown) =>
    mocks.runSecretsConfigureInteractive(options),
}));

vi.mock("../secrets/apply.js", () => ({
  runSecretsApply: (options: unknown) => mocks.runSecretsApply(options),
}));

vi.mock("@clack/prompts", () => ({
  confirm: (options: unknown) => mocks.confirm(options),
}));

function createManualSecretsPlan() {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: "2026-02-26T00:00:00.000Z",
    generatedBy: "manual",
    targets: [],
  };
}

function createConfigureInteractiveResult(options?: {
  targets?: unknown[];
  changed?: boolean;
  resolvabilityComplete?: boolean;
}) {
  return {
    plan: {
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-02-26T00:00:00.000Z",
      generatedBy: "openclaw secrets configure",
      targets: options?.targets ?? [],
    },
    preflight: {
      mode: "dry-run" as const,
      changed: options?.changed ?? false,
      changedFiles: options?.changed ? ["/tmp/openclaw.json"] : [],
      checks: {
        resolvability: true,
        resolvabilityComplete: options?.resolvabilityComplete ?? true,
      },
      refsChecked: 0,
      skippedExecRefs: 0,
      warningCount: 0,
      warnings: [],
    },
  };
}

function createSecretsApplyResult(options?: {
  mode?: "dry-run" | "write";
  changed?: boolean;
  resolvabilityComplete?: boolean;
}) {
  return {
    mode: options?.mode ?? "dry-run",
    changed: options?.changed ?? false,
    changedFiles: options?.changed ? ["/tmp/openclaw.json"] : [],
    checks: {
      resolvability: true,
      resolvabilityComplete: options?.resolvabilityComplete ?? true,
    },
    refsChecked: 0,
    skippedExecRefs: 0,
    warningCount: 0,
    warnings: [],
  };
}

async function withPlanFile(run: (planPath: string) => Promise<void>) {
  const planPath = path.join(
    os.tmpdir(),
    `openclaw-secrets-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  await fs.writeFile(planPath, `${JSON.stringify(createManualSecretsPlan())}\n`, "utf8");
  try {
    await run(planPath);
  } finally {
    await fs.rm(planPath, { force: true });
  }
}

describe("secrets CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerSecretsCli(program);
    return program;
  };

  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockReset();
    runSecretsAudit.mockReset();
    resolveSecretsAuditExitCode.mockReset();
    runSecretsConfigureInteractive.mockReset();
    runSecretsApply.mockReset();
    confirm.mockReset();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("calls secrets.reload and prints human output", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 1 });
    await createProgram().parseAsync(["secrets", "reload"], { from: "user" });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "secrets.reload",
      expect.anything(),
      undefined,
      expect.objectContaining({ expectFinal: false }),
    );
    expect(runtimeLogs.at(-1)).toBe("Secrets reloaded with 1 warning(s).");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("prints JSON when requested", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 0 });
    await createProgram().parseAsync(["secrets", "reload", "--json"], { from: "user" });
    expect(runtimeLogs.at(-1)).toContain('"ok": true');
  });

  it("runs secrets audit and exits via check code", async () => {
    runSecretsAudit.mockResolvedValue({
      version: 1,
      status: "findings",
      filesScanned: [],
      summary: {
        plaintextCount: 1,
        unresolvedRefCount: 0,
        shadowedRefCount: 0,
        legacyResidueCount: 0,
      },
      resolution: {
        refsChecked: 0,
        skippedExecRefs: 0,
        resolvabilityComplete: true,
      },
      findings: [],
    });
    resolveSecretsAuditExitCode.mockReturnValue(1);

    await expect(
      createProgram().parseAsync(["secrets", "audit", "--check"], { from: "user" }),
    ).rejects.toBeTruthy();
    expect(runSecretsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        allowExec: false,
      }),
    );
    expect(resolveSecretsAuditExitCode).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("forwards --allow-exec to secrets audit", async () => {
    runSecretsAudit.mockResolvedValue({
      version: 1,
      status: "clean",
      filesScanned: [],
      summary: {
        plaintextCount: 0,
        unresolvedRefCount: 0,
        shadowedRefCount: 0,
        legacyResidueCount: 0,
      },
      resolution: {
        refsChecked: 1,
        skippedExecRefs: 0,
        resolvabilityComplete: true,
      },
      findings: [],
    });
    resolveSecretsAuditExitCode.mockReturnValue(0);

    await createProgram().parseAsync(["secrets", "audit", "--allow-exec"], { from: "user" });
    expect(runSecretsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        allowExec: true,
      }),
    );
  });

  it("runs secrets configure then apply when confirmed", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResult({
        changed: true,
        targets: [
          {
            type: "skills.entries.apiKey",
            path: "skills.entries.qa-secret-test.apiKey",
            pathSegments: ["skills", "entries", "qa-secret-test", "apiKey"],
            ref: {
              source: "env",
              provider: "default",
              id: "QA_SECRET_TEST_API_KEY",
            },
          },
        ],
      }),
    );
    confirm.mockResolvedValue(true);
    runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write", changed: true }));

    await createProgram().parseAsync(["secrets", "configure"], { from: "user" });
    expect(runSecretsConfigureInteractive).toHaveBeenCalled();
    expect(runSecretsApply).toHaveBeenCalledWith(
      expect.objectContaining({
        write: true,
        plan: expect.objectContaining({
          targets: expect.arrayContaining([
            expect.objectContaining({
              type: "skills.entries.apiKey",
              path: "skills.entries.qa-secret-test.apiKey",
            }),
          ]),
        }),
      }),
    );
    expect(runtimeLogs.at(-1)).toContain("Secrets applied");
  });

  it("forwards --agent to secrets configure", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(createConfigureInteractiveResult());
    confirm.mockResolvedValue(false);

    await createProgram().parseAsync(["secrets", "configure", "--agent", "ops"], { from: "user" });
    expect(runSecretsConfigureInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        allowExecInPreflight: false,
      }),
    );
  });

  it("forwards --allow-exec to secrets apply dry-run", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult());

      await createProgram().parseAsync(
        ["secrets", "apply", "--from", planPath, "--dry-run", "--allow-exec"],
        {
          from: "user",
        },
      );
      expect(runSecretsApply).toHaveBeenCalledWith(
        expect.objectContaining({
          write: false,
          allowExec: true,
        }),
      );
    });
  });

  it("forwards --allow-exec to secrets apply write mode", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write" }));

      await createProgram().parseAsync(["secrets", "apply", "--from", planPath, "--allow-exec"], {
        from: "user",
      });
      expect(runSecretsApply).toHaveBeenCalledWith(
        expect.objectContaining({
          write: true,
          allowExec: true,
        }),
      );
    });
  });

  it("does not print skipped-exec note when apply dry-run skippedExecRefs is zero", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult({ resolvabilityComplete: false }));

      await createProgram().parseAsync(["secrets", "apply", "--from", planPath, "--dry-run"], {
        from: "user",
      });
      expect(runtimeLogs.some((line) => line.includes("Secrets apply dry-run note: skipped"))).toBe(
        false,
      );
    });
  });

  it("does not print skipped-exec note when configure preflight skippedExecRefs is zero", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResult({ resolvabilityComplete: false }),
    );
    confirm.mockResolvedValue(false);

    await createProgram().parseAsync(["secrets", "configure"], { from: "user" });
    expect(runtimeLogs.some((line) => line.includes("Preflight note: skipped"))).toBe(false);
  });

  it("forwards --allow-exec to configure preflight and apply", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(createConfigureInteractiveResult());
    runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write" }));

    await createProgram().parseAsync(["secrets", "configure", "--apply", "--yes", "--allow-exec"], {
      from: "user",
    });
    expect(runSecretsConfigureInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        allowExecInPreflight: true,
      }),
    );
    expect(runSecretsApply).toHaveBeenCalledWith(
      expect.objectContaining({
        write: true,
        allowExec: true,
      }),
    );
  });
});
