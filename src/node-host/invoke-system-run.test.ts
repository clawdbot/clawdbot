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
import { deleteExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import type { ExecAsk, ExecSecurity, SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import {
  commitExecAuthorizationLocked,
  createExecApprovalPolicySnapshot,
  loadExecApprovals,
  saveExecApprovals,
} from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { ExecHostResponse } from "../infra/exec-host.js";
import { formatExecCommand } from "../infra/system-run-command.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
type InvokeSpies = {
  runCommand: MockedRunCommand;
  runViaMacAppExecHost: MockedRunViaMacAppExecHost;
  sendInvokeResult: MockedSendInvokeResult;
  sendExecFinishedEvent: MockedSendExecFinishedEvent;
  sendNodeEvent: MockedSendNodeEvent;
};
type InvokeResult = {
  ok?: boolean;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
};
type MacExecHostCall = {
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

describe("handleSystemRunInvoke mac app exec host routing", () => {
  let sharedFixtureRoot = "";
  let sharedOpenClawHome = "";
  let sharedRuntimeBinDir = "";
  let sharedFixtureId = 0;
  let previousOpenClawHome: string | undefined;
  const sharedRuntimeBins = new Set<string>();

  beforeAll(() => {
    closeOpenClawStateDatabaseForTest();
    sharedFixtureRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-host-fixtures-")),
    );
    sharedOpenClawHome = path.join(sharedFixtureRoot, "openclaw-home");
    sharedRuntimeBinDir = path.join(sharedFixtureRoot, "bin");
    fs.mkdirSync(sharedOpenClawHome, { recursive: true });
    fs.mkdirSync(sharedRuntimeBinDir, { recursive: true });
  });

  afterAll(() => {
    closeOpenClawStateDatabaseForTest();
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
    execApprovalsStoreTesting.reset();
    // Cases isolate the canonical policy row, not shared-state schema bootstrap.
    deleteExecApprovalsConfigRow(openOpenClawStateDatabase().db);
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    execApprovalsStoreTesting.reset();
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

  function createTempExecutable(dir: string, name: string): string {
    const fileName = process.platform === "win32" ? `${name}.exe` : name;
    const executablePath = path.join(dir, fileName);
    fs.writeFileSync(executablePath, "");
    fs.chmodSync(executablePath, 0o755);
    return executablePath;
  }

  function createStrictInlineEvalApprovalPlan(prefix: string): SystemRunApprovalPlan {
    const tempDir = createFixtureDir(prefix);
    const executablePath = createTempExecutable(tempDir, "gawk");
    const scriptPath = path.join(tempDir, "library.awk");
    fs.writeFileSync(scriptPath, "{ print }\n");
    const prepared = buildSessionApprovalPlan(
      [executablePath, "-f", scriptPath, '--source=BEGIN{print "safe"}'],
      "agent:main:main",
    );
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    return prepared.plan;
  }

  function bindCurrentPolicyToPlan(plan: SystemRunApprovalPlan): SystemRunApprovalPlan {
    const agentId = plan.agentId ?? "main";
    return {
      ...plan,
      agentId,
      sessionKey: plan.sessionKey ?? "agent:main:main",
      policySnapshot: createExecApprovalPolicySnapshot({
        file: loadExecApprovals(),
        agentId,
      }),
    };
  }

  function requireApprovalPlan(
    prepared: ReturnType<typeof buildSystemRunApprovalPlan>,
    message: string,
  ): asserts prepared is Extract<ReturnType<typeof buildSystemRunApprovalPlan>, { ok: true }> {
    if (!prepared.ok) {
      throw new Error(message);
    }
  }

  function buildSessionApprovalPlan(command: string[], sessionKey: string) {
    return buildSystemRunApprovalPlan({ command, sessionKey });
  }

  function buildCwdApprovalPlan(command: string[], cwd: string) {
    return buildSystemRunApprovalPlan({ command, cwd });
  }

  function buildCwdSessionApprovalPlan(command: string[], cwd: string, sessionKey: string) {
    return buildSystemRunApprovalPlan({ command, cwd, sessionKey });
  }

  function expectInvokeOk(sendInvokeResult: MockedSendInvokeResult, payloadContains?: string) {
    const params = payloadContains === undefined ? undefined : { payloadContains };
    const result = requireInvokeResult(sendInvokeResult);
    expect(result.ok).toBe(true);
    if (params?.payloadContains) {
      expect(result.payloadJSON).toContain(params.payloadContains);
    }
  }

  function expectInvokeErrorMessage(
    sendInvokeResult: MockedSendInvokeResult,
    expectedMessage: string,
    exact = false,
  ) {
    const params = { message: expectedMessage, exact };
    const result = requireInvokeResult(sendInvokeResult);
    expect(result.ok).toBe(false);
    const message = result.error?.message;
    if (params.exact) {
      expect(message).toBe(params.message);
    } else {
      expect(message).toContain(params.message);
    }
  }

  function requireInvokeResult(sendInvokeResult: MockedSendInvokeResult): InvokeResult {
    const result = firstMockCallArg(sendInvokeResult, "sendInvokeResult", 0);
    return result as InvokeResult;
  }

  function requireFirstRunCommandArgs(runCommand: MockedRunCommand): string[] {
    return firstMockCallArg(vi.mocked(runCommand), "runCommand", 0) as string[];
  }

  function requireMacExecHostCall(
    runViaMacAppExecHost: MockedRunViaMacAppExecHost,
  ): MacExecHostCall {
    const call = firstMockCallArg(runViaMacAppExecHost, "runViaMacAppExecHost", 0);
    return call as MacExecHostCall;
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

  function expectApprovalRequiredDenied(
    sendNodeEvent: MockedSendNodeEvent,
    sendInvokeResult: MockedSendInvokeResult,
  ) {
    const params = { sendNodeEvent, sendInvokeResult };
    expectExecDeniedEvent(params.sendNodeEvent);
    expectInvokeErrorMessage(
      params.sendInvokeResult,
      "SYSTEM_RUN_DENIED: approval required — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
      true,
    );
  }

  function expectApprovalStateWriteDenied(params: {
    sendNodeEvent: MockedSendNodeEvent;
    sendInvokeResult: MockedSendInvokeResult;
  }) {
    expectExecDeniedEvent(params.sendNodeEvent, "approval-state-write-failed");
    expect(requireInvokeResult(params.sendInvokeResult)).toMatchObject({
      ok: false,
      error: {
        code: "SYSTEM_RUN_DENIED",
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

  function createRuntimeScriptOperandFixture(
    tmp: string,
    runtime: "bun" | "deno" | "jiti" | "tsx",
  ): {
    command: string[];
    scriptPath: string;
    initialBody: string;
    changedBody: string;
  } {
    const scriptPath = path.join(tmp, "run.ts");
    const initialBody = 'console.log("SAFE");\n';
    const changedBody = 'console.log("PWNED");\n';
    switch (runtime) {
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
    const unsupportedRuntime: never = runtime;
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

  function createApprovals(
    security: ExecSecurity,
    ask: ExecAsk,
    askFallback: ExecSecurity,
    agents?: Parameters<typeof saveExecApprovals>[0]["agents"],
  ): Parameters<typeof saveExecApprovals>[0] {
    return {
      version: 1,
      defaults: { security, ask, askFallback },
      ...(agents === undefined ? {} : { agents }),
    };
  }

  function createExactCommandPattern(commandText: string): string {
    return `=command:${crypto.createHash("sha256").update(commandText).digest("hex").slice(0, 16)}`;
  }

  function resolveProductionExecSecurity(value?: string): "deny" | "allowlist" | "full" {
    return value === "deny" || value === "allowlist" || value === "full" ? value : "allowlist";
  }

  function resolveProductionExecAsk(value?: string): "off" | "on-miss" | "always" {
    return value === "off" || value === "on-miss" || value === "always" ? value : "on-miss";
  }

  function createInvokeSpies(params?: {
    runCommand?: HandleSystemRunInvokeOptions["runCommand"];
    runViaMacAppExecHost?: HandleSystemRunInvokeOptions["runViaMacAppExecHost"];
    sendInvokeResult?: HandleSystemRunInvokeOptions["sendInvokeResult"];
    sendExecFinishedEvent?: HandleSystemRunInvokeOptions["sendExecFinishedEvent"];
    sendNodeEvent?: HandleSystemRunInvokeOptions["sendNodeEvent"];
  }): InvokeSpies {
    return {
      runCommand: vi.fn(params?.runCommand ?? (async () => createLocalRunResult())),
      runViaMacAppExecHost: vi.fn(params?.runViaMacAppExecHost ?? (async () => null)),
      sendInvokeResult: vi.fn(params?.sendInvokeResult ?? (async () => {})),
      sendExecFinishedEvent: vi.fn(params?.sendExecFinishedEvent ?? (async () => {})),
      sendNodeEvent: vi.fn(params?.sendNodeEvent ?? (async () => {})),
    };
  }

  function createPolicyMutationCommit(
    mutate: (current: ReturnType<typeof loadExecApprovals>) => void,
  ): Mock<NonNullable<HandleSystemRunInvokeOptions["commitExecAuthorization"]>> {
    return vi.fn(async (params) => {
      const current = loadExecApprovals();
      mutate(current);
      saveExecApprovals(current);
      await commitExecAuthorizationLocked(params);
    });
  }

  async function withTempApprovalsHome<T>(
    approvals: Parameters<typeof saveExecApprovals>[0],
    run: (ctx: { tempHome: string }) => Promise<T>,
  ): Promise<T> {
    const tempHome = sharedOpenClawHome;
    return await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
      saveExecApprovals(approvals);
      return await run({ tempHome });
    });
  }

  async function withPathTokenCommand<T>(
    tmpPrefix: string,
    run: (ctx: { link: string; expected: string }) => Promise<T>,
  ): Promise<T> {
    const tmp = createFixtureDir(tmpPrefix);
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "poccmd");
    fs.symlinkSync("/bin/echo", link);
    const expected = fs.realpathSync(link);
    return await withEnvAsync({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }, () =>
      run({ link, expected }),
    );
  }

  async function withFakeRuntimeOnPath<T>(
    runtime: "bun" | "deno" | "jiti" | "tsx",
    run: () => Promise<T>,
  ): Promise<T> {
    if (!sharedRuntimeBins.has(runtime)) {
      const runtimePath =
        process.platform === "win32"
          ? path.join(sharedRuntimeBinDir, `${runtime}.cmd`)
          : path.join(sharedRuntimeBinDir, runtime);
      const runtimeBody =
        process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
      fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
      if (process.platform !== "win32") {
        fs.chmodSync(runtimePath, 0o755);
      }
      sharedRuntimeBins.add(runtime);
    }
    return await withEnvAsync(
      { PATH: `${sharedRuntimeBinDir}${path.delimiter}${process.env.PATH ?? ""}` },
      run,
    );
  }

  function expectCommandPinnedToCanonicalPath(
    runCommand: MockedRunCommand,
    expected: string,
    commandTail: string[],
    cwd?: string,
  ) {
    const params = { runCommand, expected, commandTail, cwd };
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
    execHostFallbackAllowed?: boolean;
    runViaResponse?: ExecHostResponse | null;
    command?: string[];
    env?: Record<string, string>;
    rawCommand?: string | null;
    systemRunPlan?: SystemRunApprovalPlan | null;
    preparedPlan?: SystemRunApprovalPlan;
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
    signal?: AbortSignal;
  }): Promise<InvokeSpies> {
    const spies = createInvokeSpies({
      runCommand: params.runCommand,
      runViaMacAppExecHost:
        params.runViaMacAppExecHost ?? (async () => params.runViaResponse ?? null),
      sendInvokeResult: params.sendInvokeResult,
      sendExecFinishedEvent: params.sendExecFinishedEvent,
      sendNodeEvent: params.sendNodeEvent,
    });

    const command = params.command ?? params.preparedPlan?.argv ?? ["echo", "ok"];
    let dispatchCommand = command;
    let dispatchRawCommand = params.rawCommand ?? params.preparedPlan?.commandText;
    let dispatchCwd = params.cwd ?? params.preparedPlan?.cwd ?? undefined;
    let dispatchAgentId: string | undefined = params.agentId ?? "main";
    const forwardsDelayedApproval =
      params.approvalSource === "auto-review" ||
      params.approved === true ||
      params.approvalDecision === "allow" ||
      params.approvalDecision === "allow-once" ||
      params.approvalDecision === "allow-always";
    const providedPlan = params.preparedPlan ?? params.systemRunPlan ?? undefined;
    let systemRunPlan: SystemRunApprovalPlan | undefined = providedPlan
      ? {
          ...providedPlan,
          agentId: providedPlan.agentId ?? dispatchAgentId,
          sessionKey: providedPlan.sessionKey ?? "agent:main:main",
        }
      : undefined;
    if (forwardsDelayedApproval && params.prepareDelayedApprovalPlan !== false) {
      if (!systemRunPlan) {
        const prepared = buildSystemRunApprovalPlan({
          command,
          rawCommand: params.rawCommand,
          cwd: params.cwd,
          agentId: dispatchAgentId,
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
      signal: params.signal,
      execHostEnforced: false,
      execHostFallbackAllowed: params.execHostFallbackAllowed ?? true,
      resolveExecSecurity: params.resolveExecSecurity ?? (() => params.security ?? "full"),
      resolveExecAsk: params.resolveExecAsk ?? (() => params.ask ?? "off"),
      isCmdExeInvocation: params.isCmdExeInvocation ?? (() => false),
      sanitizeEnv: params.sanitizeEnv ?? (() => undefined),
      ...spies,
      buildExecEventPayload: (payload) => payload,
      preferMacAppExecHost: params.preferMacAppExecHost,
      getRuntimeConfig: () => getRuntimeConfigSnapshot() ?? {},
      autoReviewer: params.autoReviewer,
      commitExecAuthorization: params.commitExecAuthorization,
    });

    return spies;
  }

  type SystemInvokeFixtureParams = Parameters<typeof runSystemInvoke>[0];

  async function runLocalSystemInvoke(
    params: Omit<SystemInvokeFixtureParams, "preferMacAppExecHost"> = {},
  ) {
    return await runSystemInvoke({ ...params, preferMacAppExecHost: false });
  }

  async function runMacSystemInvoke(
    params: Omit<SystemInvokeFixtureParams, "preferMacAppExecHost"> = {},
  ) {
    return await runSystemInvoke({ ...params, preferMacAppExecHost: true });
  }

  type ExplicitSystemInvokePolicy = {
    security: NonNullable<SystemInvokeFixtureParams["security"]>;
    ask: NonNullable<SystemInvokeFixtureParams["ask"]>;
  };

  async function runLocalSystemInvokeWithPolicy(
    security: ExplicitSystemInvokePolicy["security"],
    ask: ExplicitSystemInvokePolicy["ask"],
    params: Omit<SystemInvokeFixtureParams, "preferMacAppExecHost" | "security" | "ask"> = {},
  ) {
    return await runLocalSystemInvoke({ ...params, security, ask });
  }

  async function runMacSystemInvokeWithPolicy(
    security: ExplicitSystemInvokePolicy["security"],
    ask: ExplicitSystemInvokePolicy["ask"],
    params: Omit<SystemInvokeFixtureParams, "preferMacAppExecHost" | "security" | "ask"> = {},
  ) {
    return await runMacSystemInvoke({ ...params, security, ask });
  }

  it("preserves a native cwd refusal without labelling it approval-required", async () => {
    const result = await runMacSystemInvoke({
      runViaResponse: {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          reason: "cwd-unavailable",
          message: "Working directory does not exist, is inaccessible, or is not a directory.",
        },
      },
    });
    expectExecDeniedEvent(result.sendNodeEvent, "cwd-unavailable");
    expect(result.runCommand).not.toHaveBeenCalled();
  });

  it("keeps a lost companion response ambiguous", async () => {
    const result = await runMacSystemInvoke({ execHostFallbackAllowed: false });
    expect(result.runViaMacAppExecHost).toHaveBeenCalledOnce();
    expect(result.runCommand).not.toHaveBeenCalled();
    expect(requireInvokeResult(result.sendInvokeResult)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
  });

  it("forwards cancellation to locally spawned node commands", async () => {
    const controller = new AbortController();
    const result = await runLocalSystemInvoke({ signal: controller.signal });

    expect(result.runCommand.mock.calls[0]?.[4]).toBe(controller.signal);
  });

  it("does not spawn an already-cancelled node command", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runLocalSystemInvoke({ signal: controller.signal });

    expect(result.runCommand).not.toHaveBeenCalled();
    expect(result.runViaMacAppExecHost).not.toHaveBeenCalled();
  });

  it("does not publish a cancelled local command completion", async () => {
    const controller = new AbortController();
    const result = await runLocalSystemInvoke({
      signal: controller.signal,
      runCommand: async () => {
        controller.abort();
        return createLocalRunResult("cancelled");
      },
    });

    expect(result.runCommand).toHaveBeenCalledOnce();
    expect(result.sendInvokeResult).not.toHaveBeenCalled();
    expect(result.sendExecFinishedEvent).not.toHaveBeenCalled();
  });

  it.each([null, createMacExecHostSuccess()])(
    "cancels pending Mac exec without replay or publication (%j)",
    async (response) => {
      const controller = new AbortController();
      const result = await runMacSystemInvoke({
        signal: controller.signal,
        runViaMacAppExecHost: ({ signal }) => {
          expect(signal).toBe(controller.signal);
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve(response), { once: true });
            queueMicrotask(() => controller.abort());
          });
        },
      });

      expect(result.runViaMacAppExecHost).toHaveBeenCalledOnce();
      expect(result.runCommand).not.toHaveBeenCalled();
      expect(result.sendNodeEvent).not.toHaveBeenCalled();
      expect(result.sendInvokeResult).not.toHaveBeenCalled();
      expect(result.sendExecFinishedEvent).not.toHaveBeenCalled();
    },
  );

  it("does not append the escalation hint to freeform mac exec-host denials", async () => {
    // Host-authored freeform messages (cancelled prompt, temporarily unavailable
    // approval store) may describe retryable outcomes; the normalized reason
    // does not establish that an exec-policy change would fix them.
    const result = await runMacSystemInvoke({
      runViaMacAppExecHost: async () => ({
        ok: false as const,
        error: {
          code: "APPROVAL_CANCELLED",
          message: "approval prompt cancelled",
          reason: "approval-required",
        },
      }),
    });

    expect(result.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(result.sendInvokeResult, "approval prompt cancelled", true);
  });

  it("does not append the escalation hint to screen-recording permission denials", async () => {
    // The fix for a missing Screen Recording permission is granting the macOS
    // permission, not adjusting exec policy — the hint would misdirect.
    const result = await runMacSystemInvoke({
      runViaMacAppExecHost: async () => ({
        ok: false as const,
        error: {
          code: "PERMISSION_MISSING",
          message: "PERMISSION_MISSING: screenRecording",
          reason: "permission:screenRecording",
        },
      }),
    });

    expect(result.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(result.sendInvokeResult, "PERMISSION_MISSING: screenRecording", true);
  });

  it("does not publish a cancelled Mac exec-host completion", async () => {
    const controller = new AbortController();
    const result = await runMacSystemInvoke({
      signal: controller.signal,
      runViaMacAppExecHost: async () => {
        controller.abort();
        return { ok: true, payload: createLocalRunResult("cancelled") };
      },
    });

    expect(result.runViaMacAppExecHost).toHaveBeenCalledOnce();
    expect(result.sendInvokeResult).not.toHaveBeenCalled();
    expect(result.sendExecFinishedEvent).not.toHaveBeenCalled();
  });

  it("routes local, mac host, and canonical shell-wrapper requests", async () => {
    const localInvoke = await runLocalSystemInvoke({});

    expect(localInvoke.runViaMacAppExecHost).not.toHaveBeenCalled();
    expect(localInvoke.runCommand).toHaveBeenCalledTimes(1);
    expectInvokeOk(localInvoke.sendInvokeResult, "local-ok");

    const macHostInvoke = await runMacSystemInvoke({ runViaResponse: createMacExecHostSuccess() });

    const macHostCall = requireMacExecHostCall(macHostInvoke.runViaMacAppExecHost);
    expect(macHostCall.approvals?.agent?.security).toBe("full");
    expect(macHostCall.approvals?.agent?.ask).toBe("off");
    expect(macHostCall.request?.command).toEqual(["echo", "ok"]);
    expect(macHostInvoke.runCommand).not.toHaveBeenCalled();
    expectInvokeOk(macHostInvoke.sendInvokeResult, "app-ok");

    const shellWrapperInvoke = await runMacSystemInvoke({
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
    const executablePath = createTempExecutable(tmp, "read-info");
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
      const prepared = buildCwdApprovalPlan([executablePath], tmp);
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const invoke = await runLocalSystemInvoke({
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
      expectInvokeOk(invoke.sendInvokeResult, "auto-reviewed");

      const macInvoke = await runMacSystemInvoke({
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
      expectInvokeOk(macInvoke.sendInvokeResult, "app-ok");
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not auto-review direct system.run approval misses without an approval plan", async () => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-no-plan-");
    const executablePath = createTempExecutable(tmp, "read-info");
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
      const invoke = await runLocalSystemInvoke({
        command: [executablePath],
        cwd: tmp,
        runCommand,
        resolveExecSecurity: resolveProductionExecSecurity,
        resolveExecAsk: resolveProductionExecAsk,
        autoReviewer,
      });

      expect(autoReviewer).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(invoke.sendInvokeResult, "SYSTEM_RUN_DENIED: approval required");
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.each([
    {
      name: "throws synchronously",
      reviewer: () => {
        throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
      },
    },
    {
      name: "rejects asynchronously",
      reviewer: async () => {
        throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
      },
    },
  ])("denies direct system.run when its reviewer $name", async ({ reviewer }) => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-failure-");
    const executablePath = createTempExecutable(tmp, "read-info");
    setRuntimeConfigSnapshot({ tools: { exec: { mode: "auto" } } });
    const autoReviewer = vi.fn<ExecAutoReviewer>(reviewer);
    const runCommand = vi.fn(async () => createLocalRunResult("should-not-run"));
    const prepared = buildCwdApprovalPlan([executablePath], tmp);
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "expected a bound system.run approval plan");

    const invoke = await runLocalSystemInvoke({
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
    expectInvokeErrorMessage(
      invoke.sendInvokeResult,
      "exec auto-review deferred to human approval: exec reviewer failed: provider\\nfailed",
    );
  });

  it.runIf(process.platform !== "win32").each(["bash", "sh", "/bin/sh"])(
    "does not auto-review direct %s login-shell startup",
    async (shell) => {
      const tmp = createFixtureDir("openclaw-system-run-auto-review-login-");
      setRuntimeConfigSnapshot({ tools: { exec: { mode: "auto" } } });
      try {
        const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
          decision: "allow-once",
          rationale: "unsafe startup wrapper must not reach the reviewer",
          risk: "low",
        }));
        const loginCommand = `${shell} -lc "echo auto-review-startup-proof"`;
        const command = ["/bin/sh", "-lc", loginCommand];
        // The real plan builder already rejects this wrapper. Exercise the
        // node trust boundary against a hostile, otherwise well-formed plan.
        const approvalPlan = {
          argv: command,
          cwd: tmp,
          commandText: formatExecCommand(command),
          agentId: "main",
          sessionKey: "agent:main:main",
        } satisfies SystemRunApprovalPlan;

        const invoke = await runLocalSystemInvoke({
          command,
          rawCommand: approvalPlan.commandText,
          cwd: tmp,
          systemRunPlan: approvalPlan,
          resolveExecSecurity: resolveProductionExecSecurity,
          resolveExecAsk: resolveProductionExecAsk,
          autoReviewer,
        });

        expect(autoReviewer).not.toHaveBeenCalled();
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(invoke.sendInvokeResult, "SYSTEM_RUN_DENIED: approval required");
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it("does not auto-review direct system.run security audit suppression edits", async () => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-suppression-");
    const executablePath = createTempExecutable(tmp, "openclaw");
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
      const prepared = buildCwdApprovalPlan(
        [executablePath, "config", "set", "security.audit.suppressions", "[]"],
        tmp,
      );
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const invoke = await runLocalSystemInvoke({
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
      expectInvokeErrorMessage(invoke.sendInvokeResult, "SYSTEM_RUN_DENIED: approval required");
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("defers to human approval when system.run auto reviewer asks", async () => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-ask-");
    const executablePath = createTempExecutable(tmp, "read-info");
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
      const prepared = buildCwdApprovalPlan([executablePath], tmp);
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const invoke = await runLocalSystemInvoke({
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
      expectInvokeErrorMessage(
        invoke.sendInvokeResult,
        "exec auto-review deferred to human approval",
      );
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
          expectInvokeOk(invoke.sendInvokeResult, "app-ok");
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
      const transparent = await runLocalSystemInvoke({
        security: "allowlist",
        command: ["env", "tr", "a", "b"],
      });
      if (process.platform === "win32") {
        expect(transparent.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(transparent.sendInvokeResult, "allowlist miss");
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

      const semantic = await runLocalSystemInvoke({
        security: "allowlist",
        command: ["env", "FOO=bar", "tr", "a", "b"],
      });
      expect(semantic.runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(semantic.sendInvokeResult, "allowlist miss");
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
      const { runCommand, sendInvokeResult, sendNodeEvent } = await runLocalSystemInvokeWithPolicy(
        "allowlist",
        testCase.ask ?? "on-miss",
        { command: testCase.command },
      );
      expect(runCommand, testCase.label).not.toHaveBeenCalled();
      if (testCase.approvalRequired) {
        expectApprovalRequiredDenied(sendNodeEvent, sendInvokeResult);
      } else if ("message" in testCase) {
        expectInvokeErrorMessage(sendInvokeResult, testCase.message);
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "denies safe-bin shell expansion carriers in allowlist mode",
    async () => {
      const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy(
        "allowlist",
        "off",
        {
          command: ["/bin/sh", "-lc", "head -c${IFS}16${IFS}${OPENCLAW_CONFIG_PATH}"],
          rawCommand: "head -c${IFS}16${IFS}${OPENCLAW_CONFIG_PATH}",
        },
      );

      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, "allowlist miss");
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
        const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy(
          "allowlist",
          "off",
          { command: ["/bin/sh", "-lc", "head -c 16"], rawCommand: "head -c 16" },
        );

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
        const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy(
          "allowlist",
          "off",
          {
            command: ["/bin/sh", "-lc", "sh -c 'tr a b && head -c 16'"],
            rawCommand: "sh -c 'tr a b && head -c 16'",
          },
        );

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
        const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy(
          "allowlist",
          "off",
          { command: ["pwsh", "-Command", "head -c 16"] },
        );

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
    const executablePath = createTempExecutable(binDir, "pwsh");
    await withTempApprovalsHome(
      createAllowlistOnMissApprovals({
        agents: {
          main: {
            allowlist: [{ pattern: executablePath }],
          },
        },
      }),
      async () => {
        const { runCommand, sendInvokeResult, sendNodeEvent } =
          await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
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
        expectApprovalRequiredDenied(sendNodeEvent, sendInvokeResult);

        const commandWithArgs = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          command: [executablePath, "-cwa", "Write-Output", "hi"],
        });

        expect(commandWithArgs.runCommand).not.toHaveBeenCalled();
        expectApprovalRequiredDenied(
          commandWithArgs.sendNodeEvent,
          commandWithArgs.sendInvokeResult,
        );
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "pins PATH-token executable to canonical path",
    async () => {
      await withPathTokenCommand("openclaw-approval-path-pin-", async ({ expected }) => {
        const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy(
          "full",
          "off",
          { command: ["poccmd", "-n", "SAFE"], approved: true },
        );
        expectCommandPinnedToCanonicalPath(
          runCommand,
          expected,
          ["-n", "SAFE"],
          fs.realpathSync(process.cwd()),
        );
        expectInvokeOk(sendInvokeResult);
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
      await withPathTokenCommand(
        "openclaw-allowlist-path-pin-",
        async ({ link: _link, expected }) => {
          await withTempApprovalsHome(
            createApprovals("allowlist", "off", "deny", {
              main: {
                allowlist: [{ pattern: expected }],
              },
            }),
            async () => {
              await runLocalSystemInvokeWithPolicy("allowlist", "off", {
                command: ["poccmd", "-n", "SAFE"],
                runCommand,
                sendInvokeResult,
              });
            },
          );
          expectCommandPinnedToCanonicalPath(
            runCommand,
            expected,
            ["-n", "SAFE"],
            fs.realpathSync(process.cwd()),
          );
          expectInvokeOk(sendInvokeResult);
        },
      );
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
    const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy("full", "off", {
      command: ["./run.sh", "--flag"],
      cwd: tmp,
      approved: true,
    });
    if (process.platform === "win32") {
      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(
        sendInvokeResult,
        "SYSTEM_RUN_DENIED: approval requires a stable executable path — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
        true,
      );
      return;
    }
    expectCommandPinnedToCanonicalPath(
      runCommand,
      fs.realpathSync(script),
      ["--flag"],
      fs.realpathSync(tmp),
    );
    expectInvokeOk(sendInvokeResult);
  });

  it("denies approval-based execution when cwd identity drifts before execution", async () => {
    const tmp = createFixtureDir("openclaw-approval-cwd-drift-");
    const fallback = createFixtureDir("openclaw-approval-cwd-drift-alt-");
    const script = path.join(tmp, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(script, 0o755);
    const canonicalCwd = fs.realpathSync(tmp);
    const prepared = buildCwdSessionApprovalPlan(["./run.sh"], tmp, "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withMockedCwdIdentityDrift({
      canonicalCwd,
      driftDir: fallback,
      run: async () => {
        const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy(
          "full",
          "off",
          { preparedPlan: prepared.plan, cwd: prepared.plan.cwd ?? tmp, approved: true },
        );
        expect(runCommand).not.toHaveBeenCalled();
        if (process.platform === "win32") {
          expectInvokeErrorMessage(
            sendInvokeResult,
            "SYSTEM_RUN_DENIED: approval requires a stable executable path — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
            true,
          );
          return;
        }
        expectInvokeErrorMessage(
          sendInvokeResult,
          "SYSTEM_RUN_DENIED: approval cwd changed before execution — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
          true,
        );
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
      const prepared = buildCwdApprovalPlan(fixture.command, tmp);
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");

      if (mutate) {
        fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
      }
      const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy("full", "off", {
        preparedPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? tmp,
        approved: true,
      });

      if (mutate) {
        expect(runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(
          sendInvokeResult,
          "SYSTEM_RUN_DENIED: approval script operand changed before execution — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
          true,
        );
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

      const invoke = await runLocalSystemInvokeWithPolicy("full", "off", {
        command: ["./run.sh"],
        cwd: tmp,
        approved: true,
        commitExecAuthorization: commitAuthorization,
      });

      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(
        invoke.sendInvokeResult,
        "SYSTEM_RUN_DENIED: approval cwd changed before execution — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
        true,
      );
    },
  );

  it("revalidates approved script operands after authorization commit", async () => {
    const tmp = createFixtureDir("openclaw-approval-script-post-commit-drift-");
    const fixture = createMutableScriptOperandFixture(tmp);
    fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.scriptPath, 0o755);
    }
    const prepared = buildCwdApprovalPlan(fixture.command, tmp);
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    const commitAuthorization: HandleSystemRunInvokeOptions["commitExecAuthorization"] = async (
      params,
    ) => {
      await commitExecAuthorizationLocked(params);
      fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
    };

    const invoke = await runLocalSystemInvokeWithPolicy("full", "off", {
      preparedPlan: prepared.plan,
      cwd: prepared.plan.cwd ?? tmp,
      approved: true,
      commitExecAuthorization: commitAuthorization,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(
      invoke.sendInvokeResult,
      "SYSTEM_RUN_DENIED: approval script operand changed before execution — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
      true,
    );
  });

  it("validates approved runtime script operand bindings at dispatch", async () => {
    await withFakeRuntimeOnPath("tsx", async () => {
      const tmp = createFixtureDir("openclaw-approval-tsx-script-drift-");
      const fixture = createRuntimeScriptOperandFixture(tmp, "tsx");
      fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
      const prepared = buildCwdApprovalPlan(fixture.command, tmp);
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");

      fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
      const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy("full", "off", {
        preparedPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? tmp,
        approved: true,
      });

      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(
        sendInvokeResult,
        "SYSTEM_RUN_DENIED: approval script operand changed before execution — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
        true,
      );
      const missingBindingTmp = createFixtureDir("openclaw-approval-tsx-missing-binding-");
      const missingBindingFixture = createRuntimeScriptOperandFixture(missingBindingTmp, "tsx");
      fs.writeFileSync(missingBindingFixture.scriptPath, missingBindingFixture.initialBody);
      const missingBindingPrepared = buildCwdApprovalPlan(
        missingBindingFixture.command,
        missingBindingTmp,
      );
      expect(missingBindingPrepared.ok).toBe(true);
      if (!missingBindingPrepared.ok) {
        throw new Error("unreachable");
      }

      const planWithoutBinding = { ...missingBindingPrepared.plan };
      delete planWithoutBinding.mutableFileOperand;
      const missingBindingRun = await runLocalSystemInvokeWithPolicy("full", "off", {
        preparedPlan: planWithoutBinding,
        cwd: missingBindingPrepared.plan.cwd ?? missingBindingTmp,
        approved: true,
      });

      expect(missingBindingRun.runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(
        missingBindingRun.sendInvokeResult,
        "SYSTEM_RUN_DENIED: approval missing script operand binding — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
        true,
      );
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

    await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
      command: ["./sh", "-lc", "/bin/echo approved-only"],
      runCommand,
      sendInvokeResult,
      sendNodeEvent,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
    expectApprovalRequiredDenied(sendNodeEvent, sendInvokeResult);
    try {
      fs.unlinkSync(marker);
    } catch {
      // no-op
    }
  });

  it("denies ./skill-bin even when autoAllowSkills trust entry exists", async () => {
    const { runCommand, sendInvokeResult, sendNodeEvent } = createInvokeSpies();

    await withTempApprovalsHome(
      createAllowlistOnMissApprovals({ autoAllowSkills: true }),
      async ({ tempHome }) => {
        const skillBinPath = path.join(tempHome, "skill-bin");
        fs.writeFileSync(skillBinPath, "#!/bin/sh\necho should-not-run\n", { mode: 0o755 });
        fs.chmodSync(skillBinPath, 0o755);
        await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          command: ["./skill-bin", "--help"],
          cwd: tempHome,
          skillBinsCurrent: async () => [{ name: "skill-bin", resolvedPath: skillBinPath }],
          runCommand,
          sendInvokeResult,
          sendNodeEvent,
        });
      },
    );

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied(sendNodeEvent, sendInvokeResult);
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
      const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy("full", "off", {
        command: testCase.command,
        env: testCase.env,
      });

      expect(runCommand, testCase.label).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, testCase.message);
      for (const detail of testCase.details) {
        expectInvokeErrorMessage(sendInvokeResult, detail);
      }
    }
  });

  it("applies shell-wrapper env allowlist for shell executable commands without inline payload", async () => {
    const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy("full", "off", {
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

    await withTempApprovalsHome(
      createAllowlistOnMissApprovals({
        agents: {
          main: {
            allowlist: [{ pattern: "/usr/bin/env" }],
          },
        },
      }),
      async ({ tempHome }) => {
        const marker = path.join(tempHome, params.markerName);
        await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          command: buildNestedEnvShellCommand({
            depth: params.depth,
            payload: `echo PWNED > ${marker}`,
          }),
          runCommand,
          sendInvokeResult,
          sendNodeEvent,
        });
        expect(fs.existsSync(marker)).toBe(false);
      },
    );

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied(sendNodeEvent, sendInvokeResult);
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
        const { runCommand, sendInvokeResult, sendNodeEvent } =
          await runLocalSystemInvokeWithPolicy("full", "off", { command: [...testCase.command] });

        expect(runCommand, testCase.command.join(" ")).not.toHaveBeenCalled();
        expectExecDeniedEvent(sendNodeEvent);
        expectInvokeErrorMessage(sendInvokeResult, testCase.expected);
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
      const { runCommand, sendInvokeResult, sendNodeEvent } = await runLocalSystemInvokeWithPolicy(
        "allowlist",
        "on-miss",
        { command: ["awk", 'BEGIN{system("id")}', "/dev/null"] },
      );

      expect(runCommand).not.toHaveBeenCalled();
      expectExecDeniedEvent(sendNodeEvent);
      expectInvokeErrorMessage(
        sendInvokeResult,
        "awk inline program requires explicit approval in strictInlineEval mode",
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("fails closed when allow-always approval persistence fails", async () => {
    await withTempApprovalsHome(createAllowlistOnMissApprovals(), async () => {
      const tempDir = createFixtureDir("openclaw-allow-always-write-failure-");
      const executablePath = createTempExecutable(tempDir, "approved-tool");
      const commitAuthorization = vi.fn(async () => {
        throw new Error("approval lock unavailable");
      });
      const invoke = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
        command: [executablePath],
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
    });
  });

  it("does not restore a revoked allowlist rule during explicit allow-always persistence", async () => {
    const tempDir = createFixtureDir("openclaw-allow-always-revoked-rule-");
    const executablePath = createTempExecutable(tempDir, "approved-tool");
    const matchedEntry = { pattern: fs.realpathSync(executablePath) };
    const expectedPolicySnapshot = {
      security: "allowlist" as const,
      ask: "always" as const,
      askFallback: "deny" as const,
      autoAllowSkills: false,
      allowlistRules: [matchedEntry],
    };

    await withTempApprovalsHome(
      createApprovals("allowlist", "always", "deny", { main: { allowlist: [matchedEntry] } }),
      async () => {
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

        const invoke = await runLocalSystemInvokeWithPolicy("allowlist", "always", {
          command: [executablePath],
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
    );
  });

  it("fails closed when allowlist usage persistence fails", async () => {
    const tempDir = createFixtureDir("openclaw-allowlist-usage-write-failure-");
    const executablePath = createTempExecutable(tempDir, "allowlisted-tool");
    await withTempApprovalsHome(
      createAllowlistOnMissApprovals({
        agents: {
          main: {
            allowlist: [{ pattern: fs.realpathSync(executablePath) }],
          },
        },
      }),
      async () => {
        const commitAuthorization = vi.fn(async () => {
          throw new Error("approval lock unavailable");
        });
        const invoke = await runLocalSystemInvokeWithPolicy("allowlist", "off", {
          command: [executablePath],
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
    );
  });

  it("revalidates unprompted full policy before local execution", async () => {
    await withTempApprovalsHome(createApprovals("full", "off", "deny"), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, security: "deny" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "off", {
        commitExecAuthorization: commitAuthorization,
      });

      expect(commitAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({ source: "current-policy" }),
        }),
      );
      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectApprovalStateWriteDenied(invoke);
    });
  });

  it("rejects unprompted full execution after ask policy tightens", async () => {
    await withTempApprovalsHome(createApprovals("full", "off", "deny"), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, ask: "on-miss" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "off", {
        commitExecAuthorization: commitAuthorization,
      });

      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectApprovalStateWriteDenied(invoke);
    });
  });

  it("revalidates explicit approval against a current deny policy", async () => {
    await withTempApprovalsHome(createApprovals("full", "always", "deny"), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, security: "deny" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
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
    });
  });

  it("rejects explicit allow-once when persisted security tightens to allowlist", async () => {
    await withTempApprovalsHome(createApprovals("full", "always", "deny"), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, security: "allowlist" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
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
    });
  });

  it("treats authenticated auto-review provenance as marker-only one-shot authority", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "on-miss", "deny"), async () => {
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "ask",
        rationale: "must not be called for forwarded provenance",
        risk: "medium",
      }));
      const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
      const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
        preparedPlan: prepared.plan,
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
    });
  });

  it("rejects forwarded auto-review when current ask policy tightens to always", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "on-miss", "deny"), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, ask: "always" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
        preparedPlan: prepared.plan,
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
    });
  });

  it("rejects forwarded auto-review when persisted security tightens to allowlist", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "on-miss", "deny"), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, security: "allowlist" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
        preparedPlan: prepared.plan,
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
    });
  });

  it("rejects forwarded auto-review when persisted ask tightens from off to on-miss", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "off", "deny"), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, ask: "on-miss" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "off", {
        preparedPlan: prepared.plan,
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
    });
  });

  it("rejects forwarded auto-review when current security policy tightens to deny", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "on-miss", "deny"), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, security: "deny" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
        preparedPlan: prepared.plan,
        approvalSource: "auto-review",
        commitExecAuthorization: commitAuthorization,
      });

      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectApprovalStateWriteDenied(invoke);
    });
  });

  it("does not let forwarded auto-review authorize security audit suppression edits", async () => {
    const tmp = createFixtureDir("openclaw-forwarded-auto-review-suppression-");
    const executablePath = createTempExecutable(tmp, "openclaw");
    const prepared = buildCwdSessionApprovalPlan(
      [executablePath, "config", "set", "security.audit.suppressions", "[]"],
      tmp,
      "agent:main:main",
    );
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "on-miss", "deny"), async () => {
      const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
        preparedPlan: prepared.plan,
        cwd: tmp,
        approvalSource: "auto-review",
      });

      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectExecDeniedEvent(invoke.sendNodeEvent);
      expectInvokeErrorMessage(
        invoke.sendInvokeResult,
        "SYSTEM_RUN_DENIED: explicit approval required — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
        true,
      );
    });
  });

  it("preserves exact-plan forwarded auto-review for strict inline eval", async () => {
    const plan = createStrictInlineEvalApprovalPlan("openclaw-forwarded-inline-");
    setRuntimeConfigSnapshot({ tools: { exec: { strictInlineEval: true } } });
    try {
      await withTempApprovalsHome(createApprovals("full", "on-miss", "deny"), async () => {
        const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
        const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
          preparedPlan: plan,
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
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not commit allow-always state when local screen recording is unavailable", async () => {
    await withTempApprovalsHome(createApprovals("full", "always", "deny"), async () => {
      const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
      const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
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
    });
  });

  it("revalidates timeout fallback against the current askFallback policy", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "always", "full", {}), async () => {
      const commitAuthorization = createPolicyMutationCommit((current) => {
        current.defaults = { ...current.defaults, askFallback: "deny" };
      });
      const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
        preparedPlan: prepared.plan,
        cwd: prepared.plan.cwd ?? undefined,
        approvalSource: "ask-fallback",
        commitExecAuthorization: commitAuthorization,
      });

      expect(invoke.runCommand).not.toHaveBeenCalled();
      expect(invoke.sendExecFinishedEvent).not.toHaveBeenCalled();
      expectApprovalStateWriteDenied(invoke);
    });
  });

  it("requires a canonical plan for timeout fallback provenance", async () => {
    const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
      approvalSource: "ask-fallback",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(
      invoke.sendInvokeResult,
      "approvalSource requires matching systemRunPlan",
      true,
    );
  });

  it("requires a canonical plan for forwarded auto-review provenance", async () => {
    const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
      approvalSource: "auto-review",
      prepareDelayedApprovalPlan: false,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(
      invoke.sendInvokeResult,
      "approvalSource requires matching systemRunPlan",
      true,
    );
  });

  it("requires a canonical plan for explicit approval provenance", async () => {
    const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
      approvalDecision: "allow-once",
      approved: true,
      prepareDelayedApprovalPlan: false,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(
      invoke.sendInvokeResult,
      "explicit approval requires matching systemRunPlan",
      true,
    );
  });

  it("requires a prepared policy snapshot for forwarded delayed approval", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
      preparedPlan: prepared.plan,
      approvalSource: "auto-review",
      prepareDelayedApprovalPlan: false,
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(
      invoke.sendInvokeResult,
      "delayed approval requires a prepared policy snapshot",
      true,
    );
  });

  it("rejects explicit approval when policy tightens after prepare", async () => {
    await withTempApprovalsHome(createApprovals("full", "always", "deny"), async () => {
      const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const policyBoundPlan = bindCurrentPolicyToPlan(prepared.plan);
      const current = loadExecApprovals();
      current.defaults = { ...current.defaults, security: "allowlist" };
      saveExecApprovals(current);
      const commitAuthorization = vi.fn(commitExecAuthorizationLocked);

      const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
        preparedPlan: policyBoundPlan,
        approvalDecision: "allow-once",
        approved: true,
        prepareDelayedApprovalPlan: false,
        commitExecAuthorization: commitAuthorization,
      });

      expect(commitAuthorization).not.toHaveBeenCalled();
      expect(invoke.runCommand).not.toHaveBeenCalled();
      // Exact: this denial already states its next step, so no generic escalation
      // hint is appended (the suffix would contradict "request approval again").
      expectInvokeErrorMessage(
        invoke.sendInvokeResult,
        "SYSTEM_RUN_DENIED: exec approval policy changed; request approval again",
        true,
      );
    });
  });

  it("rejects forwarded auto-review when ask tightens after prepare", async () => {
    await withTempApprovalsHome(createApprovals("full", "off", "deny"), async () => {
      const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const policyBoundPlan = bindCurrentPolicyToPlan(prepared.plan);
      const current = loadExecApprovals();
      current.defaults = { ...current.defaults, ask: "on-miss" };
      saveExecApprovals(current);
      const commitAuthorization = vi.fn(commitExecAuthorizationLocked);

      const invoke = await runLocalSystemInvokeWithPolicy("full", "off", {
        preparedPlan: policyBoundPlan,
        approvalSource: "auto-review",
        prepareDelayedApprovalPlan: false,
        commitExecAuthorization: commitAuthorization,
      });

      expect(commitAuthorization).not.toHaveBeenCalled();
      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(
        invoke.sendInvokeResult,
        "exec approval policy changed; request approval again",
      );
    });
  });

  it("rejects explicit approval when an allowlist rule is revoked after prepare", async () => {
    await withTempApprovalsHome(
      createApprovals("allowlist", "always", "deny", {
        main: {
          allowlist: [{ id: "rule-1", pattern: "/usr/bin/echo" }],
        },
      }),
      async () => {
        const prepared = buildSystemRunApprovalPlan({
          command: ["echo", "ok"],
          agentId: "main",
          sessionKey: "agent:main:main",
        });
        expect(prepared.ok).toBe(true);
        requireApprovalPlan(prepared, "unreachable");
        const policyBoundPlan = bindCurrentPolicyToPlan(prepared.plan);
        const current = loadExecApprovals();
        current.agents = { ...current.agents, main: { allowlist: [] } };
        saveExecApprovals(current);
        const commitAuthorization = vi.fn(commitExecAuthorizationLocked);

        const invoke = await runLocalSystemInvokeWithPolicy("allowlist", "always", {
          preparedPlan: policyBoundPlan,
          agentId: "main",
          approvalDecision: "allow-once",
          approved: true,
          prepareDelayedApprovalPlan: false,
          commitExecAuthorization: commitAuthorization,
        });

        expect(commitAuthorization).not.toHaveBeenCalled();
        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(
          invoke.sendInvokeResult,
          "exec approval policy changed; request approval again",
        );
      },
    );
  });

  it("rejects timeout fallback provenance mixed with explicit approval", async () => {
    const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
      approvalDecision: "allow-once",
      approvalSource: "ask-fallback",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(
      invoke.sendInvokeResult,
      "approvalSource cannot be combined with explicit approval",
      true,
    );
  });

  it("rejects forwarded auto-review provenance mixed with explicit approval", async () => {
    const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
      approved: true,
      approvalDecision: "allow-once",
      approvalSource: "auto-review",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(
      invoke.sendInvokeResult,
      "approvalSource cannot be combined with explicit approval",
      true,
    );
  });

  it("applies marker-only full timeout fallback without another prompt", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "always", "full", {}), async () => {
      const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
        preparedPlan: prepared.plan,
        approvalSource: "ask-fallback",
      });

      expect(invoke.runCommand).toHaveBeenCalledWith(
        prepared.plan.argv,
        prepared.plan.cwd,
        undefined,
        undefined,
      );
      expectInvokeOk(invoke.sendInvokeResult);
    });
  });

  it.runIf(process.platform !== "win32")(
    "permits a durable exact-command approval under allowlist timeout fallback",
    async () => {
      const tempDir = createFixtureDir("openclaw-fallback-durable-");
      const prepared = buildCwdSessionApprovalPlan(
        ["/bin/sh", "-c", "/bin/ls"],
        tempDir,
        "agent:main:main",
      );
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const commandPattern = createExactCommandPattern(prepared.plan.commandText);
      await withTempApprovalsHome(
        createApprovals("full", "always", "allowlist", {
          main: { allowlist: [{ pattern: commandPattern, source: "allow-always" }] },
        }),
        async () => {
          const commitAuthorization = vi.fn(commitExecAuthorizationLocked);
          const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
            preparedPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
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
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects allowlist timeout fallback when its durable source is removed before commit",
    async () => {
      const tempDir = createFixtureDir("openclaw-fallback-durable-revoked-");
      const prepared = buildCwdSessionApprovalPlan(
        ["/bin/sh", "-c", "/bin/ls"],
        tempDir,
        "agent:main:main",
      );
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const commandPattern = createExactCommandPattern(prepared.plan.commandText);
      await withTempApprovalsHome(
        createApprovals("full", "always", "allowlist", {
          main: { allowlist: [{ pattern: commandPattern, source: "allow-always" }] },
        }),
        async () => {
          const commitAuthorization = createPolicyMutationCommit((current) => {
            current.agents = {
              ...current.agents,
              main: { allowlist: [{ pattern: commandPattern }] },
            };
          });
          const invoke = await runLocalSystemInvokeWithPolicy("full", "always", {
            preparedPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
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
      );
    },
  );

  it("preserves source-only fallback across the authenticated Mac app bridge", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "always", "full", {}), async () => {
      const invoke = await runMacSystemInvokeWithPolicy("full", "always", {
        runViaResponse: createMacExecHostSuccess(),
        preparedPlan: prepared.plan,
        approvalSource: "ask-fallback",
      });

      const call = requireMacExecHostCall(invoke.runViaMacAppExecHost);
      expect(call.request?.approvalSource).toBe("ask-fallback");
      expect(call.request?.approvalDecision).toBeNull();
      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectInvokeOk(invoke.sendInvokeResult, "app-ok");
    });
  });

  it("preserves marker-only auto-review across the authenticated Mac app bridge", async () => {
    const prepared = buildSessionApprovalPlan(["echo", "ok"], "agent:main:main");
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "on-miss", "deny"), async () => {
      const invoke = await runMacSystemInvokeWithPolicy("full", "on-miss", {
        runViaResponse: createMacExecHostSuccess(),
        preparedPlan: prepared.plan,
        approvalSource: "auto-review",
      });

      const call = requireMacExecHostCall(invoke.runViaMacAppExecHost);
      expect(call.request?.approvalSource).toBe("auto-review");
      expect(call.request?.approvalDecision).toBeNull();
      expect(call.request?.policySnapshot).toEqual(
        createExecApprovalPolicySnapshot({ file: loadExecApprovals(), agentId: undefined }),
      );
      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectInvokeOk(invoke.sendInvokeResult, "app-ok");
    });
  });

  it("does not let timeout fallback satisfy strict inline review", async () => {
    const plan = createStrictInlineEvalApprovalPlan("openclaw-fallback-inline-");
    setRuntimeConfigSnapshot({ tools: { exec: { strictInlineEval: true } } });
    try {
      await withTempApprovalsHome(createApprovals("full", "always", "full", {}), async () => {
        const invoke = await runLocalSystemInvoke({
          preparedPlan: plan,
          approvalSource: "ask-fallback",
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(
          invoke.sendInvokeResult,
          "requires explicit approval in strictInlineEval mode",
        );
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not let timeout fallback authorize security audit suppression edits", async () => {
    const tmp = createFixtureDir("openclaw-timeout-fallback-suppression-");
    const executablePath = createTempExecutable(tmp, "openclaw");
    const prepared = buildCwdSessionApprovalPlan(
      [executablePath, "config", "set", "security.audit.suppressions", "[]"],
      tmp,
      "agent:main:main",
    );
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(createApprovals("full", "always", "full", {}), async () => {
      const invoke = await runLocalSystemInvoke({
        preparedPlan: prepared.plan,
        cwd: tmp,
        approvalSource: "ask-fallback",
      });

      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectApprovalRequiredDenied(invoke.sendNodeEvent, invoke.sendInvokeResult);
    });
  });

  it("keeps audit suppression edits approval-gated under allowlist fallback from full/off", async () => {
    const tmp = createFixtureDir("openclaw-timeout-fallback-full-off-suppression-");
    const executablePath = createTempExecutable(tmp, "openclaw");
    const prepared = buildCwdSessionApprovalPlan(
      [executablePath, "config", "set", "security.audit.suppressions", "[]"],
      tmp,
      "agent:main:main",
    );
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    await withTempApprovalsHome(
      createApprovals("full", "off", "allowlist", {
        main: { allowlist: [{ pattern: fs.realpathSync(executablePath) }] },
      }),
      async () => {
        const invoke = await runLocalSystemInvokeWithPolicy("full", "off", {
          preparedPlan: prepared.plan,
          cwd: tmp,
          approvalSource: "ask-fallback",
        });

        expect(invoke.runCommand).not.toHaveBeenCalled();
        expectApprovalRequiredDenied(invoke.sendNodeEvent, invoke.sendInvokeResult);
      },
    );
  });

  it("rejects unknown approval provenance", async () => {
    const invoke = await runLocalSystemInvokeWithPolicy("full", "off", {
      approved: true,
      approvalDecision: "allow-once",
      approvalSource: "explicit",
    });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(invoke.sendInvokeResult, "approvalSource invalid", true);
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
      await withTempApprovalsHome(createAllowlistOnMissApprovals(), async () => {
        const tempDir = createFixtureDir("openclaw-inline-eval-bin-");
        const executablePath = createTempExecutable(tempDir, "python3.13");
        const prepared = buildSystemRunApprovalPlan({
          command: [executablePath, "-c", "print('hi')"],
        });

        expect(prepared).toEqual({
          ok: false,
          message:
            "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
        });
        expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
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
      await withTempApprovalsHome(createAllowlistOnMissApprovals(), async () => {
        const tempDir = createFixtureDir("openclaw-inline-eval-awk-");
        const executablePath = createTempExecutable(tempDir, "gawk");
        fs.writeFileSync(path.join(tempDir, "script.awk"), "{ print }\n");
        const benign = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          command: [executablePath, "-F", ",", "-f", "script.awk"],
          cwd: tempDir,
          approvalDecision: "allow-always",
          approved: true,
          runCommand: vi.fn(async () => createLocalRunResult("awk-ok")),
        });

        expect(benign.runCommand).toHaveBeenCalledTimes(1);
        expectInvokeOk(benign.sendInvokeResult, "awk-ok");
        const allowlist = loadExecApprovals().agents?.main?.allowlist ?? [];
        expect(allowlist).toHaveLength(2);
        expect(allowlist[0]?.pattern).toBe(fs.realpathSync(executablePath));
        expect(allowlist[0]?.lastUsedCommand).toBeUndefined();
        expect(allowlist[1]?.pattern).toMatch(/^=node-command:[0-9a-f]{16}$/);
        expect(allowlist[1]?.lastUsedCommand).toBeUndefined();

        const malicious = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          command: [executablePath, 'BEGIN{system("id")}', "/dev/null"],
          cwd: tempDir,
        });

        expect(malicious.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(
          malicious.sendInvokeResult,
          "awk inline program requires explicit approval in strictInlineEval mode",
        );

        const abbreviated = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          command: [executablePath, '--s=BEGIN{system("id")}', "/dev/null"],
          cwd: tempDir,
        });

        expect(abbreviated.runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(
          abbreviated.sendInvokeResult,
          "gawk --source requires explicit approval in strictInlineEval mode",
        );
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
      await withTempApprovalsHome(createAllowlistOnMissApprovals(), async () => {
        const tempDir = createFixtureDir("openclaw-inline-eval-make-");
        const executablePath = createTempExecutable(tempDir, "make");
        const makefilePath = path.join(tempDir, "Makefile");
        fs.writeFileSync(makefilePath, "all:\n\t@echo inline-eval-ok\n");
        const prepared = buildCwdApprovalPlan([executablePath, "-f", makefilePath], tempDir);
        expect(prepared.ok).toBe(true);
        requireApprovalPlan(prepared, "unreachable");

        const { runCommand, sendInvokeResult } = await runLocalSystemInvokeWithPolicy(
          "allowlist",
          "on-miss",
          {
            preparedPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
            approvalDecision: "allow-always",
            approved: true,
            runCommand: vi.fn(async () => createLocalRunResult("inline-eval-ok")),
          },
        );

        expect(runCommand).toHaveBeenCalledTimes(1);
        expectInvokeOk(sendInvokeResult, "inline-eval-ok");
        expect(loadExecApprovals().agents?.main?.allowlist ?? []).toStrictEqual([]);
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

      await withTempApprovalsHome(
        createAllowlistOnMissApprovals({
          agents: {
            main: {
              allowlist: [{ pattern: fs.realpathSync(scriptPath) }],
            },
          },
        }),
        async () => {
          const invoke = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
            command: ["/bin/sh", "-lc", "./scripts/check_mail.sh --limit 5"],
            rawCommand: '/bin/sh -lc "./scripts/check_mail.sh --limit 5"',
            cwd: tempDir,
            runCommand: vi.fn(async () => createLocalRunResult("shell-wrapper-inner-ok")),
          });

          expect(invoke.runCommand).toHaveBeenCalledTimes(1);
          expectInvokeOk(invoke.sendInvokeResult, "shell-wrapper-inner-ok");
        },
      );
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

        await withTempApprovalsHome(
          createAllowlistOnMissApprovals({
            agents: {
              main: {
                allowlist: [{ pattern: scriptPath }],
              },
            },
          }),
          async () => {
            const seenArgv: string[][] = [];
            const invoke = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
              command,
              cwd: tempDir,
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
            expectApprovalRequiredDenied(invoke.sendNodeEvent, invoke.sendInvokeResult);
          },
        );
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
      requireApprovalPlan(prepared, "unreachable");
      const commandPattern = createExactCommandPattern(prepared.plan.commandText);

      await withTempApprovalsHome(
        createAllowlistOnMissApprovals({
          agents: {
            main: {
              allowlist: [
                { pattern: ordinaryPattern },
                { pattern: commandPattern, source: "allow-always" },
              ],
            },
          },
        }),
        async () => {
          const commitAuthorization = createPolicyMutationCommit((current) => {
            current.agents = {
              ...current.agents,
              main: {
                allowlist: [{ pattern: ordinaryPattern }, { pattern: commandPattern }],
              },
            };
          });
          const invoke = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
            preparedPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
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
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("reuses exact-command durable trust for shell-wrapper reruns", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = createFixtureDir("openclaw-shell-wrapper-allow-");
    const prepared = buildCwdApprovalPlan(["/bin/sh", "-c", "/bin/ls"], tempDir);
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");

    await withTempApprovalsHome(
      createApprovals("allowlist", "on-miss", "full", {
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
      }),
      async () => {
        const rerun = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          preparedPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? tempDir,
          runCommand: vi.fn(async () => createLocalRunResult("shell-wrapper-reused")),
        });

        expect(rerun.runCommand).toHaveBeenCalledTimes(1);
        expectInvokeOk(rerun.sendInvokeResult, "shell-wrapper-reused");
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects durable trust when its approved directory is replaced before execution",
    async () => {
      const tempDir = createFixtureDir("openclaw-durable-cwd-drift-");
      const movedDir = `${tempDir}-moved`;
      const prepared = buildCwdApprovalPlan(["/bin/sh", "-c", "/bin/ls"], tempDir);
      expect(prepared.ok).toBe(true);
      requireApprovalPlan(prepared, "unreachable");
      const commandPattern = createExactCommandPattern(prepared.plan.commandText);

      await withTempApprovalsHome(
        createApprovals("allowlist", "on-miss", "full", {
          main: {
            allowlist: [{ pattern: commandPattern, source: "allow-always" }],
          },
        }),
        async () => {
          const commitAuthorization: HandleSystemRunInvokeOptions["commitExecAuthorization"] =
            async (params) => {
              await commitExecAuthorizationLocked(params);
              fs.renameSync(tempDir, movedDir);
              fs.mkdirSync(tempDir);
            };
          const rerun = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
            preparedPlan: prepared.plan,
            cwd: prepared.plan.cwd ?? tempDir,
            commitExecAuthorization: commitAuthorization,
          });

          expect(rerun.runCommand).not.toHaveBeenCalled();
          expectInvokeErrorMessage(
            rerun.sendInvokeResult,
            "SYSTEM_RUN_DENIED: approval cwd changed before execution — to change this outcome, ask the operator to adjust the agent's exec policy; an identical retry will be denied again",
            true,
          );
        },
      );
    },
  );

  it("does not bind safe builtin policy to a redundant exact-command grant", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = createFixtureDir("openclaw-shell-wrapper-redundant-grant-");
    const prepared = buildCwdApprovalPlan(["/bin/sh", "-c", "cd ."], tempDir);
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    const commandPattern = createExactCommandPattern(prepared.plan.commandText);

    await withTempApprovalsHome(
      createApprovals("allowlist", "on-miss", "full", {
        main: {
          allowlist: [{ pattern: commandPattern, source: "allow-always" }],
        },
      }),
      async () => {
        const commitAuthorization = createPolicyMutationCommit((current) => {
          current.agents = { ...current.agents, main: { allowlist: [] } };
        });
        const rerun = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          preparedPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? tempDir,
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
        expectInvokeOk(rerun.sendInvokeResult, "safe-builtin-ok");
      },
    );
  });

  it("fails closed when an exact-command grant is revoked before execution", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = createFixtureDir("openclaw-shell-wrapper-revoked-");
    const prepared = buildCwdApprovalPlan(["/bin/sh", "-c", "/bin/ls"], tempDir);
    expect(prepared.ok).toBe(true);
    requireApprovalPlan(prepared, "unreachable");
    const commandPattern = createExactCommandPattern(prepared.plan.commandText);

    await withTempApprovalsHome(
      createApprovals("allowlist", "on-miss", "full", {
        main: {
          allowlist: [{ pattern: commandPattern, source: "allow-always" }],
        },
      }),
      async () => {
        const commitAuthorization = createPolicyMutationCommit((current) => {
          current.agents = { ...current.agents, main: { allowlist: [] } };
        });
        const rerun = await runLocalSystemInvokeWithPolicy("allowlist", "on-miss", {
          preparedPlan: prepared.plan,
          cwd: prepared.plan.cwd ?? tempDir,
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
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
