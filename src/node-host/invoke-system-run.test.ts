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
  loadExecApprovals,
  resolveExecApprovalsPath,
  saveExecApprovals,
} from "../infra/exec-approvals.js";
import type { ExecHostResponse } from "../infra/exec-host.js";
import { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";
import { handleSystemRunInvoke } from "./invoke-system-run.js";
import type { HandleSystemRunInvokeOptions } from "./invoke-system-run.js";

vi.mock("../logger.js", () => ({
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
    sharedFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-host-fixtures-"));
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
    error?: { message?: string };
  } {
    const result = firstMockCallArg(sendInvokeResult, "sendInvokeResult", 0);
    return result as { ok?: boolean; payloadJSON?: string; error?: { message?: string } };
  }

  function requireFirstRunCommandArgs(runCommand: MockedRunCommand): string[] {
    return firstMockCallArg(vi.mocked(runCommand), "runCommand", 0) as string[];
  }

  function requireMacExecHostCall(runViaMacAppExecHost: MockedRunViaMacAppExecHost): {
    approvals?: { agent?: { security?: string; ask?: string } };
    request?: { command?: string[]; rawCommand?: string; cwd?: string };
  } {
    const call = firstMockCallArg(runViaMacAppExecHost, "runViaMacAppExecHost", 0);
    return call as {
      approvals?: { agent?: { security?: string; ask?: string } };
      request?: { command?: string[]; rawCommand?: string; cwd?: string };
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

  function expectExecDeniedEvent(sendNodeEvent: MockedSendNodeEvent): void {
    const call = sendNodeEvent.mock.calls.at(0);
    if (!call) {
      throw new Error("expected sendNodeEvent call");
    }
    expect(call[1]).toBe("exec.denied");
    expect((call[2] as { reason?: string }).reason).toBe("approval-required");
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
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tempHome;
    saveExecApprovals(params.approvals);
    try {
      return await params.run({ tempHome });
    } finally {
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
    }
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
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      return await params.run({ link, expected });
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
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
    const oldPath = process.env.PATH;
    process.env.PATH = `${sharedRuntimeBinDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      return await params.run();
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
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
    security?: "full" | "allowlist";
    ask?: "off" | "on-miss" | "always";
    approvalDecision?: "allow" | "allow-always" | "deny" | null;
    approved?: boolean;
    runCommand?: HandleSystemRunInvokeOptions["runCommand"];
    runViaMacAppExecHost?: HandleSystemRunInvokeOptions["runViaMacAppExecHost"];
    sendInvokeResult?: HandleSystemRunInvokeOptions["sendInvokeResult"];
    sendExecFinishedEvent?: HandleSystemRunInvokeOptions["sendExecFinishedEvent"];
    sendNodeEvent?: HandleSystemRunInvokeOptions["sendNodeEvent"];
    skillBinsCurrent?: () => Promise<Array<{ name: string; resolvedPath: string }>>;
    isCmdExeInvocation?: HandleSystemRunInvokeOptions["isCmdExeInvocation"];
    sanitizeEnv?: HandleSystemRunInvokeOptions["sanitizeEnv"];
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

    await handleSystemRunInvoke({
      client: {} as never,
      params: {
        command: params.command ?? ["echo", "ok"],
        env: params.env,
        rawCommand: params.rawCommand,
        systemRunPlan: params.systemRunPlan,
        cwd: params.cwd,
        approvalDecision: params.approvalDecision,
        approved: params.approved ?? false,
        sessionKey: "agent:main:main",
      },
      skillBins: {
        current: params.skillBinsCurrent ?? (async () => []),
      },
      execHostEnforced: false,
      execHostFallbackAllowed: true,
      resolveExecSecurity: () => params.security ?? "full",
      resolveExecAsk: () => params.ask ?? "off",
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
        run: async ({ link, expected }) => {
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
                  allowlist: [{ pattern: link }],
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
    "denies approval-based execution for symlinked cwd paths",
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
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: ["./run.sh"],
          cwd,
          approved: true,
          security: "full",
          ask: "off",
        });
        expect(runCommand, testCase.label).not.toHaveBeenCalled();
        expectInvokeErrorMessage(sendInvokeResult, { message });
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
    await withMockedCwdIdentityDrift({
      canonicalCwd,
      driftDir: fallback,
      run: async () => {
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          preferMacAppExecHost: false,
          command: ["./run.sh"],
          cwd: tmp,
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

  it("does not persist allow-always approvals for strict inline-eval carriers", async () => {
    // Persistence behavior is covered generically in exec-approvals tests; keep
    // one handler-level smoke for strictInlineEval allow-always suppression.
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
            name: "python3",
          });
          const { runCommand, sendInvokeResult } = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: [executablePath, "-c", "print('hi')"],
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
            name: "awk",
          });
          const benign = await runSystemInvoke({
            preferMacAppExecHost: false,
            command: [executablePath, "-F", ",", "-f", "script.awk", "data.csv"],
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
          expect(allowlist).toHaveLength(1);
          expect(allowlist[0]?.pattern).toBe(executablePath);

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
              allowlist: [{ pattern: scriptPath }],
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

            expect(seenArgv, testCase.name).toContainEqual([
              "cmd.exe",
              "/d",
              "/s",
              "/c",
              `${scriptPath} --limit 5`,
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

  it("reuses exact-command durable trust for shell-wrapper reruns", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = createFixtureDir("openclaw-shell-wrapper-allow-");
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-c", "cd ."],
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
});
