// Secrets CLI tests cover secret command registration, reads, writes, and redaction.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectObjectFields,
  mockCall,
  mockFirstObjectArg,
} from "../test-utils/mock-call-assertions.js";
import { registerSecretsCli } from "./secrets-cli.js";

const execFileAsync = promisify(execFile);

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

function createConfigureInteractiveResultWithPlanBytes(bytes: number) {
  const configured = createConfigureInteractiveResult({
    targets: [
      {
        type: "models.providers.apiKey",
        path: "models.providers.openai.apiKey",
        pathSegments: ["models", "providers", "openai", "apiKey"],
        ref: {
          source: "file",
          provider: "default",
          id: "",
        },
        providerId: "openai",
      },
    ],
  });
  const target = configured.plan.targets[0] as { ref: { id: string } };
  const emptyBytes = Buffer.byteLength(`${JSON.stringify(configured.plan, null, 2)}\n`, "utf8");
  target.ref.id = "x".repeat(bytes - emptyBytes);
  expect(Buffer.byteLength(`${JSON.stringify(configured.plan, null, 2)}\n`, "utf8")).toBe(bytes);
  return configured;
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

async function withPlanFile(
  run: (planPath: string) => Promise<void>,
  contents = `${JSON.stringify(createManualSecretsPlan())}\n`,
) {
  const planPath = path.join(
    os.tmpdir(),
    `openclaw-secrets-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  await fs.writeFile(planPath, contents, "utf8");
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
    const reloadCall = mockCall(callGatewayFromCli);
    expect(reloadCall[0]).toBe("secrets.reload");
    if (reloadCall[1] === undefined) {
      throw new Error("Expected secrets.reload params");
    }
    expect(reloadCall[2]).toBeUndefined();
    expectObjectFields(reloadCall[3], { expectFinal: false });
    expect(runtimeLogs.at(-1)).toBe("Secrets reloaded with 1 warning(s).");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("prints JSON when requested", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true, warningCount: 0 });
    await createProgram().parseAsync(["secrets", "reload", "--json"], { from: "user" });
    expect(runtimeLogs.at(-1)).toContain('"ok": true');
  });

  it("explains Gateway reload failures without duplicate doctor noise", async () => {
    callGatewayFromCli.mockRejectedValue(
      new Error(
        "gateway closed (1006 abnormal closure). Gateway target: ws://127.0.0.1:18789 Source: local loopback Config: /tmp/openclaw.json Bind: loopback Possible causes: - Gateway not yet ready. Run `openclaw doctor` for diagnostics.",
      ),
    );

    await expect(
      createProgram().parseAsync(["secrets", "reload"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Could not reload secrets because the Gateway did not respond: gateway closed (1006 abnormal closure).",
    );
    expect(runtimeErrors.at(-1)).toContain("openclaw gateway status --deep");
    expect(runtimeErrors.at(-1)).not.toContain("Gateway target:");
    expect(runtimeErrors.at(-1)).not.toContain("diagnostics..");
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
    ).rejects.toThrow("__exit__:2");
    expect(mockFirstObjectArg(runSecretsAudit).allowExec).toBe(false);
    const exitCodeCall = mockCall(resolveSecretsAuditExitCode);
    if (exitCodeCall[0] === undefined) {
      throw new Error("Expected secrets audit result for exit-code resolution");
    }
    expect(exitCodeCall[1]).toBe(true);
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
    expect(mockFirstObjectArg(runSecretsAudit).allowExec).toBe(true);
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
    expect(runSecretsConfigureInteractive).toHaveBeenCalledTimes(1);
    const applyArgs = mockFirstObjectArg(runSecretsApply);
    expect(applyArgs.write).toBe(true);
    if (!applyArgs.plan || typeof applyArgs.plan !== "object") {
      throw new Error("expected apply plan object");
    }
    const applyPlan = applyArgs.plan as { targets?: unknown[] };
    expect(Array.isArray(applyPlan.targets)).toBe(true);
    const [target] = applyPlan.targets ?? [];
    expectObjectFields(target, {
      type: "skills.entries.apiKey",
      path: "skills.entries.qa-secret-test.apiKey",
    });
    expect(runtimeLogs.at(-1)).toContain("Secrets applied");
  });

  it("emits one JSON document when --yes applies configure output", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(createConfigureInteractiveResult());
    runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write", changed: true }));

    await createProgram().parseAsync(["secrets", "configure", "--json", "--yes"], {
      from: "user",
    });

    expect(runSecretsApply).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(mockFirstObjectArg(defaultRuntime.writeJson)).toEqual(
      createSecretsApplyResult({ mode: "write", changed: true }),
    );
  });

  it("shows the irreversibility warning on the interactive apply path (#83883)", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResult({ changed: true }),
    );
    // Interactive path: no --apply flag. First confirm is "Apply this plan
    // now?", second must be the one-way-migration irreversibility warning.
    confirm.mockResolvedValueOnce(true); // Apply this plan now?
    confirm.mockResolvedValueOnce(true); // one-way migration warning
    runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write", changed: true }));

    await createProgram().parseAsync(["secrets", "configure"], { from: "user" });

    // Before the fix the interactive path skipped the irreversibility prompt
    // (it checked opts.apply), so confirm was called only once.
    expect(confirm).toHaveBeenCalledTimes(2);
    const secondPrompt = confirm.mock.calls[1]?.[0] as { message?: string } | undefined;
    expect(secondPrompt?.message ?? "").toContain("one-way");
    expect(runSecretsApply).toHaveBeenCalledTimes(1);
  });

  it("cancels apply when the interactive irreversibility warning is declined (#83883)", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResult({ changed: true }),
    );
    confirm.mockResolvedValueOnce(true); // Apply this plan now?
    confirm.mockResolvedValueOnce(false); // decline the irreversibility warning

    await createProgram().parseAsync(["secrets", "configure"], { from: "user" });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(runSecretsApply).not.toHaveBeenCalled();
    expect(runtimeLogs.at(-1)).toContain("Apply cancelled");
  });

  it("forwards --agent to secrets configure", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(createConfigureInteractiveResult());
    confirm.mockResolvedValue(false);

    await createProgram().parseAsync(["secrets", "configure", "--agent", "ops"], { from: "user" });
    expectObjectFields(mockFirstObjectArg(runSecretsConfigureInteractive), {
      agentId: "ops",
      allowExecInPreflight: false,
    });
  });

  it("writes generated secrets plan files at the apply limit", async () => {
    const planPath = path.join(
      os.tmpdir(),
      `openclaw-secrets-configure-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResultWithPlanBytes(16 * 1024 * 1024),
    );
    confirm.mockResolvedValue(false);

    try {
      await createProgram().parseAsync(["secrets", "configure", "--plan-out", planPath], {
        from: "user",
      });

      expect((await fs.stat(planPath)).size).toBe(16 * 1024 * 1024);
      expect(runtimeLogs).toContain(`Plan written to ${planPath}`);
      expect(runSecretsApply).not.toHaveBeenCalled();
    } finally {
      await fs.rm(planPath, { force: true });
    }
  });

  it("rejects generated secrets plan files that exceed the apply limit", async () => {
    const planPath = path.join(
      os.tmpdir(),
      `openclaw-secrets-configure-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResultWithPlanBytes(16 * 1024 * 1024 + 1),
    );

    try {
      await expect(
        createProgram().parseAsync(["secrets", "configure", "--plan-out", planPath], {
          from: "user",
        }),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.at(-1)).toContain("Secrets plan exceeds 16777216 bytes");
      await expect(fs.access(planPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(confirm).not.toHaveBeenCalled();
      expect(runSecretsApply).not.toHaveBeenCalled();
    } finally {
      await fs.rm(planPath, { force: true });
    }
  });

  it("rejects oversized secrets plan files before parsing", async () => {
    await withPlanFile(async (planPath) => {
      await fs.truncate(planPath, 16 * 1024 * 1024 + 1);
      await expect(
        createProgram().parseAsync(["secrets", "apply", "--from", planPath, "--dry-run"], {
          from: "user",
        }),
      ).rejects.toThrow("__exit__:1");

      expect(runSecretsApply).not.toHaveBeenCalled();
      expect(runtimeErrors.at(-1)).toContain("Secrets plan file exceeds 16777216 bytes");
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFO secrets plan paths without blocking",
    async () => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult());
      await withPlanFile(async (planPath) => {
        await createProgram().parseAsync(["secrets", "apply", "--from", planPath, "--dry-run"], {
          from: "user",
        });
      });
      runSecretsApply.mockReset();
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-cli-fifo-"));
      const fifoPath = path.join(tmpDir, "plan.json");
      await execFileAsync("mkfifo", [fifoPath]);

      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      const parse = createProgram().parseAsync(
        ["secrets", "apply", "--from", fifoPath, "--dry-run"],
        { from: "user" },
      );

      try {
        await expect(
          Promise.race([
            parse,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                timedOut = true;
                reject(new Error("Timed out waiting for FIFO plan rejection"));
              }, 1_000);
            }),
          ]),
        ).rejects.toThrow("__exit__:1");

        expect(runSecretsApply).not.toHaveBeenCalled();
        expect(runtimeErrors.at(-1)).toContain("Secrets plan path is not a regular file");
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (timedOut) {
          const releaseWriter = execFileAsync("sh", ["-c", 'printf x > "$1"', "sh", fifoPath]);
          await Promise.allSettled([parse, releaseWriter]);
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("forwards --allow-exec to secrets apply dry-run", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult());

      await createProgram().parseAsync(
        ["secrets", "apply", "--from", planPath, "--dry-run", "--allow-exec"],
        {
          from: "user",
        },
      );
      expectObjectFields(mockFirstObjectArg(runSecretsApply), {
        write: false,
        allowExec: true,
      });
    });
  });

  it("forwards --allow-exec to secrets apply write mode", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write" }));

      await createProgram().parseAsync(["secrets", "apply", "--from", planPath, "--allow-exec"], {
        from: "user",
      });
      expectObjectFields(mockFirstObjectArg(runSecretsApply), {
        write: true,
        allowExec: true,
      });
    });
  });

  it("shows a user-friendly error when the secrets plan file is malformed JSON", async () => {
    await withPlanFile(async (planPath) => {
      await expect(
        createProgram().parseAsync(["secrets", "apply", "--from", planPath], { from: "user" }),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.at(-1)).toContain(`Malformed JSON in secrets plan file: ${planPath}`);
      expect(runSecretsApply).not.toHaveBeenCalled();
    }, "{invalid json");
  });

  it("rejects --from when the plan file does not exist", async () => {
    await expect(
      createProgram().parseAsync(["secrets", "apply", "--from", "/nonexistent/path/plan.json"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    const errorOutput = runtimeErrors.join("\n");
    expect(errorOutput).toContain("Secrets plan file not found: /nonexistent/path/plan.json");
    expect(errorOutput).not.toContain("ENOENT");
    expect(runSecretsApply).not.toHaveBeenCalled();
  });

  it("preserves causes for unrelated apply errors with a similar message", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockRejectedValueOnce(
        new Error("Secrets plan file not found during apply", {
          cause: new Error("provider diagnostic"),
        }),
      );

      await expect(
        createProgram().parseAsync(["secrets", "apply", "--from", planPath], { from: "user" }),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.join("\n")).toContain(
        "Secrets plan file not found during apply | provider diagnostic",
      );
    });
  });

  it("does not print skipped-exec note when apply dry-run skippedExecRefs is zero", async () => {
    await withPlanFile(async (planPath) => {
      runSecretsApply.mockResolvedValue(createSecretsApplyResult({ resolvabilityComplete: false }));

      await createProgram().parseAsync(["secrets", "apply", "--from", planPath, "--dry-run"], {
        from: "user",
      });
      const skippedExecNotes = runtimeLogs.filter((line) =>
        line.includes("Secrets apply dry-run note: skipped"),
      );
      expect(skippedExecNotes).toStrictEqual([]);
    });
  });

  it("does not print skipped-exec note when configure preflight skippedExecRefs is zero", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(
      createConfigureInteractiveResult({ resolvabilityComplete: false }),
    );
    confirm.mockResolvedValue(false);

    await createProgram().parseAsync(["secrets", "configure"], { from: "user" });
    const preflightSkippedExecNotes = runtimeLogs.filter((line) =>
      line.includes("Preflight note: skipped"),
    );
    expect(preflightSkippedExecNotes).toStrictEqual([]);
  });

  it("forwards --allow-exec to configure preflight and apply", async () => {
    runSecretsConfigureInteractive.mockResolvedValue(createConfigureInteractiveResult());
    runSecretsApply.mockResolvedValue(createSecretsApplyResult({ mode: "write" }));

    await createProgram().parseAsync(["secrets", "configure", "--apply", "--yes", "--allow-exec"], {
      from: "user",
    });
    expect(mockFirstObjectArg(runSecretsConfigureInteractive).allowExecInPreflight).toBe(true);
    expectObjectFields(mockFirstObjectArg(runSecretsApply), {
      write: true,
      allowExec: true,
    });
  });
});
