/** Tests node-host system.run policy, approval, allowlist, and execution behavior. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import {
  commitExecAuthorizationLocked,
  createExecApprovalPolicySnapshot,
  loadExecApprovals,
  resolveExecApprovalsPath,
  saveExecApprovals,
} from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { ExecHostResponse } from "../infra/exec-host.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";

type HandleSystemRunInvokeOptions = Parameters<typeof handleSystemRunInvoke>[0];

vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn: vi.fn(),
}));

type MockedRunCommand = Mock<HandleSystemRunInvokeOptions["runCommand"]>;
type MockedRunViaMacAppExecHost = Mock<HandleSystemRunInvokeOptions["runViaMacAppExecHost"]>;
type MockedSendInvokeResult = Mock<HandleSystemRunInvokeOptions["sendInvokeResult"]>;
type MockedSendExecFinishedEvent = Mock<HandleSystemRunInvokeOptions["sendExecFinishedEvent"]>;
type MockedSendNodeEvent = Mock<HandleSystemRunInvokeOptions["sendNodeEvent"]>;

describe("handleSystemRunInvoke mac app exec host routing", () => {
  let sharedFixtureRoot = "";
  let sharedOpenClawHome = "";
  let sharedRuntimeBinDir = "";
  let sharedFixtureId = 0;
  let previousOpenClawHome: string | undefined;
  const sharedRuntimeBins = new Set<string>();

  beforeAll(() => {
    sharedFixtureRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-host-fixtures-")),
    );
    sharedOpenClawHome = path.join(sharedFixtureRoot, "openclaw-home");
    sharedRuntimeBinDir = path.join(sharedFixtureRoot, "bin");
    fs.mkdirSync(sharedOpenClawHome, { recursive: true });
    fs.mkdirSync(sharedRuntimeBinDir, { recursive: true });
  });

  afterAll(() => {
    if (sharedFixtureRoot) {
      fs.rmSync(sharedFixtureRoot, { recursive: true, force: true });
    }
  });

  function createFixtureDir(prefix: string): string {
    const dir = path.join(sharedFixtureRoot, `${prefix}${sharedFixtureId++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = sharedOpenClawHome;
    fs.rmSync(resolveExecApprovalsPath(), { force: true });
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
  });

  function createLocalRunResult(stdout = "local-ok") {
    return {
      success: true,
      stdout,
      stderr: "",
      timedOut: false,
      truncated: false,
      exitCode: 0,
      error: null,
    };
  }

  function createTempExecutable(params: { dir: string; name: string }): string {
    const fileName = process.platform === "win32" ? `${params.name}.exe` : params.name;
    const executablePath = path.join(params.dir, fileName);
    fs.writeFileSync(executablePath, "");
    fs.chmodSync(executablePath, 0o755);
    return executablePath;
  }

  function createStrictInlineEvalApprovalPlan(prefix: string): SystemRunApprovalPlan {
    const tempDir = createFixtureDir(prefix);
    const executablePath = createTempExecutable({ dir: tempDir, name: "gawk" });
    const scriptPath = path.join(tempDir, "library.awk");
    fs.writeFileSync(scriptPath, "{ print }\n");
    const prepared = buildSystemRunApprovalPlan({
      command: [executablePath, "-f", scriptPath, '--source=BEGIN{print "safe"}'],
      sessionKey: "agent:main:main",
    });
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    return prepared.plan;
  }

  function bindCurrentPolicyToPlan(plan: SystemRunApprovalPlan): SystemRunApprovalPlan {
    return {
      ...plan,
      sessionKey: plan.sessionKey ?? "agent:main:main",
      policySnapshot: createExecApprovalPolicySnapshot({
        file: loadExecApprovals(),
        agentId: plan.agentId ?? undefined,
      }),
    };
  }

  function expectInvokeOk(
    sendInvokeResult: MockedSendInvokeResult,
    params?: { payloadContains?: string },
  ) {
    const result = requireInvokeResult(sendInvokeResult);
    expect(result.ok).toBe(true);
    if (params?.payloadContains) {
      expect(result.payloadJSON).toContain(params.payloadContains);
    }
  }

  function expectInvokeErrorMessage(
    sendInvokeResult: MockedSendInvokeResult,
    params: { message: string; exact?: boolean },
  ) {
    const result = requireInvokeResult(sendInvokeResult);
    expect(result.ok).toBe(false);
    const message = result.error?.message;
    if (params.exact) {
      expect(message).toBe(params.message);
    } else {
      expect(message).toContain(params.message);
    }
  }

  function requireInvokeResult(sendInvokeResult: MockedSendInvokeResult): {
    ok?: boolean;
    payloadJSON?: string;
    error?: { code?: string; message?: string };
  } {
    const result = firstMockCallArg(sendInvokeResult, "sendInvokeResult", 0);
    return result as {
      ok?: boolean;
      payloadJSON?: string;
      error?: { code?: string; message?: string };
    };
  }

  function requireFirstRunCommandArgs(runCommand: MockedRunCommand): string[] {
    return firstMockCallArg(vi.mocked(runCommand), "runCommand", 0) as string[];
  }

  function requireMacExecHostCall(runViaMacAppExecHost: MockedRunViaMacAppExecHost): {
    approvals?: { agent?: { security?: string; ask?: string } };
    request?: {
      command?: string[];
      rawCommand?: string;
      cwd?: string;
      approvalDecision?: string | null;
      approvalSource?: string | null;
      policySnapshot?: unknown;
    };
  } {
    const call = firstMockCallArg(runViaMacAppExecHost, "runViaMacAppExecHost", 0);
    return call as {
      approvals?: { agent?: { security?: string; ask?: string } };
      request?: {
        command?: string[];
        rawCommand?: string;
        cwd?: string;
        approvalDecision?: string | null;
        approvalSource?: string | null;
        policySnapshot?: unknown;
      };
    };
  }

  function firstMockCallArg(
    mock: { mock: { calls: readonly unknown[][] } },
    label: string,
    argIndex: number,
  ): unknown {
    const [call] = mock.mock.calls;
    if (!call) {
      throw new Error(`expected ${label} call`);
    }
    return call[argIndex];
  }

  function expectExecDeniedEvent(
    sendNodeEvent: MockedSendNodeEvent,
    reason = "approval-required",
  ): void {
    const call = sendNodeEvent.mock.calls[0];
    if (!call) {
      throw new Error("expected sendNodeEvent call");
    }
    expect(call[1]).toBe("exec.denied");
    expect((call[2] as { reason?: string }).reason).toBe(reason);
  }

  function expectApprovalRequiredDenied(params: {
    sendNodeEvent: MockedSendNodeEvent;
    sendInvokeResult: MockedSendInvokeResult;
  }) {
    expectExecDeniedEvent(params.sendNodeEvent);
    expectInvokeErrorMessage(params.sendInvokeResult, {
      message: "SYSTEM_RUN_DENIED: approval required",
      exact: true,
    });
  }

  function expectApprovalStateWriteDenied(params: {
    sendNodeEvent: MockedSendNodeEvent;
    sendInvokeResult: MockedSendInvokeResult;
  }) {
    expectExecDeniedEvent(params.sendNodeEvent, "approval-state-write-failed");
    expect(requireInvokeResult(params.sendInvokeResult)).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "SYSTEM_RUN_DENIED: approval state could not be persisted",
      },
    });
  }

  function createMutableScriptOperandFixture(tmp: string): {
    command: string[];
    scriptPath: string;
    initialBody: string;
    changedBody: string;
  } {
    if (process.platform === "win32") {
      const scriptPath = path.join(tmp, "run.js");
      return {
        command: [process.execPath, "./run.js"],
        scriptPath,
        initialBody: 'console.log("SAFE");\n',
        changedBody: 'console.log("PWNED");\n',
      };
    }
    const scriptPath = path.join(tmp, "run.sh");
    return {
      command: ["/bin/sh", "./run.sh"],
      scriptPath,
      initialBody: "#!/bin/sh\necho SAFE\n",
      changedBody: "#!/bin/sh\necho PWNED\n",
    };
  }

  function createRuntimeScriptOperandFixture(params: {
    tmp: string;
    runtime: "bun" | "deno" | "jiti" | "tsx";
  }): {
    command: string[];
    scriptPath: string;
    initialBody: string;
    changedBody: string;
  } {
    const scriptPath = path.join(params.tmp, "run.ts");
    const initialBody = 'console.log("SAFE");\n';
    const changedBody = 'console.log("PWNED");\n';
    switch (params.runtime) {
      case "bun":
        return {
          command: ["bun", "run", "./run.ts"],
          scriptPath,
          initialBody,
          changedBody,
        };
      case "deno":
        return {
          command: ["deno", "run", "-A", "--allow-read", "--", "./run.ts"],
          scriptPath,
          initialBody,
          changedBody,
        };
      case "jiti":
        return {
          command: ["jiti", "./run.ts"],
          scriptPath,
          initialBody,
          changedBody,
        };
      case "tsx":
        return {
          command: ["tsx", "./run.ts"],
          scriptPath,
          initialBody,
          changedBody,
        };
    }
    const unsupportedRuntime: never = params.runtime;
    throw new Error(`unsupported runtime fixture: ${String(unsupportedRuntime)}`);
  }

  function buildNestedEnvShellCommand(params: { depth: number; payload: string }): string[] {
    return [...Array(params.depth).fill("/usr/bin/env"), "/bin/sh", "-c", params.payload];
  }

  function createMacExecHostSuccess(stdout = "app-ok"): ExecHostResponse {
    return {
      ok: true,
      payload: {
        success: true,
        stdout,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        error: null,
      },
    };
  }

  function createAllowlistOnMissApprovals(params?: {
    autoAllowSkills?: boolean;
    agents?: Parameters<typeof saveExecApprovals>[0]["agents"];
  }): Parameters<typeof saveExecApprovals>[0] {
    return {
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
        ...(params?.autoAllowSkills ? { autoAllowSkills: true } : {}),
      },
      agents: params?.agents ?? {},
    };
  }

  function resolveProductionExecSecurity(value?: string): "deny" | "allowlist" | "full" {
    return value === "deny" || value === "allowlist" || value === "full" ? value : "allowlist";
  }

  function resolveProductionExecAsk(value?: string): "off" | "on-miss" | "always" {
    return value === "off" || value === "on-miss" || value === "always" ? value : "on-miss";
  }

  function createInvokeSpies(params?: { runCommand?: MockedRunCommand }): {
    runCommand: MockedRunCommand;
    sendInvokeResult: MockedSendInvokeResult;
    sendNodeEvent: MockedSendNodeEvent;
  } {
    return {
      runCommand: params?.runCommand ?? vi.fn(async () => createLocalRunResult()),
      sendInvokeResult: vi.fn(async () => {}),
      sendNodeEvent: vi.fn(async () => {}),
    };
  }

  async function withTempApprovalsHome<T>(params: {
    approvals: Parameters<typeof saveExecApprovals>[0];
    run: (ctx: { tempHome: string }) => Promise<T>;
  }): Promise<T> {
    const tempHome = sharedOpenClawHome;
    return await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
      saveExecApprovals(params.approvals);
      return await params.run({ tempHome });
    });
  }

  async function withPathTokenCommand<T>(params: {
    tmpPrefix: string;
    run: (ctx: { link: string; expected: string }) => Promise<T>;
  }): Promise<T> {
    const tmp = createFixtureDir(params.tmpPrefix);
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "poccmd");
    fs.symlinkSync("/bin/echo", link);
    const expected = fs.realpathSync(link);
    return await withEnvAsync({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }, () =>
      params.run({ link, expected }),
    );
  }

  async function withFakeRuntimeOnPath<T>(params: {
    runtime: "bun" | "deno" | "jiti" | "tsx";
    run: () => Promise<T>;
  }): Promise<T> {
    if (!sharedRuntimeBins.has(params.runtime)) {
      const runtimePath =
        process.platform === "win32"
          ? path.join(sharedRuntimeBinDir, `${params.runtime}.cmd`)
          : path.join(sharedRuntimeBinDir, params.runtime);
      const runtimeBody =
        process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
      fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
      if (process.platform !== "win32") {
        fs.chmodSync(runtimePath, 0o755);
      }
      sharedRuntimeBins.add(params.runtime);
    }
    return await withEnvAsync(
      { PATH: `${sharedRuntimeBinDir}${path.delimiter}${process.env.PATH ?? ""}` },
      () => params.run(),
    );
  }

  function expectCommandPinnedToCanonicalPath(params: {
    runCommand: MockedRunCommand;
    expected: string;
    commandTail: string[];
    cwd?: string;
  }) {
    expect(params.runCommand).toHaveBeenCalledWith(
      [params.expected, ...params.commandTail],
      params.cwd,
      undefined,
      undefined,
    );
  }

  function resolveStatTargetPath(target: string | Buffer | URL | number): string {
    if (typeof target === "string") {
      return path.resolve(target);
    }
    if (Buffer.isBuffer(target)) {
      return path.resolve(target.toString());
    }
    if (target instanceof URL) {
      return path.resolve(target.pathname);
    }
    return path.resolve(String(target));
  }

  async function withMockedCwdIdentityDrift<T>(params: {
    canonicalCwd: string;
    driftDir: string;
    stableHitsBeforeDrift?: number;
    run: () => Promise<T>;
  }): Promise<T> {
    const stableHitsBeforeDrift = params.stableHitsBeforeDrift ?? 2;
    const realStatSync = fs.statSync.bind(fs);
    const baselineStat = realStatSync(params.canonicalCwd);
    const driftStat = realStatSync(params.driftDir);
    let canonicalHits = 0;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const resolvedTarget = resolveStatTargetPath(args[0]);
      if (resolvedTarget === params.canonicalCwd) {
        canonicalHits += 1;
        if (canonicalHits > stableHitsBeforeDrift) {
          return driftStat;
        }
        return baselineStat;
      }
      return realStatSync(...args);
    });
    try {
      return await params.run();
    } finally {
      statSpy.mockRestore();
    }
  }

  async function runSystemInvoke(params: {
    preferMacAppExecHost: boolean;
    runViaResponse?: ExecHostResponse | null;
    command?: string[];
    env?: Record<string, string>;
    rawCommand?: string | null;
    systemRunPlan?: SystemRunApprovalPlan | null;
    cwd?: string;
    agentId?: string;
    security?: "full" | "allowlist";
    ask?: "off" | "on-miss" | "always";
    approvalDecision?: "allow" | "allow-once" | "allow-always" | "deny" | null;
    approvalSource?: string | null;
    approved?: boolean;
    needsScreenRecording?: boolean;
    suppressNotifyOnExit?: boolean;
    runCommand?: HandleSystemRunInvokeOptions["runCommand"];
    runViaMacAppExecHost?: HandleSystemRunInvokeOptions["runViaMacAppExecHost"];
    sendInvokeResult?: HandleSystemRunInvokeOptions["sendInvokeResult"];
    sendExecFinishedEvent?: HandleSystemRunInvokeOptions["sendExecFinishedEvent"];
    sendNodeEvent?: HandleSystemRunInvokeOptions["sendNodeEvent"];
    skillBinsCurrent?: () => Promise<Array<{ name: string; resolvedPath: string }>>;
    isCmdExeInvocation?: HandleSystemRunInvokeOptions["isCmdExeInvocation"];
    sanitizeEnv?: HandleSystemRunInvokeOptions["sanitizeEnv"];
    resolveExecSecurity?: HandleSystemRunInvokeOptions["resolveExecSecurity"];
    resolveExecAsk?: HandleSystemRunInvokeOptions["resolveExecAsk"];
    autoReviewer?: ExecAutoReviewer;
    commitExecAuthorization?: HandleSystemRunInvokeOptions["commitExecAuthorization"];
    prepareDelayedApprovalPlan?: boolean;
  }): Promise<{
    runCommand: MockedRunCommand;
    runViaMacAppExecHost: MockedRunViaMacAppExecHost;
    sendInvokeResult: MockedSendInvokeResult;
    sendNodeEvent: MockedSendNodeEvent;
    sendExecFinishedEvent: MockedSendExecFinishedEvent;
  }> {
    const runCommand: MockedRunCommand = vi.fn<HandleSystemRunInvokeOptions["runCommand"]>(
      async () => createLocalRunResult(),
    );
    const runViaMacAppExecHost: MockedRunViaMacAppExecHost = vi.fn<
      HandleSystemRunInvokeOptions["runViaMacAppExecHost"]
    >(async () => params.runViaResponse ?? null);
    const sendInvokeResult: MockedSendInvokeResult = vi.fn<
      HandleSystemRunInvokeOptions["sendInvokeResult"]
    >(async () => {});
    const sendNodeEvent: MockedSendNodeEvent = vi.fn<HandleSystemRunInvokeOptions["sendNodeEvent"]>(
      async () => {},
    );
    const sendExecFinishedEvent: MockedSendExecFinishedEvent = vi.fn<
      HandleSystemRunInvokeOptions["sendExecFinishedEvent"]
    >(async () => {});

    if (params.runCommand !== undefined) {
      runCommand.mockImplementation(params.runCommand);
    }
    if (params.runViaMacAppExecHost !== undefined) {
      runViaMacAppExecHost.mockImplementation(params.runViaMacAppExecHost);
    }
    if (params.sendInvokeResult !== undefined) {
      sendInvokeResult.mockImplementation(params.sendInvokeResult);
    }
    if (params.sendNodeEvent !== undefined) {
      sendNodeEvent.mockImplementation(params.sendNodeEvent);
    }
    if (params.sendExecFinishedEvent !== undefined) {
      sendExecFinishedEvent.mockImplementation(params.sendExecFinishedEvent);
    }

    const command = params.command ?? ["echo", "ok"];
    let dispatchCommand = command;
    let dispatchRawCommand = params.rawCommand;
    let dispatchCwd = params.cwd;
    let dispatchAgentId = params.agentId;
    const forwardsDelayedApproval =
      params.approvalSource === "auto-review" ||
      params.approved === true ||
      params.approvalDecision === "allow" ||
      params.approvalDecision === "allow-once" ||
      params.approvalDecision === "allow-always";
    let systemRunPlan = params.systemRunPlan;
    if (forwardsDelayedApproval && params.prepareDelayedApprovalPlan !== false) {
      if (!systemRunPlan) {
        const prepared = buildSystemRunApprovalPlan({
          command,
          rawCommand: params.rawCommand,
          cwd: params.cwd,
          agentId: params.agentId,
          sessionKey: "agent:main:main",
        });
        if (!prepared.ok) {
          throw new Error(prepared.message);
        }
        systemRunPlan = prepared.plan;
        dispatchCommand = prepared.plan.argv;
        dispatchRawCommand = prepared.plan.commandText;
        dispatchCwd = prepared.plan.cwd ?? undefined;
        dispatchAgentId = prepared.plan.agentId ?? undefined;
      }
      systemRunPlan = bindCurrentPolicyToPlan(systemRunPlan);
    }

    await handleSystemRunInvoke({
      client: {} as never,
      params: {
        command: dispatchCommand,
        env: params.env,
        rawCommand: dispatchRawCommand,
        systemRunPlan,
        cwd: dispatchCwd,
        agentId: dispatchAgentId,
        approvalDecision: params.approvalDecision,
        approvalSource: params.approvalSource,
        approved: params.approved,
        needsScreenRecording: params.needsScreenRecording,
        suppressNotifyOnExit: params.suppressNotifyOnExit,
        sessionKey: "agent:main:main",
      },
      skillBins: {
        current: params.skillBinsCurrent ?? (async () => []),
      },
      execHostEnforced: false,
      execHostFallbackAllowed: true,
      resolveExecSecurity: params.resolveExecSecurity ?? (() => params.security ?? "full"),
      resolveExecAsk: params.resolveExecAsk ?? (() => params.ask ?? "off"),
      isCmdExeInvocation: params.isCmdExeInvocation ?? (() => false),
      sanitizeEnv: params.sanitizeEnv ?? (() => undefined),
      runCommand,
      runViaMacAppExecHost,
      sendNodeEvent,
      buildExecEventPayload: (payload) => payload,
      sendInvokeResult,
      sendExecFinishedEvent,
      preferMacAppExecHost: params.preferMacAppExecHost,
      getRuntimeConfig: () => getRuntimeConfigSnapshot() ?? {},
      autoReviewer: params.autoReviewer,
      commitExecAuthorization: params.commitExecAuthorization,
    });

    return {
      runCommand,
      runViaMacAppExecHost,
      sendInvokeResult,
      sendNodeEvent,
      sendExecFinishedEvent,
    };
  }

  it("routes local, mac host, and canonical shell-wrapper requests", async () => {
    const localInvoke = await runSystemInvoke({
      preferMacAppExecHost: false,
    });

    expect(localInvoke.runViaMacAppExecHost).not.toHaveBeenCalled();
    expect(localInvoke.runCommand).toHaveBeenCalledTimes(1);
    expectInvokeOk(localInvoke.sendInvokeResult, { payloadContains: "local-ok" });

    const macHostInvoke = await runSystemInvoke({
      preferMacAppExecHost: true,
      runViaResponse: createMacExecHostSuccess(),
    });

    const macHostCall = requireMacExecHostCall(macHostInvoke.runViaMacAppExecHost);
    expect(macHostCall.approvals?.agent?.security).toBe("full");
    expect(macHostCall.approvals?.agent?.ask).toBe("off");
    expect(macHostCall.request?.command).toEqual(["echo", "ok"]);
    expect(macHostInvoke.runCommand).not.toHaveBeenCalled();
    expectInvokeOk(macHostInvoke.sendInvokeResult, { payloadContains: "app-ok" });

    const shellWrapperInvoke = await runSystemInvoke({
      preferMacAppExecHost: true,
      command: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
      runViaResponse: createMacExecHostSuccess(),
    });

    const shellWrapperCall = requireMacExecHostCall(shellWrapperInvoke.runViaMacAppExecHost);
    if (shellWrapperCall.approvals === undefined) {
      throw new Error("Expected shell-wrapper approvals");
    }
    expect(shellWrapperCall.request?.command).toEqual([
      "/bin/sh",
      "-lc",
      '$0 "$1"',
      "/usr/bin/touch",
      "/tmp/marker",
    ]);
    expect(shellWrapperCall.request?.rawCommand).toBe(
      '/bin/sh -lc "$0 \\"$1\\"" /usr/bin/touch /tmp/marker',
    );
  });

  it("uses auto reviewer for system.run approval misses when exec mode is auto", async () => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-");
    const executablePath = createTempExecutable({ dir: tmp, name: "read-info" });
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          mode: "auto",
        },
      },
    });
    try {
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "allow-once",
        rationale: "reads fixture metadata only",
        risk: "low",
      }));
      const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
      const runCommand = vi.fn(async () => createLocalRunResult("auto-reviewed"));
      const prepared = buildSystemRunApprovalPlan({
        command: [executablePath],
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      const invoke = await runSystemInvoke({
        preferMacAppExecHost: false,
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        systemRunPlan: prepared.plan,
        runCommand,
        resolveExecSecurity: resolveProductionExecSecurity,
        resolveExecAsk: resolveProductionExecAsk,
        autoReviewer,
        commitExecAuthorization: commitAuthorization,
      });

      expect(autoReviewer).toHaveBeenCalledTimes(1);
      expect(autoReviewer).toHaveBeenCalledWith(
        expect.objectContaining({
          command: executablePath,
          argv: [executablePath],
          cwd: tmp,
          host: "node",
          reason: "approval-required",
          analysis: expect.objectContaining({
            parsed: true,
            allowlistMatched: false,
            inlineEval: false,
          }),
        }),
      );
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(commitAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({ source: "auto-review" }),
        }),
      );
      expectInvokeOk(invoke.sendInvokeResult, { payloadContains: "auto-reviewed" });

      const macInvoke = await runSystemInvoke({
        preferMacAppExecHost: true,
        runViaResponse: createMacExecHostSuccess(),
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        systemRunPlan: prepared.plan,
        resolveExecSecurity: resolveProductionExecSecurity,
        resolveExecAsk: resolveProductionExecAsk,
        autoReviewer,
      });
      const macCall = requireMacExecHostCall(macInvoke.runViaMacAppExecHost);
      expect(macCall.request?.approvalSource).toBe("auto-review");
      expect(macCall.request?.approvalDecision).toBeNull();
      expect(macCall.request?.policySnapshot).toEqual(
        createExecApprovalPolicySnapshot({ file: loadExecApprovals(), agentId: undefined }),
      );
      expect(macInvoke.runCommand).not.toHaveBeenCalled();
      expectInvokeOk(macInvoke.sendInvokeResult, { payloadContains: "app-ok" });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not auto-review direct system.run approval misses without an approval plan", async () => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-no-plan-");
    const executablePath = createTempExecutable({ dir: tmp, name: "read-info" });
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          mode: "auto",
        },
      },
    });
    try {
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "allow-once",
        rationale: "reads fixture metadata only",
        risk: "low",
      }));
      const runCommand = vi.fn(async () => createLocalRunResult("should-not-run"));
      const invoke = await runSystemInvoke({
        preferMacAppExecHost: false,
        command: [executablePath],
        cwd: tmp,
        runCommand,
        resolveExecSecurity: resolveProductionExecSecurity,
        resolveExecAsk: resolveProductionExecAsk,
        autoReviewer,
      });

      expect(autoReviewer).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(invoke.sendInvokeResult, {
        message: "SYSTEM_RUN_DENIED: approval required",
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not auto-review direct system.run security audit suppression edits", async () => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-suppression-");
    const executablePath = createTempExecutable({ dir: tmp, name: "openclaw" });
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          mode: "auto",
        },
      },
    });
    try {
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "allow-once",
        rationale: "test reviewer would allow it",
        risk: "low",
      }));
      const runCommand = vi.fn(async () => createLocalRunResult("should-not-run"));
      const prepared = buildSystemRunApprovalPlan({
        command: [executablePath, "config", "set", "security.audit.suppressions", "[]"],
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      const invoke = await runSystemInvoke({
        preferMacAppExecHost: false,
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        systemRunPlan: prepared.plan,
        runCommand,
        resolveExecSecurity: resolveProductionExecSecurity,
        resolveExecAsk: resolveProductionExecAsk,
        autoReviewer,
      });

      expect(autoReviewer).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(invoke.sendInvokeResult, {
        message: "SYSTEM_RUN_DENIED: approval required",
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("defers to human approval when system.run auto reviewer asks", async () => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-ask-");
    const executablePath = createTempExecutable({ dir: tmp, name: "read-info" });
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          mode: "auto",
        },
      },
    });
    try {
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "ask",
        rationale: "needs a person",
        risk: "medium",
      }));
      const runCommand = vi.fn(async () => createLocalRunResult("should-not-run"));
      const prepared = buildSystemRunApprovalPlan({
        command: [executablePath],
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      const invoke = await runSystemInvoke({
        preferMacAppExecHost: false,
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        systemRunPlan: prepared.plan,
        runCommand,
        resolveExecSecurity: resolveProductionExecSecurity,
        resolveExecAsk: resolveProductionExecAsk,
        autoReviewer,
      });

      expect(autoReviewer).toHaveBeenCalledTimes(1);
      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(invoke.sendInvokeResult, {
        message: "exec auto-review deferred to human approval",
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  const approvedEnvShellWrapperCases = [
    {
      name: "preserves wrapper argv for approved env shell commands in local execution",
      preferMacAppExecHost: false,
    },
    {
      name: "preserves wrapper argv for approved env shell commands in mac app exec host forwarding",
      preferMacAppExecHost: true,
    },
  ] as const;

  it.runIf(process.platform !== "win32")(
    "preserves wrapper argv for approved env shell commands",
    async () => {
      for (const testCase of approvedEnvShellWrapperCases) {
        const tmp = createFixtureDir("openclaw-approved-wrapper-");
        const marker = path.join(tmp, "marker");
        const attackerScript = path.join(tmp, "sh");
        fs.writeFileSync(attackerScript, "#!/bin/sh\necho exploited > marker\n");
        fs.chmodSync(attackerScript, 0o755);
        const runCommand = vi.fn(async (argv: string[]) => {
          if (argv[0] === "/bin/sh" && argv[1] === "sh" && argv[2] === "-c") {
            fs.writeFileSync(marker, "rewritten");
          }
          return createLocalRunResult();
        });
        const sendInvokeResult = vi.fn(async () => {});
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: testCase.preferMacAppExecHost,
          command: ["env", "sh", "-c", "echo SAFE"],
          cwd: tmp,
          approved: true,
          security: "allowlist",
          ask: "on-miss",
          runCommand,
          sendInvokeResult,
          runViaResponse: testCase.preferMacAppExecHost
            ? {
                ok: true,
                payload: {
                  success: true,
                  stdout: "app-ok",
                  stderr: "",
                  timedOut: false,
                  exitCode: 0,
                  error: null,
                },
              }
            : undefined,
        });

        if (testCase.preferMacAppExecHost) {
          const canonicalCwd = fs.realpathSync(tmp);
          expect(invoke.runCommand).not.toHaveBeenCalled();
          const macHostCall = requireMacExecHostCall(invoke.runViaMacAppExecHost);
          if (macHostCall.approvals === undefined) {
            throw new Error("Expected Mac host approvals");
          }
          expect(macHostCall.request?.command).toEqual(["env", "sh", "-c", "echo SAFE"]);
          expect(macHostCall.request?.rawCommand).toBe('env sh -c "echo SAFE"');
          expect(macHostCall.request?.cwd).toBe(canonicalCwd);
          expect(macHostCall.request?.approvalDecision).toBe("allow-once");
          expect(macHostCall.request?.approvalSource).toBeUndefined();
          expect(macHostCall.request?.policySnapshot).toEqual(
            createExecApprovalPolicySnapshot({ file: loadExecApprovals(), agentId: undefined }),
          );
          expectInvokeOk(invoke.sendInvokeResult, { payloadContains: "app-ok" });
          continue;
        }

        expect(requireFirstRunCommandArgs(invoke.runCommand)).toEqual([
          "env",
          "sh",
          "-c",
          "echo SAFE",
        ]);
        expect(fs.existsSync(marker)).toBe(false);
        expectInvokeOk(invoke.sendInvokeResult);
      }
    },
  );

  it("handles transparent and semantic env wrappers in allowlist mode", async () => {
    const oldPath = process.env.PATH;
    if (process.platform !== "win32") {
      process.env.PATH = "/usr/bin:/bin";
    }
    try {
      const transparent = await runSystemInvoke({
        preferMacAppExecHost: false,
        security: "allowlist",
        command: ["env", "tr", "a", "b"],
      });
      if (process.platform === "win32") {
        expect(transparent.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(transparent.sendInvokeResult, { message: "allowlist miss" });
      } else {
        const expectedTrPath = fs.realpathSync(
          fs.existsSync("/usr/bin/tr") ? "/usr/bin/tr" : "/bin/tr",
        );
        expect(requireFirstRunCommandArgs(transparent.runCommand)).toEqual([
          expectedTrPath,
          "a",
          "b",
        ]);
        expectInvokeOk(transparent.sendInvokeResult);
      }

      const semantic = await runSystemInvoke({
        preferMacAppExecHost: false,
        security: "allowlist",
        command: ["env", "FOO=bar", "tr", "a", "b"],
      });
      expect(semantic.runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(semantic.sendInvokeResult, { message: "allowlist miss" });
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

  it("denies shell payload carriers in allowlist mode without explicit approval", async () => {
    const shellPayloadCases: Array<
      | {
          label: string;
          command: string[];
          ask?: "off" | "on-miss";
          message: string;
          approvalRequired?: false;
        }
      | {
          label: string;
          command: string[];
          ask?: "off" | "on-miss";
          approvalRequired: true;
        }
    > = [
      {
        label: "env -S",
        command: ["env", "-S", 'sh -c "echo pwned"'],
        message: "allowlist miss",
        ask: "off",
      },
      {
        label: "semicolon chain simple command",
        command:
          process.platform === "win32"
            ? ["cmd.exe", "/d", "/s", "/c", "openclaw status; id"]
            : ["/bin/sh", "-lc", "openclaw status; id"],
        approvalRequired: true,
      },
      {
        label: "semicolon chain path read",
        command:
          process.platform === "win32"
            ? ["cmd.exe", "/d", "/s", "/c", "openclaw status; cat /etc/passwd"]
            : ["/bin/sh", "-lc", "openclaw status; cat /etc/passwd"],
        approvalRequired: true,
      },
      {
        label: "PowerShell encoded command",
        command: ["pwsh", "-EncodedCommand", "ZQBjAGgAbwAgAHAAdwBuAGUAZAA="],
        approvalRequired: true,
      },
    ];

    for (const testCase of shellPayloadCases) {
      const { runCommand, sendInvokeResult, sendNodeEvent } = await runSystemInvoke({
        preferMacAppExecHost: false,
        security: "allowlist",
        ask: testCase.ask ?? "on-miss",
        command: testCase.command,
      });
      expect(runCommand, testCase.label).not.toHaveBeenCalled();
      if (testCase.approvalRequired) {
        expectApprovalRequiredDenied({ sendNodeEvent, sendInvokeResult });
      } else if ("message" in testCase) {
        expectInvokeErrorMessage(sendInvokeResult, { message: testCase.message });
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "denies safe-bin shell expansion carriers in allowlist mode",
    async () => {
      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        preferMacAppExecHost: false,
        security: "allowlist",
        ask: "off",
        command: ["/bin/sh", "-lc", "head -c${IFS}16${IFS}${OPENCLAW_CONFIG_PATH}"],
        rawCommand: "head -c${IFS}16${IFS}${OPENCLAW_CONFIG_PATH}",
      });

      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, { message: "allowlist miss" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rewrites safe-bin shell payloads before execution in allowlist mode",
    async () => {
      const oldPath = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin";
      try {
        const expectedHeadPath = fs.realpathSync(
          fs.existsSync("/usr/bin/head") ? "/usr/bin/head" : "/bin/head",
        );
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "allowlist",
          ask: "off",
          command: ["/bin/sh", "-lc", "head -c 16"],
          rawCommand: "head -c 16",
        });

        expect(requireFirstRunCommandArgs(runCommand)).toEqual([
          "/bin/sh",
          "-lc",
          `${expectedHeadPath} -c 16`,
        ]);
        expectInvokeOk(sendInvokeResult);
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rewrites nested safe-bin shell chains before execution in allowlist mode",
    async () => {
      const oldPath = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin";
      try {
        const expectedTrPath = fs.realpathSync(
          fs.existsSync("/usr/bin/tr") ? "/usr/bin/tr" : "/bin/tr",
        );
        const expectedHeadPath = fs.realpathSync(
          fs.existsSync("/usr/bin/head") ? "/usr/bin/head" : "/bin/head",
        );
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "allowlist",
          ask: "off",
          command: ["/bin/sh", "-lc", "sh -c 'tr a b && head -c 16'"],
          rawCommand: "sh -c 'tr a b && head -c 16'",
        });

        const payload = requireFirstRunCommandArgs(runCommand)[2] ?? "";
        expect(payload).not.toContain("tr a b && head -c 16");
        expect(payload).toContain(expectedTrPath);
        expect(payload).toContain(expectedHeadPath);
        expectInvokeOk(sendInvokeResult);
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not apply POSIX safe-bin shell rewrites to PowerShell wrappers",
    async () => {
      const oldPath = process.env.PATH;
      process.env.PATH = "/usr/bin:/bin";
      try {
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "allowlist",
          ask: "off",
          command: ["pwsh", "-Command", "head -c 16"],
        });

        expect(requireFirstRunCommandArgs(runCommand)).toEqual(["pwsh", "-Command", "head -c 16"]);
        expectInvokeOk(sendInvokeResult);
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
    },
  );

  it("denies abbreviated PowerShell encoded payloads even when the wrapper is allowlisted", async () => {
    const binDir = createFixtureDir("openclaw-pwsh-allowlist-");
    const executablePath = createTempExecutable({ dir: binDir, name: "pwsh" });
    await withTempApprovalsHome({
      approvals: createAllowlistOnMissApprovals({
        agents: {
          main: {
            allowlist: [{ pattern: executablePath }],
          },
        },
      }),
      run: async () => {
        const { runCommand, sendInvokeResult, sendNodeEvent } = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "allowlist",
          ask: "on-miss",
          command: [
            executablePath,
            "-win",
            "hidden",
            "-if",
            "XML",
            "-config",
            "SomeConfig",
            "/NoProfile",
            "/ec",
            "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA",
          ],
        });

        expect(runCommand).not.toHaveBeenCalled();
        expectApprovalRequiredDenied({ sendNodeEvent, sendInvokeResult });

        const commandWithArgs = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "allowlist",
          ask: "on-miss",
          command: [executablePath, "-cwa", "Write-Output", "hi"],
        });

        expect(commandWithArgs.runCommand).not.toHaveBeenCalled();
        expectApprovalRequiredDenied({
          sendNodeEvent: commandWithArgs.sendNodeEvent,
          sendInvokeResult: commandWithArgs.sendInvokeResult,
        });
      },
    });
  });

  it.runIf(process.platform !== "win32")(
    "pins PATH-token executable to canonical path",
    async () => {
      await withPathTokenCommand({
        tmpPrefix: "openclaw-approval-path-pin-",
        run: async ({ expected }) => {
          const { runCommand, sendInvokeResult } = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: ["poccmd", "-n", "SAFE"],
            approved: true,
            security: "full",
            ask: "off",
          });
          expectCommandPinnedToCanonicalPath({
            runCommand,
            expected,
            commandTail: ["-n", "SAFE"],
          });
          expectInvokeOk(sendInvokeResult);
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "pins PATH-token executable to canonical path for allowlist runs",
    async () => {
      const runCommand = vi.fn(async () => ({
        ...createLocalRunResult(),
      }));
      const sendInvokeResult = vi.fn(async () => {});
      await withPathTokenCommand({
        tmpPrefix: "openclaw-allowlist-path-pin-",
        run: async ({ link: _link, expected }) => {
          await withTempApprovalsHome({
            approvals: {
              version: 1,
              defaults: {
                security: "allowlist",
                ask: "off",
                askFallback: "deny",
              },
              agents: {
                main: {
                  allowlist: [{ pattern: expected }],
                },
              },
            },
            run: async () => {
              await runSystemInvoke({
                preferMacAppExecHost: false,
                command: ["poccmd", "-n", "SAFE"],
                security: "allowlist",
                ask: "off",
                runCommand,
                sendInvokeResult,
              });
            },
          });
          expectCommandPinnedToCanonicalPath({
            runCommand,
            expected,
            commandTail: ["-n", "SAFE"],
          });
          expectInvokeOk(sendInvokeResult);
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked cwd paths during approval preparation",
    async () => {
      for (const testCase of [
        {
          label: "cwd symlink",
          setup: () => {
            const tmp = createFixtureDir("openclaw-approval-cwd-link-");
            const safeDir = path.join(tmp, "safe");
            const linkDir = path.join(tmp, "cwd-link");
            const script = path.join(safeDir, "run.sh");
            fs.mkdirSync(safeDir, { recursive: true });
            fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
            fs.chmodSync(script, 0o755);
            fs.symlinkSync(safeDir, linkDir, "dir");
            return {
              cwd: linkDir,
              message: "canonical cwd",
            };
          },
        },
        {
          label: "parent symlink",
          setup: () => {
            const tmp = createFixtureDir("openclaw-approval-cwd-parent-link-");
            const safeSymlinkRoot = path.join(tmp, "safe-root");
            const safeSymlinkSub = path.join(safeSymlinkRoot, "sub");
            const linkRoot = path.join(tmp, "approved-link");
            fs.mkdirSync(safeSymlinkSub, { recursive: true });
            fs.symlinkSync(safeSymlinkRoot, linkRoot, "dir");
            return {
              cwd: path.join(linkRoot, "sub"),
              message: "no symlink path components",
            };
          },
        },
      ]) {
        const { cwd, message } = testCase.setup();
        const prepared = buildSystemRunApprovalPlan({
          command: ["./run.sh"],
          cwd,
        });
        expect(prepared.ok, testCase.label).toBe(false);
        if (!prepared.ok) {
          expect(prepared.message, testCase.label).toContain(message);
        }
      }
    },
  );

  it("uses canonical executable path for approval-based relative command execution", async () => {
    const tmp = createFixtureDir("openclaw-approval-cwd-real-");
    const script = path.join(tmp, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(script, 0o755);
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
      command: ["./run.sh", "--flag"],
      cwd: tmp,
      approved: true,
      security: "full",
      ask: "off",
    });
    if (process.platform === "win32") {
      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, {
        message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
        exact: true,
      });
      return;
    }
    expectCommandPinnedToCanonicalPath({
      runCommand,
      expected: fs.realpathSync(script),
      commandTail: ["--flag"],
      cwd: fs.realpathSync(tmp),
    });
    expectInvokeOk(sendInvokeResult);
  });

  it("denies approval-based execution when cwd identity drifts before execution", async () => {
    const tmp = createFixtureDir("openclaw-approval-cwd-drift-");
    const fallback = createFixtureDir("openclaw-approval-cwd-drift-alt-");
    const script = path.join(tmp, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(script, 0o755);
    const canonicalCwd = fs.realpathSync(tmp);
    const prepared = buildSystemRunApprovalPlan({
      command: ["./run.sh"],
      cwd: tmp,
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withMockedCwdIdentityDrift({
      canonicalCwd,
      driftDir: fallback,
      run: async () => {
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? tmp,
          approved: true,
          security: "full",
          ask: "off",
        });
        expect(runCommand).not.toHaveBeenCalled();
        if (process.platform === "win32") {
          expectInvokeErrorMessage(sendInvokeResult, {
            message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
            exact: true,
          });
          return;
        }
        expectInvokeErrorMessage(sendInvokeResult, {
          message: "SYSTEM_RUN_DENIED: approval cwd changed before execution",
          exact: true,
        });
      },
    });
  });

  it("validates approved script operand bindings at dispatch", async () => {
    for (const mutate of [true, false]) {
      const tmp = createFixtureDir(
        mutate ? "openclaw-approval-script-drift-" : "openclaw-approval-script-stable-",
      );
      const fixture = createMutableScriptOperandFixture(tmp);
      fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
      if (process.platform !== "win32") {
        fs.chmodSync(fixture.scriptPath, 0o755);
      }
      const prepared = buildSystemRunApprovalPlan({
        command: fixture.command,
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }

      if (mutate) {
        fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
      }
      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        preferMacAppExecHost: false,
        command: prepared.plan.argv,
        rawCommand: prepared.plan.commandText,
        systemRunPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? tmp,
        approved: true,
        security: "full",
        ask: "off",
      });

      if (mutate) {
        expect(runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(sendInvokeResult, {
          message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
          exact: true,
        });
      } else {
        expect(runCommand).toHaveBeenCalledTimes(1);
        expectInvokeOk(sendInvokeResult);
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "revalidates approved cwd identity after authorization commit",
    async () => {
      const tmp = createFixtureDir("openclaw-approval-cwd-post-commit-drift-");
      const moved = `${tmp}-approved`;
      const script = path.join(tmp, "run.sh");
      fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
      fs.chmodSync(script, 0o755);
      const commitAuthorization: HandleSystemRunInvokeOptions["commitExecAuthorization"] = async (
        params,
      ) => {
        await commitExecAuthorizationLocked(params);
        fs.renameSync(tmp, moved);
        fs.mkdirSync(tmp);
        fs.writeFileSync(path.join(tmp, "run.sh"), "#!/bin/sh\necho CHANGED\n", { mode: 0o755 });
      };

      const invoke = await runSystemInvoke({
        preferMacAppExecHost: false,
        command: ["./run.sh"],
        cwd: tmp,
        approved: true,
        security: "full",
        ask: "off",
        commitExecAuthorization: commitAuthorization,
      });

      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(invoke.sendInvokeResult, {
        message: "SYSTEM_RUN_DENIED: approval cwd changed before execution",
        exact: true,
      });
    },
  );

  it("revalidates approved script operands after authorization commit", async () => {
    const tmp = createFixtureDir("openclaw-approval-script-post-commit-drift-");
    const fixture = createMutableScriptOperandFixture(tmp);
    fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.scriptPath, 0o755);
    }
    const prepared = buildSystemRunApprovalPlan({ command: fixture.command, cwd: tmp });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    const commitAuthorization: HandleSystemRunInvokeOptions["commitExecAuthorization"] = async (
      params,
    ) => {
      await commitExecAuthorizationLocked(params);
      fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
    };

    const invoke = await runSystemInvoke({
      preferMacAppExecHost: false,
      command: prepared.plan.argv,
      rawCommand: prepared.plan.commandText,
      systemRunPlan: prepared.plan,
      cwd: prepared.plan.cwd ?? tmp,
      approved: true,
      security: "full",
      ask: "off",
      commitExecAuthorization: commitAuthorization,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, {
      message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
      exact: true,
    });
  });

  it("validates approved runtime script operand bindings at dispatch", async () => {
    await withFakeRuntimeOnPath({
      runtime: "tsx",
      run: async () => {
        const tmp = createFixtureDir("openclaw-approval-tsx-script-drift-");
        const fixture = createRuntimeScriptOperandFixture({ tmp, runtime: "tsx" });
        fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
        const prepared = buildSystemRunApprovalPlan({
          command: fixture.command,
          cwd: tmp,
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error("unreachable");
        }

        fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? tmp,
          approved: true,
          security: "full",
          ask: "off",
        });

        expect(runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(sendInvokeResult, {
          message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
          exact: true,
        });
        const missingBindingTmp = createFixtureDir("openclaw-approval-tsx-missing-binding-");
        const missingBindingFixture = createRuntimeScriptOperandFixture({
          tmp: missingBindingTmp,
          runtime: "tsx",
        });
        fs.writeFileSync(missingBindingFixture.scriptPath, missingBindingFixture.initialBody);
        const missingBindingPrepared = buildSystemRunApprovalPlan({
          command: missingBindingFixture.command,
          cwd: missingBindingTmp,
        });
        expect(missingBindingPrepared.ok).toBe(true);
        if (!missingBindingPrepared.ok) {
          throw new Error("unreachable");
        }

        const planWithoutBinding = { ...missingBindingPrepared.plan };
        delete planWithoutBinding.mutableFileOperand;
        const missingBindingRun = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: missingBindingPrepared.plan.argv,
          rawCommand: missingBindingPrepared.plan.commandText,
          systemRunPlan: planWithoutBinding,
          cwd: missingBindingPrepared.plan.cwd ?? missingBindingTmp,
          approved: true,
          security: "full",
          ask: "off",
        });

        expect(missingBindingRun.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(missingBindingRun.sendInvokeResult, {
          message: "SYSTEM_RUN_DENIED: approval missing script operand binding",
          exact: true,
        });
      },
    });
  });

  it("denies ./sh wrapper spoof in allowlist on-miss mode before execution", async () => {
    const marker = path.join(os.tmpdir(), `openclaw-wrapper-spoof-${process.pid}-${Date.now()}`);
    const runCommand = vi.fn(async () => {
      fs.writeFileSync(marker, "executed");
      return createLocalRunResult();
    });
    const sendInvokeResult = vi.fn(async () => {});
    const sendNodeEvent = vi.fn(async () => {});

    await runSystemInvoke({
      preferMacAppExecHost: false,
      command: ["./sh", "-lc", "/bin/echo approved-only"],
      security: "allowlist",
      ask: "on-miss",
      runCommand,
      sendInvokeResult,
      sendNodeEvent,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
    expectApprovalRequiredDenied({ sendNodeEvent, sendInvokeResult });
    try {
      fs.unlinkSync(marker);
    } catch {
      // no-op
    }
  });

  it("denies ./skill-bin even when autoAllowSkills trust entry exists", async () => {
    const { runCommand, sendInvokeResult, sendNodeEvent } = createInvokeSpies();

    await withTempApprovalsHome({
      approvals: createAllowlistOnMissApprovals({ autoAllowSkills: true }),
      run: async ({ tempHome }) => {
        const skillBinPath = path.join(tempHome, "skill-bin");
        fs.writeFileSync(skillBinPath, "#!/bin/sh\necho should-not-run\n", { mode: 0o755 });
        fs.chmodSync(skillBinPath, 0o755);
        await runSystemInvoke({
          preferMacAppExecHost: false,
          command: ["./skill-bin", "--help"],
          cwd: tempHome,
          security: "allowlist",
          ask: "on-miss",
          skillBinsCurrent: async () => [{ name: "skill-bin", resolvedPath: skillBinPath }],
          runCommand,
          sendInvokeResult,
          sendNodeEvent,
        });
      },
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied({ sendNodeEvent, sendInvokeResult });
  });

  it("rejects unsafe environment inputs before execution", async () => {
    const shellCommand =
      process.platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "echo ok"]
        : ["/bin/sh", "-lc", "echo ok"];
    const cases: Array<{
      label: string;
      command?: string[];
      env?: Record<string, string>;
      message: string;
      details: string[];
    }> = [
      {
        label: "blocked override",
        env: { CLASSPATH: "/tmp/evil-classpath" },
        message: "SYSTEM_RUN_DENIED: environment override rejected",
        details: ["CLASSPATH"],
      },
      {
        label: "blocked override for shell-wrapper",
        command: shellCommand,
        env: {
          CLASSPATH: "/tmp/evil-classpath",
          LANG: "C",
        },
        message: "SYSTEM_RUN_DENIED: environment override rejected",
        details: ["CLASSPATH"],
      },
      {
        label: "blocked argv assignment",
        command: ["/usr/bin/env", "SHELLOPTS=xtrace", "PS4=$(id)", "bash", "-lc", "echo ok"],
        message: "SYSTEM_RUN_DENIED: command env assignment rejected",
        details: ["SHELLOPTS", "PS4"],
      },
      {
        label: "invalid override key",
        env: { "BAD-KEY": "x" },
        message: "SYSTEM_RUN_DENIED: environment override rejected",
        details: ["BAD-KEY"],
      },
    ];

    for (const testCase of cases) {
      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        preferMacAppExecHost: false,
        security: "full",
        ask: "off",
        command: testCase.command,
        env: testCase.env,
      });

      expect(runCommand, testCase.label).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, {
        message: testCase.message,
      });
      for (const detail of testCase.details) {
        expectInvokeErrorMessage(sendInvokeResult, { message: detail });
      }
    }
  });

  it("applies shell-wrapper env allowlist for shell executable commands without inline payload", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "full",
      ask: "off",
      command: ["/bin/sh", "./script.sh"],
      env: {
        OPENCLAW_TEST: "1",
        LANG: "C",
        LC_TIME: "C",
      },
      sanitizeEnv: (overrides) => overrides ?? undefined,
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    const passedEnv = firstMockCallArg(runCommand, "runCommand", 2);
    expect(passedEnv).toEqual({
      LANG: "C",
      LC_TIME: "C",
    });
    expectInvokeOk(sendInvokeResult);
  });

  async function expectNestedEnvShellDenied(params: {
    depth: number;
    markerName: string;
    errorLabel: string;
  }) {
    const { runCommand, sendInvokeResult, sendNodeEvent } = createInvokeSpies({
      runCommand: vi.fn(async () => {
        throw new Error(params.errorLabel);
      }),
    });

    await withTempApprovalsHome({
      approvals: createAllowlistOnMissApprovals({
        agents: {
          main: {
            allowlist: [{ pattern: "/usr/bin/env" }],
          },
        },
      }),
      run: async ({ tempHome }) => {
        const marker = path.join(tempHome, params.markerName);
        await runSystemInvoke({
          preferMacAppExecHost: false,
          command: buildNestedEnvShellCommand({
            depth: params.depth,
            payload: `echo PWNED > ${marker}`,
          }),
          security: "allowlist",
          ask: "on-miss",
          runCommand,
          sendInvokeResult,
          sendNodeEvent,
        });
        expect(fs.existsSync(marker)).toBe(false);
      },
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied({ sendNodeEvent, sendInvokeResult });
  }

  it("denies env-wrapped shell payloads at and past the dispatch depth boundary", async () => {
    if (process.platform === "win32") {
      return;
    }
    for (const testCase of [
      {
        depth: 4,
        markerName: "depth4-pwned.txt",
        errorLabel: "runCommand should not be called for depth-boundary shell wrappers",
      },
      {
        depth: 5,
        markerName: "pwned.txt",
        errorLabel: "runCommand should not be called for nested env depth overflow",
      },
    ]) {
      await expectNestedEnvShellDenied(testCase);
    }
  });

  it("requires explicit approval for strict inline-eval carriers", async () => {
    // The full carrier matrix lives in command-analysis tests; this is the
    // handle-level smoke for strictInlineEval denial wiring.
    const cases = [
      {
        command: ["python3", "-c", "print('hi')"],
        expected: "python3 -c requires explicit approval in strictInlineEval mode",
      },
      {
        command: ["python3.13", "-c", "print('hi')"],
        expected: "python3.13 -c requires explicit approval in strictInlineEval mode",
      },
    ] as const;
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      for (const testCase of cases) {
        const { runCommand, sendInvokeResult, sendNodeEvent } = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: [...testCase.command],
          security: "full",
          ask: "off",
        });

        expect(runCommand, testCase.command.join(" ")).not.toHaveBeenCalled();
        expectExecDeniedEvent(sendNodeEvent);
        expectInvokeErrorMessage(sendInvokeResult, {
          message: testCase.expected,
        });
      }
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("prefers strict inline-eval denial over generic allowlist prompts", async () => {
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      const { runCommand, sendInvokeResult, sendNodeEvent } = await runSystemInvoke({
        preferMacAppExecHost: false,
        command: ["awk", 'BEGIN{system("id")}', "/dev/null"],
        security: "allowlist",
        ask: "on-miss",
      });

      expect(runCommand).not.toHaveBeenCalled();
      expectExecDeniedEvent(sendNodeEvent);
      expectInvokeErrorMessage(sendInvokeResult, {
        message: "awk inline program requires explicit approval in strictInlineEval mode",
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("fails closed when allow-always approval persistence fails", async () => {
    await withTempApprovalsHome({
      approvals: createAllowlistOnMissApprovals(),
      run: async () => {
        const tempDir = createFixtureDir("openclaw-allow-always-write-failure-");
        const executablePath = createTempExecutable({ dir: tempDir, name: "approved-tool" });
        const commitAuthorization = vi.fn(async () => {
          throw new Error("approval lock unavailable");
        });
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: [executablePath],
          security: "allowlist",
          ask: "on-miss",
          approvalDecision: "allow-always",
          approved: true,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({ allowAlwaysDecision: expect.any(Object) }),
        );
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expect(invoke.sendExecFinishedEvent).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("does not restore a revoked allowlist rule during explicit allow-always persistence", async () => {
    const tempDir = createFixtureDir("openclaw-allow-always-revoked-rule-");
    const executablePath = createTempExecutable({ dir: tempDir, name: "approved-tool" });
    const matchedEntry = { pattern: fs.realpathSync(executablePath) };
    const expectedPolicySnapshot = {
      security: "allowlist" as const,
      ask: "always" as const,
      askFallback: "deny" as const,
      autoAllowSkills: false,
      allowlistRules: [matchedEntry],
    };

    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
        agents: { main: { allowlist: [matchedEntry] } },
      },
      run: async () => {
        let capturedAuthorization:
          | Parameters<typeof commitExecAuthorizationLocked>[0]["authorization"]
          | undefined;
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            capturedAuthorization = params.authorization;
            const current = loadExecApprovals();
            const main = current.agents?.main;
            saveExecApprovals({
              ...current,
              agents: {
                ...current.agents,
                main: { ...main, allowlist: [] },
              },
            });
            await commitExecAuthorizationLocked(params);
          },
        );

        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: [executablePath],
          security: "allowlist",
          ask: "always",
          approvalDecision: "allow-always",
          approved: true,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledTimes(1);
        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            allowAlwaysDecision: expect.objectContaining({ kind: "patterns" }),
          }),
        );
        expect(capturedAuthorization).toEqual({
          source: "explicit-approval",
          security: "allowlist",
          ask: "always",
          allowlistSatisfied: true,
          policySnapshot: expectedPolicySnapshot,
          requireAutoAllowSkills: false,
          requireExactCommandApproval: false,
          requireDurableAllowlistApproval: false,
        });
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expect(invoke.sendExecFinishedEvent).not.toHaveBeenCalled();
        expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("fails closed when allowlist usage persistence fails", async () => {
    const tempDir = createFixtureDir("openclaw-allowlist-usage-write-failure-");
    const executablePath = createTempExecutable({ dir: tempDir, name: "allowlisted-tool" });
    await withTempApprovalsHome({
      approvals: createAllowlistOnMissApprovals({
        agents: {
          main: {
            allowlist: [{ pattern: fs.realpathSync(executablePath) }],
          },
        },
      }),
      run: async () => {
        const commitAuthorization = vi.fn(async () => {
          throw new Error("approval lock unavailable");
        });
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: [executablePath],
          security: "allowlist",
          ask: "off",
          commitExecAuthorization: commitAuthorization,
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expect(invoke.sendExecFinishedEvent).not.toHaveBeenCalled();
        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({
              security: "allowlist",
              ask: "on-miss",
            }),
          }),
        );
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("revalidates unprompted full policy before local execution", async () => {
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            const current = loadExecApprovals();
            current.defaults = { ...current.defaults, security: "deny" };
            saveExecApprovals(current);
            await commitExecAuthorizationLocked(params);
          },
        );
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "full",
          ask: "off",
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({ source: "current-policy" }),
          }),
        );
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("rejects unprompted full execution after ask policy tightens", async () => {
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization: HandleSystemRunInvokeOptions["commitExecAuthorization"] = async (
          params,
        ) => {
          const current = loadExecApprovals();
          current.defaults = { ...current.defaults, ask: "on-miss" };
          saveExecApprovals(current);
          await commitExecAuthorizationLocked(params);
        };
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "full",
          ask: "off",
          commitExecAuthorization: commitAuthorization,
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("revalidates explicit approval against a current deny policy", async () => {
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            const current = loadExecApprovals();
            current.defaults = { ...current.defaults, security: "deny" };
            saveExecApprovals(current);
            await commitExecAuthorizationLocked(params);
          },
        );
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "full",
          ask: "always",
          approvalDecision: "allow-once",
          approved: true,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({ source: "explicit-approval" }),
          }),
        );
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("rejects explicit allow-once when persisted security tightens to allowlist", async () => {
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            const current = loadExecApprovals();
            current.defaults = { ...current.defaults, security: "allowlist" };
            saveExecApprovals(current);
            await commitExecAuthorizationLocked(params);
          },
        );
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "full",
          ask: "always",
          approvalDecision: "allow-once",
          approved: true,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({
              source: "explicit-approval",
              policySnapshot: expect.any(Object),
            }),
          }),
        );
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("treats authenticated auto-review provenance as marker-only one-shot authority", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "on-miss", askFallback: "deny" },
      },
      run: async () => {
        const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
          decision: "ask",
          rationale: "must not be called for forwarded provenance",
          risk: "medium",
        }));
        const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          security: "full",
          ask: "on-miss",
          approvalSource: "auto-review",
          autoReviewer,
          commitExecAuthorization: commitAuthorization,
        });

        expect(autoReviewer).not.toHaveBeenCalled();
        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({ source: "auto-review" }),
          }),
        );
        expect(invoke.runCommand).toHaveBeenCalledTimes(1);
        expectInvokeOk(invoke.sendInvokeResult);
      },
    });
  });

  it("rejects forwarded auto-review when current ask policy tightens to always", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "on-miss", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            const current = loadExecApprovals();
            current.defaults = { ...current.defaults, ask: "always" };
            saveExecApprovals(current);
            await commitExecAuthorizationLocked(params);
          },
        );
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          security: "full",
          ask: "on-miss",
          approvalSource: "auto-review",
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({ source: "auto-review" }),
          }),
        );
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("rejects forwarded auto-review when persisted security tightens to allowlist", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "on-miss", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            const current = loadExecApprovals();
            current.defaults = { ...current.defaults, security: "allowlist" };
            saveExecApprovals(current);
            await commitExecAuthorizationLocked(params);
          },
        );
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          security: "full",
          ask: "on-miss",
          approvalSource: "auto-review",
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({
              source: "auto-review",
              policySnapshot: expect.any(Object),
            }),
          }),
        );
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("rejects forwarded auto-review when persisted ask tightens from off to on-miss", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            const current = loadExecApprovals();
            current.defaults = { ...current.defaults, ask: "on-miss" };
            saveExecApprovals(current);
            await commitExecAuthorizationLocked(params);
          },
        );
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          security: "full",
          ask: "off",
          approvalSource: "auto-review",
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({
              source: "auto-review",
              policySnapshot: expect.any(Object),
            }),
          }),
        );
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("rejects forwarded auto-review when current security policy tightens to deny", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "on-miss", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization: HandleSystemRunInvokeOptions["commitExecAuthorization"] = async (
          params,
        ) => {
          const current = loadExecApprovals();
          current.defaults = { ...current.defaults, security: "deny" };
          saveExecApprovals(current);
          await commitExecAuthorizationLocked(params);
        };
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          security: "full",
          ask: "on-miss",
          approvalSource: "auto-review",
          commitExecAuthorization: commitAuthorization,
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("does not let forwarded auto-review authorize security audit suppression edits", async () => {
    const tmp = createFixtureDir("openclaw-forwarded-auto-review-suppression-");
    const executablePath = createTempExecutable({ dir: tmp, name: "openclaw" });
    const prepared = buildSystemRunApprovalPlan({
      command: [executablePath, "config", "set", "security.audit.suppressions", "[]"],
      cwd: tmp,
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "on-miss", askFallback: "deny" },
      },
      run: async () => {
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: tmp,
          security: "full",
          ask: "on-miss",
          approvalSource: "auto-review",
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectExecDeniedEvent(invoke.sendNodeEvent);
        expectInvokeErrorMessage(invoke.sendInvokeResult, {
          message: "SYSTEM_RUN_DENIED: explicit approval required",
          exact: true,
        });
      },
    });
  });

  it("preserves exact-plan forwarded auto-review for strict inline eval", async () => {
    const plan = createStrictInlineEvalApprovalPlan("openclaw-forwarded-inline-");
    setRuntimeConfigSnapshot({ tools: { exec: { strictInlineEval: true } } });
    try {
      await withTempApprovalsHome({
        approvals: {
          version: 1,
          defaults: { security: "full", ask: "on-miss", askFallback: "deny" },
        },
        run: async () => {
          const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
          const invoke = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: plan.argv,
            rawCommand: plan.commandText,
            systemRunPlan: plan,
            security: "full",
            ask: "on-miss",
            approvalSource: "auto-review",
            commitExecAuthorization: commitAuthorization,
          });

          expect(commitAuthorization).toHaveBeenCalledWith(
            expect.objectContaining({
              authorization: expect.objectContaining({ source: "auto-review" }),
            }),
          );
          expect(invoke.runCommand).toHaveBeenCalledTimes(1);
          expectInvokeOk(invoke.sendInvokeResult);
        },
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not commit allow-always state when local screen recording is unavailable", async () => {
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "deny" },
      },
      run: async () => {
        const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          security: "full",
          ask: "always",
          approvalDecision: "allow-always",
          approved: true,
          needsScreenRecording: true,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).not.toHaveBeenCalled();
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
        expect(invoke.sendNodeEvent).toHaveBeenCalledWith(
          expect.anything(),
          "exec.denied",
          expect.objectContaining({ reason: "permission:screenRecording" }),
        );
      },
    });
  });

  it("revalidates timeout fallback against the current askFallback policy", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "full" },
        agents: {},
      },
      run: async () => {
        const commitAuthorization: HandleSystemRunInvokeOptions["commitExecAuthorization"] = async (
          params,
        ) => {
          const current = loadExecApprovals();
          current.defaults = { ...current.defaults, askFallback: "deny" };
          saveExecApprovals(current);
          await commitExecAuthorizationLocked(params);
        };
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? undefined,
          security: "full",
          ask: "always",
          approvalSource: "ask-fallback",
          commitExecAuthorization: commitAuthorization,
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expect(invoke.sendExecFinishedEvent).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(invoke);
      },
    });
  });

  it("requires a canonical plan for timeout fallback provenance", async () => {
    const invoke = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "full",
      ask: "always",
      approvalSource: "ask-fallback",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, {
      message: "approvalSource requires matching systemRunPlan",
      exact: true,
    });
  });

  it("requires a canonical plan for forwarded auto-review provenance", async () => {
    const invoke = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "full",
      ask: "on-miss",
      approvalSource: "auto-review",
      prepareDelayedApprovalPlan: false,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, {
      message: "approvalSource requires matching systemRunPlan",
      exact: true,
    });
  });

  it("requires a canonical plan for explicit approval provenance", async () => {
    const invoke = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "full",
      ask: "always",
      approvalDecision: "allow-once",
      approved: true,
      prepareDelayedApprovalPlan: false,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, {
      message: "explicit approval requires matching systemRunPlan",
      exact: true,
    });
  });

  it("requires a prepared policy snapshot for forwarded delayed approval", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    const invoke = await runSystemInvoke({
      preferMacAppExecHost: false,
      command: prepared.plan.argv,
      rawCommand: prepared.plan.commandText,
      systemRunPlan: prepared.plan,
      security: "full",
      ask: "on-miss",
      approvalSource: "auto-review",
      prepareDelayedApprovalPlan: false,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, {
      message: "delayed approval requires a prepared policy snapshot",
      exact: true,
    });
  });

  it("rejects explicit approval when policy tightens after prepare", async () => {
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "deny" },
      },
      run: async () => {
        const prepared = buildSystemRunApprovalPlan({
          command: ["echo", "ok"],
          sessionKey: "agent:main:main",
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error("unreachable");
        }
        const policyBoundPlan = bindCurrentPolicyToPlan(prepared.plan);
        const current = loadExecApprovals();
        current.defaults = { ...current.defaults, security: "allowlist" };
        saveExecApprovals(current);
        const commitAuthorization = vi.fn(commitExecAuthorizationLocked);

        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: policyBoundPlan.argv,
          rawCommand: policyBoundPlan.commandText,
          systemRunPlan: policyBoundPlan,
          security: "full",
          ask: "always",
          approvalDecision: "allow-once",
          approved: true,
          prepareDelayedApprovalPlan: false,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).not.toHaveBeenCalled();
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(invoke.sendInvokeResult, {
          message: "exec approval policy changed; request approval again",
        });
      },
    });
  });

  it("rejects forwarded auto-review when ask tightens after prepare", async () => {
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "deny" },
      },
      run: async () => {
        const prepared = buildSystemRunApprovalPlan({
          command: ["echo", "ok"],
          sessionKey: "agent:main:main",
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error("unreachable");
        }
        const policyBoundPlan = bindCurrentPolicyToPlan(prepared.plan);
        const current = loadExecApprovals();
        current.defaults = { ...current.defaults, ask: "on-miss" };
        saveExecApprovals(current);
        const commitAuthorization = vi.fn(commitExecAuthorizationLocked);

        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: policyBoundPlan.argv,
          rawCommand: policyBoundPlan.commandText,
          systemRunPlan: policyBoundPlan,
          security: "full",
          ask: "off",
          approvalSource: "auto-review",
          prepareDelayedApprovalPlan: false,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).not.toHaveBeenCalled();
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(invoke.sendInvokeResult, {
          message: "exec approval policy changed; request approval again",
        });
      },
    });
  });

  it("rejects explicit approval when an allowlist rule is revoked after prepare", async () => {
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
        agents: {
          main: {
            allowlist: [{ id: "rule-1", pattern: "/usr/bin/echo" }],
          },
        },
      },
      run: async () => {
        const prepared = buildSystemRunApprovalPlan({
          command: ["echo", "ok"],
          agentId: "main",
          sessionKey: "agent:main:main",
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error("unreachable");
        }
        const policyBoundPlan = bindCurrentPolicyToPlan(prepared.plan);
        const current = loadExecApprovals();
        current.agents = { ...current.agents, main: { allowlist: [] } };
        saveExecApprovals(current);
        const commitAuthorization = vi.fn(commitExecAuthorizationLocked);

        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: policyBoundPlan.argv,
          rawCommand: policyBoundPlan.commandText,
          systemRunPlan: policyBoundPlan,
          security: "allowlist",
          ask: "always",
          agentId: "main",
          approvalDecision: "allow-once",
          approved: true,
          prepareDelayedApprovalPlan: false,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).not.toHaveBeenCalled();
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(invoke.sendInvokeResult, {
          message: "exec approval policy changed; request approval again",
        });
      },
    });
  });

  it("rejects timeout fallback provenance mixed with explicit approval", async () => {
    const invoke = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "full",
      ask: "always",
      approvalDecision: "allow-once",
      approvalSource: "ask-fallback",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, {
      message: "approvalSource cannot be combined with explicit approval",
      exact: true,
    });
  });

  it("rejects forwarded auto-review provenance mixed with explicit approval", async () => {
    const invoke = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "full",
      ask: "on-miss",
      approved: true,
      approvalDecision: "allow-once",
      approvalSource: "auto-review",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, {
      message: "approvalSource cannot be combined with explicit approval",
      exact: true,
    });
  });

  it("applies marker-only full timeout fallback without another prompt", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "full" },
        agents: {},
      },
      run: async () => {
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          security: "full",
          ask: "always",
          approvalSource: "ask-fallback",
        });

        expect(invoke.runCommand).toHaveBeenCalledWith(
          prepared.plan.argv,
          undefined,
          undefined,
          undefined,
        );
        expectInvokeOk(invoke.sendInvokeResult);
      },
    });
  });

  it.runIf(process.platform !== "win32")(
    "permits a durable exact-command approval under allowlist timeout fallback",
    async () => {
      const tempDir = createFixtureDir("openclaw-fallback-durable-");
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-c", "/bin/ls"],
        cwd: tempDir,
        sessionKey: "agent:main:main",
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      const commandPattern = `=command:${crypto
        .createHash("sha256")
        .update(prepared.plan.commandText)
        .digest("hex")
        .slice(0, 16)}`;
      await withTempApprovalsHome({
        approvals: {
          version: 1,
          defaults: { security: "full", ask: "always", askFallback: "allowlist" },
          agents: {
            main: { allowlist: [{ pattern: commandPattern, source: "allow-always" }] },
          },
        },
        run: async () => {
          const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
          const invoke = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: prepared.plan.argv,
            rawCommand: prepared.plan.commandText,
            systemRunPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
            security: "full",
            ask: "always",
            approvalSource: "ask-fallback",
            commitExecAuthorization: commitAuthorization,
          });

          expect(commitAuthorization).toHaveBeenCalledWith(
            expect.objectContaining({
              authorization: expect.objectContaining({
                source: "ask-fallback",
                requireExactCommandApproval: true,
              }),
            }),
          );
          expect(invoke.runCommand).toHaveBeenCalledTimes(1);
          expectInvokeOk(invoke.sendInvokeResult);
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects allowlist timeout fallback when its durable source is removed before commit",
    async () => {
      const tempDir = createFixtureDir("openclaw-fallback-durable-revoked-");
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-c", "/bin/ls"],
        cwd: tempDir,
        sessionKey: "agent:main:main",
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      const commandPattern = `=command:${crypto
        .createHash("sha256")
        .update(prepared.plan.commandText)
        .digest("hex")
        .slice(0, 16)}`;
      await withTempApprovalsHome({
        approvals: {
          version: 1,
          defaults: { security: "full", ask: "always", askFallback: "allowlist" },
          agents: {
            main: { allowlist: [{ pattern: commandPattern, source: "allow-always" }] },
          },
        },
        run: async () => {
          const commitAuthorization = vi.fn(
            async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
              const current = loadExecApprovals();
              current.agents = {
                ...current.agents,
                main: { allowlist: [{ pattern: commandPattern }] },
              };
              saveExecApprovals(current);
              await commitExecAuthorizationLocked(params);
            },
          );
          const invoke = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: prepared.plan.argv,
            rawCommand: prepared.plan.commandText,
            systemRunPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
            security: "full",
            ask: "always",
            approvalSource: "ask-fallback",
            commitExecAuthorization: commitAuthorization,
          });

          expect(commitAuthorization).toHaveBeenCalledWith(
            expect.objectContaining({
              authorization: expect.objectContaining({
                source: "ask-fallback",
                requireExactCommandApproval: true,
              }),
            }),
          );
          expect(invoke.runCommand).not.toHaveBeenCalled();
          expectApprovalStateWriteDenied(invoke);
        },
      });
    },
  );

  it("preserves source-only fallback across the authenticated Mac app bridge", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "full" },
        agents: {},
      },
      run: async () => {
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: true,
          runViaResponse: createMacExecHostSuccess(),
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          security: "full",
          ask: "always",
          approvalSource: "ask-fallback",
        });

        const call = requireMacExecHostCall(invoke.runViaMacAppExecHost);
        expect(call.request?.approvalSource).toBe("ask-fallback");
        expect(call.request?.approvalDecision).toBeNull();
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectInvokeOk(invoke.sendInvokeResult, { payloadContains: "app-ok" });
      },
    });
  });

  it("preserves marker-only auto-review across the authenticated Mac app bridge", async () => {
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "ok"],
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "on-miss", askFallback: "deny" },
      },
      run: async () => {
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: true,
          runViaResponse: createMacExecHostSuccess(),
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          security: "full",
          ask: "on-miss",
          approvalSource: "auto-review",
        });

        const call = requireMacExecHostCall(invoke.runViaMacAppExecHost);
        expect(call.request?.approvalSource).toBe("auto-review");
        expect(call.request?.approvalDecision).toBeNull();
        expect(call.request?.policySnapshot).toEqual(
          createExecApprovalPolicySnapshot({ file: loadExecApprovals(), agentId: undefined }),
        );
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectInvokeOk(invoke.sendInvokeResult, { payloadContains: "app-ok" });
      },
    });
  });

  it("does not let timeout fallback satisfy strict inline review", async () => {
    const plan = createStrictInlineEvalApprovalPlan("openclaw-fallback-inline-");
    setRuntimeConfigSnapshot({ tools: { exec: { strictInlineEval: true } } });
    try {
      await withTempApprovalsHome({
        approvals: {
          version: 1,
          defaults: { security: "full", ask: "always", askFallback: "full" },
          agents: {},
        },
        run: async () => {
          const invoke = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: plan.argv,
            rawCommand: plan.commandText,
            systemRunPlan: plan,
            approvalSource: "ask-fallback",
          });

          expect(invoke.runCommand).not.toHaveBeenCalled();
          expectInvokeErrorMessage(invoke.sendInvokeResult, {
            message: "requires explicit approval in strictInlineEval mode",
          });
        },
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not let timeout fallback authorize security audit suppression edits", async () => {
    const tmp = createFixtureDir("openclaw-timeout-fallback-suppression-");
    const executablePath = createTempExecutable({ dir: tmp, name: "openclaw" });
    const prepared = buildSystemRunApprovalPlan({
      command: [executablePath, "config", "set", "security.audit.suppressions", "[]"],
      cwd: tmp,
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "always", askFallback: "full" },
        agents: {},
      },
      run: async () => {
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: tmp,
          approvalSource: "ask-fallback",
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalRequiredDenied({
          sendNodeEvent: invoke.sendNodeEvent,
          sendInvokeResult: invoke.sendInvokeResult,
        });
      },
    });
  });

  it("keeps audit suppression edits approval-gated under allowlist fallback from full/off", async () => {
    const tmp = createFixtureDir("openclaw-timeout-fallback-full-off-suppression-");
    const executablePath = createTempExecutable({ dir: tmp, name: "openclaw" });
    const prepared = buildSystemRunApprovalPlan({
      command: [executablePath, "config", "set", "security.audit.suppressions", "[]"],
      cwd: tmp,
      sessionKey: "agent:main:main",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "allowlist" },
        agents: {
          main: { allowlist: [{ pattern: fs.realpathSync(executablePath) }] },
        },
      },
      run: async () => {
        const invoke = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: tmp,
          security: "full",
          ask: "off",
          approvalSource: "ask-fallback",
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalRequiredDenied({
          sendNodeEvent: invoke.sendNodeEvent,
          sendInvokeResult: invoke.sendInvokeResult,
        });
      },
    });
  });

  it("rejects unknown approval provenance", async () => {
    const invoke = await runSystemInvoke({
      preferMacAppExecHost: false,
      security: "full",
      ask: "off",
      approved: true,
      approvalDecision: "allow-once",
      approvalSource: "explicit",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, {
      message: "approvalSource invalid",
      exact: true,
    });
  });

  it("rejects unbindable strict inline-eval carriers before delayed approval", async () => {
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals(),
        run: async () => {
          const tempDir = createFixtureDir("openclaw-inline-eval-bin-");
          const executablePath = createTempExecutable({
            dir: tempDir,
            name: "python3.13",
          });
          const prepared = buildSystemRunApprovalPlan({
            command: [executablePath, "-c", "print('hi')"],
          });

          expect(prepared).toEqual({
            ok: false,
            message:
              "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
          });
          expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
        },
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("persists benign awk allow-always approvals in strict inline-eval mode without reopening inline carriers", async () => {
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals(),
        run: async () => {
          const tempDir = createFixtureDir("openclaw-inline-eval-awk-");
          const executablePath = createTempExecutable({
            dir: tempDir,
            name: "gawk",
          });
          fs.writeFileSync(path.join(tempDir, "script.awk"), "{ print }\n");
          const benign = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: [executablePath, "-F", ",", "-f", "script.awk"],
            cwd: tempDir,
            security: "allowlist",
            ask: "on-miss",
            approvalDecision: "allow-always",
            approved: true,
            runCommand: vi.fn(async () => createLocalRunResult("awk-ok")),
          });

          expect(benign.runCommand).toHaveBeenCalledTimes(1);
          expectInvokeOk(benign.sendInvokeResult, { payloadContains: "awk-ok" });
          const allowlist = loadExecApprovals().agents?.main?.allowlist ?? [];
          expect(allowlist).toHaveLength(2);
          expect(allowlist[0]?.pattern).toBe(fs.realpathSync(executablePath));
          expect(allowlist[0]?.lastUsedCommand).toBeUndefined();
          expect(allowlist[1]?.pattern).toMatch(/^=node-command:[0-9a-f]{16}$/);
          expect(allowlist[1]?.lastUsedCommand).toBeUndefined();

          const malicious = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: [executablePath, 'BEGIN{system("id")}', "/dev/null"],
            cwd: tempDir,
            security: "allowlist",
            ask: "on-miss",
          });

          expect(malicious.runCommand).not.toHaveBeenCalled();
          expectInvokeErrorMessage(malicious.sendInvokeResult, {
            message: "awk inline program requires explicit approval in strictInlineEval mode",
          });
        },
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not persist allow-always approvals for strict inline-eval make carriers", async () => {
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals(),
        run: async () => {
          const tempDir = createFixtureDir("openclaw-inline-eval-make-");
          const executablePath = createTempExecutable({
            dir: tempDir,
            name: "make",
          });
          const makefilePath = path.join(tempDir, "Makefile");
          fs.writeFileSync(makefilePath, "all:\n\t@echo inline-eval-ok\n");
          const prepared = buildSystemRunApprovalPlan({
            command: [executablePath, "-f", makefilePath],
            cwd: tempDir,
          });
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) {
            throw new Error("unreachable");
          }

          const { runCommand, sendInvokeResult } = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: prepared.plan.argv,
            rawCommand: prepared.plan.commandText,
            systemRunPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
            security: "allowlist",
            ask: "on-miss",
            approvalDecision: "allow-always",
            approved: true,
            runCommand: vi.fn(async () => createLocalRunResult("inline-eval-ok")),
          });

          expect(runCommand).toHaveBeenCalledTimes(1);
          expectInvokeOk(sendInvokeResult, { payloadContains: "inline-eval-ok" });
          expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
        },
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.runIf(process.platform !== "win32")(
    "auto-runs allowlisted inner scripts through transport shell wrappers",
    async () => {
      const tempDir = createFixtureDir("openclaw-shell-wrapper-inner-");
      const scriptsDir = path.join(tempDir, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      const scriptPath = path.join(scriptsDir, "check_mail.sh");
      fs.writeFileSync(scriptPath, "#!/bin/sh\necho ok\n");
      fs.chmodSync(scriptPath, 0o755);

      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals({
          agents: {
            main: {
              allowlist: [{ pattern: fs.realpathSync(scriptPath) }],
            },
          },
        }),
        run: async () => {
          const invoke = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: ["/bin/sh", "-lc", "./scripts/check_mail.sh --limit 5"],
            rawCommand: '/bin/sh -lc "./scripts/check_mail.sh --limit 5"',
            cwd: tempDir,
            security: "allowlist",
            ask: "on-miss",
            runCommand: vi.fn(async () => createLocalRunResult("shell-wrapper-inner-ok")),
          });

          expect(invoke.runCommand).toHaveBeenCalledTimes(1);
          expectInvokeOk(invoke.sendInvokeResult, {
            payloadContains: "shell-wrapper-inner-ok",
          });
        },
      });
    },
  );

  it("keeps cmd.exe transport wrappers approval-gated on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      for (const testCase of [
        {
          name: "env-assignment cmd.exe",
          commandPrefix: ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c"],
        },
      ]) {
        const tempDir = createFixtureDir("openclaw-cmd-wrapper-allow-");
        const scriptPath = path.join(tempDir, "check_mail.cmd");
        fs.writeFileSync(scriptPath, "@echo off\r\necho ok\r\n");
        const command = [...testCase.commandPrefix, `${scriptPath} --limit 5`];

        await withTempApprovalsHome({
          approvals: createAllowlistOnMissApprovals({
            agents: {
              main: {
                allowlist: [{ pattern: scriptPath }],
              },
            },
          }),
          run: async () => {
            const seenArgv: string[][] = [];
            const invoke = await runSystemInvoke({
              preferMacAppExecHost: false,
              command,
              cwd: tempDir,
              security: "allowlist",
              ask: "on-miss",
              isCmdExeInvocation: (argv) => {
                seenArgv.push([...argv]);
                const token = argv[0]?.trim();
                if (!token) {
                  return false;
                }
                const base = path.win32.basename(token).toLowerCase();
                return base === "cmd.exe" || base === "cmd";
              },
            });

            expect(seenArgv, testCase.name).toEqual([
              ["cmd.exe", "/d", "/s", "/c", `${scriptPath} --limit 5`],
            ]);
            expect(invoke.runCommand, testCase.name).not.toHaveBeenCalled();
            expectApprovalRequiredDenied({
              sendNodeEvent: invoke.sendNodeEvent,
              sendInvokeResult: invoke.sendInvokeResult,
            });
          },
        });
      }
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("fails closed when cmd.exe wrapper trust is downgraded before execution", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const tempDir = createFixtureDir("openclaw-cmd-wrapper-downgraded-");
      const commandName = "check_mail.cmd";
      const command = ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c", `${commandName} --limit 5`];
      const ordinaryPattern = "*";
      const prepared = buildSystemRunApprovalPlan({ command, cwd: tempDir });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      const commandPattern = `=command:${crypto
        .createHash("sha256")
        .update(prepared.plan.commandText)
        .digest("hex")
        .slice(0, 16)}`;

      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals({
          agents: {
            main: {
              allowlist: [
                { pattern: ordinaryPattern },
                { pattern: commandPattern, source: "allow-always" },
              ],
            },
          },
        }),
        run: async () => {
          const commitAuthorization = vi.fn(
            async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
              const current = loadExecApprovals();
              current.agents = {
                ...current.agents,
                main: {
                  allowlist: [{ pattern: ordinaryPattern }, { pattern: commandPattern }],
                },
              };
              saveExecApprovals(current);
              await commitExecAuthorizationLocked(params);
            },
          );
          const invoke = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: prepared.plan.argv,
            rawCommand: prepared.plan.commandText,
            systemRunPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
            security: "allowlist",
            ask: "on-miss",
            isCmdExeInvocation: (argv) => {
              const token = argv[0]?.trim();
              if (!token) {
                return false;
              }
              const base = path.win32.basename(token).toLowerCase();
              return base === "cmd.exe" || base === "cmd";
            },
            commitExecAuthorization: commitAuthorization,
          });

          expect(commitAuthorization).toHaveBeenCalledWith(
            expect.objectContaining({
              authorization: expect.objectContaining({
                source: "current-policy",
                requireExactCommandApproval: true,
              }),
            }),
          );
          expect(invoke.runCommand).not.toHaveBeenCalled();
          expect(invoke.sendExecFinishedEvent).not.toHaveBeenCalled();
          expectApprovalStateWriteDenied(invoke);
        },
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("reuses exact-command durable trust for shell-wrapper reruns", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = createFixtureDir("openclaw-shell-wrapper-allow-");
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-c", "/bin/ls"],
      cwd: tempDir,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }

    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss", askFallback: "full" },
        agents: {
          main: {
            allowlist: [
              {
                pattern: `=command:${crypto
                  .createHash("sha256")
                  .update(prepared.plan.commandText)
                  .digest("hex")
                  .slice(0, 16)}`,
                source: "allow-always",
              },
            ],
          },
        },
      },
      run: async () => {
        const rerun = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? tempDir,
          security: "allowlist",
          ask: "on-miss",
          runCommand: vi.fn(async () => createLocalRunResult("shell-wrapper-reused")),
        });

        expect(rerun.runCommand).toHaveBeenCalledTimes(1);
        expectInvokeOk(rerun.sendInvokeResult, { payloadContains: "shell-wrapper-reused" });
      },
    });
  });

  it("does not bind safe builtin policy to a redundant exact-command grant", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = createFixtureDir("openclaw-shell-wrapper-redundant-grant-");
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-c", "cd ."],
      cwd: tempDir,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    const commandPattern = `=command:${crypto
      .createHash("sha256")
      .update(prepared.plan.commandText)
      .digest("hex")
      .slice(0, 16)}`;

    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss", askFallback: "full" },
        agents: {
          main: {
            allowlist: [{ pattern: commandPattern, source: "allow-always" }],
          },
        },
      },
      run: async () => {
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            const current = loadExecApprovals();
            current.agents = { ...current.agents, main: { allowlist: [] } };
            saveExecApprovals(current);
            await commitExecAuthorizationLocked(params);
          },
        );
        const rerun = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? tempDir,
          security: "allowlist",
          ask: "on-miss",
          commitExecAuthorization: commitAuthorization,
          runCommand: vi.fn(async () => createLocalRunResult("safe-builtin-ok")),
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({
              source: "current-policy",
              requireExactCommandApproval: false,
              requireDurableAllowlistApproval: false,
            }),
          }),
        );
        expect(rerun.runCommand).toHaveBeenCalledTimes(1);
        expectInvokeOk(rerun.sendInvokeResult, { payloadContains: "safe-builtin-ok" });
      },
    });
  });

  it("fails closed when an exact-command grant is revoked before execution", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = createFixtureDir("openclaw-shell-wrapper-revoked-");
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-c", "/bin/ls"],
      cwd: tempDir,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    const commandPattern = `=command:${crypto
      .createHash("sha256")
      .update(prepared.plan.commandText)
      .digest("hex")
      .slice(0, 16)}`;

    await withTempApprovalsHome({
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss", askFallback: "full" },
        agents: {
          main: {
            allowlist: [{ pattern: commandPattern, source: "allow-always" }],
          },
        },
      },
      run: async () => {
        const commitAuthorization = vi.fn(
          async (params: Parameters<typeof commitExecAuthorizationLocked>[0]) => {
            const current = loadExecApprovals();
            current.agents = { ...current.agents, main: { allowlist: [] } };
            saveExecApprovals(current);
            await commitExecAuthorizationLocked(params);
          },
        );
        const rerun = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: prepared.plan.argv,
          rawCommand: prepared.plan.commandText,
          systemRunPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? tempDir,
          security: "allowlist",
          ask: "on-miss",
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).toHaveBeenCalledWith(
          expect.objectContaining({
            authorization: expect.objectContaining({
              source: "current-policy",
              requireExactCommandApproval: true,
            }),
          }),
        );
        expect(rerun.runCommand).not.toHaveBeenCalled();
        expect(rerun.sendExecFinishedEvent).not.toHaveBeenCalled();
        expectApprovalStateWriteDenied(rerun);
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
