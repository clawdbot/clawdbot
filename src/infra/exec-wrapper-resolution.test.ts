import { describe, expect, test } from "vitest";
import {
  basenameLower,
  extractEnvAssignmentKeysFromDispatchWrappers,
  extractShellWrapperCommand,
  extractShellWrapperInlineCommand,
  hasEnvManipulationBeforeShellWrapper,
  isDispatchWrapperExecutable,
  isShellWrapperExecutable,
  isShellWrapperInvocation,
  normalizeExecutableToken,
  resolveDispatchWrapperTrustPlan,
  resolveShellWrapperTransportArgv,
  unwrapEnvInvocation,
  unwrapKnownDispatchWrapperInvocation,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";

function supportsScriptPositionalCommandForTests(): boolean {
  return process.platform === "darwin" || process.platform === "freebsd";
}

function expectTransparentDispatchWrapperCase(params: {
  argv: string[];
  wrapper: string;
  effectiveArgv: string[];
}) {
  expect(isDispatchWrapperExecutable(params.wrapper)).toBe(true);
  expect(unwrapKnownDispatchWrapperInvocation(params.argv)).toEqual({
    kind: "unwrapped",
    wrapper: params.wrapper,
    argv: params.effectiveArgv,
  });
  expect(resolveDispatchWrapperTrustPlan(params.argv)).toEqual({
    argv: params.effectiveArgv,
    wrappers: [params.wrapper],
    policyBlocked: false,
  });
}

describe("basenameLower", () => {
  test.each([
    { token: " Bun.CMD ", expected: "bun.cmd" },
    { token: "C:\\tools\\PwSh.EXE", expected: "pwsh.exe" },
    { token: "/tmp/bash", expected: "bash" },
  ])("normalizes basenames for %j", ({ token, expected }) => {
    expect(basenameLower(token)).toBe(expected);
  });
});

describe("normalizeExecutableToken", () => {
  test.each([
    { token: "bun.cmd", expected: "bun" },
    { token: "deno.bat", expected: "deno" },
    { token: "pwsh.com", expected: "pwsh" },
    { token: "cmd.exe", expected: "cmd" },
    { token: "C:\\tools\\bun.cmd", expected: "bun" },
    { token: "/tmp/deno.exe", expected: "deno" },
    { token: " /tmp/bash ", expected: "bash" },
  ])("normalizes executable tokens for %j", ({ token, expected }) => {
    expect(normalizeExecutableToken(token)).toBe(expected);
  });
});

describe("wrapper classification", () => {
  test.each([
    { token: "sudo", dispatch: true, shell: false },
    { token: "caffeinate", dispatch: true, shell: false },
    { token: "sandbox-exec", dispatch: true, shell: false },
    { token: "script", dispatch: true, shell: false },
    { token: "time", dispatch: true, shell: false },
    { token: "timeout.exe", dispatch: true, shell: false },
    { token: "bash", dispatch: false, shell: true },
    { token: "pwsh.exe", dispatch: false, shell: true },
    { token: "node", dispatch: false, shell: false },
  ])("classifies wrappers for %j", ({ token, dispatch, shell }) => {
    expect(isDispatchWrapperExecutable(token)).toBe(dispatch);
    expect(isShellWrapperExecutable(token)).toBe(shell);
  });
});

describe("unwrapKnownShellMultiplexerInvocation", () => {
  test.each([
    { argv: [], expected: { kind: "not-wrapper" } },
    { argv: ["node", "-e", "1"], expected: { kind: "not-wrapper" } },
    { argv: ["busybox"], expected: { kind: "blocked", wrapper: "busybox" } },
    { argv: ["busybox", "ls"], expected: { kind: "blocked", wrapper: "busybox" } },
    {
      argv: ["busybox", "sh", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "busybox", argv: ["sh", "-lc", "echo hi"] },
    },
    {
      argv: ["toybox", "--", "pwsh.exe", "-Command", "Get-Date"],
      expected: {
        kind: "unwrapped",
        wrapper: "toybox",
        argv: ["pwsh.exe", "-Command", "Get-Date"],
      },
    },
  ])("unwraps shell multiplexers for %j", ({ argv, expected }) => {
    expect(unwrapKnownShellMultiplexerInvocation(argv)).toEqual(expected);
  });
});

describe("unwrapEnvInvocation", () => {
  test.each([
    {
      argv: ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["env", "-i", "--unset", "PATH", "--", "sh", "-lc", "echo hi"],
      expected: ["sh", "-lc", "echo hi"],
    },
    {
      argv: ["env", "--chdir=/tmp", "pwsh", "-Command", "Get-Date"],
      expected: ["pwsh", "-Command", "Get-Date"],
    },
    {
      argv: ["env", "-", "bash", "-lc", "echo hi"],
      expected: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["env", "--bogus", "bash", "-lc", "echo hi"],
      expected: null,
    },
    {
      argv: ["env", "--unset"],
      expected: null,
    },
  ])("unwraps env invocations for %j", ({ argv, expected }) => {
    expect(unwrapEnvInvocation(argv)).toEqual(expected);
  });
});

describe("unwrapKnownDispatchWrapperInvocation", () => {
  test.each([
    {
      argv: ["caffeinate", "-d", "-w", "42", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "caffeinate", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["env", "--", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "env", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["nice", "-n", "5", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "nice", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["nohup", "--", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "nohup", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["script", "-q", "/dev/null", "bash", "-lc", "echo hi"],
      expected: supportsScriptPositionalCommandForTests()
        ? { kind: "unwrapped", wrapper: "script", argv: ["bash", "-lc", "echo hi"] }
        : { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["script", "-E", "always", "/dev/null", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["stdbuf", "-o", "L", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "stdbuf", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["time", "-p", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "time", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["timeout", "--signal=TERM", "5s", "bash", "-lc", "echo hi"],
      expected: { kind: "unwrapped", wrapper: "timeout", argv: ["bash", "-lc", "echo hi"] },
    },
    {
      argv: ["sandbox-exec", "-p", "(allow default)", "bash", "-lc", "echo hi"],
      expected: {
        kind: "unwrapped",
        wrapper: "sandbox-exec",
        argv: ["bash", "-lc", "echo hi"],
      },
    },
    {
      argv: ["sandbox-exec", "-D", "PROFILE", "bash", "-lc", "echo hi"],
      expected: {
        kind: "unwrapped",
        wrapper: "sandbox-exec",
        argv: ["bash", "-lc", "echo hi"],
      },
    },
    {
      argv: ["xcrun", "bash", "-lc", "echo hi"],
      expected:
        process.platform === "darwin"
          ? { kind: "unwrapped", wrapper: "xcrun", argv: ["bash", "-lc", "echo hi"] }
          : { kind: "blocked", wrapper: "xcrun" },
    },
    {
      argv: ["script", "-q", "/dev/null"],
      expected: { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["sudo", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "sudo" },
    },
    {
      argv: ["timeout", "--bogus", "5s", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "timeout" },
    },
    {
      argv: ["arch", "-e", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["arch", "-arch", "bogus", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["arch", "-arch", "bogus", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["xcrun", "--sdk", "macosx", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "xcrun" },
    },
  ])("unwraps known dispatch wrappers for %j", ({ argv, expected }) => {
    expect(unwrapKnownDispatchWrapperInvocation(argv)).toEqual(expected);
  });

  test("blocks arch dispatch unwrapping outside macOS", () => {
    expect(
      unwrapKnownDispatchWrapperInvocation(["arch", "-arm64", "bash", "-lc", "echo hi"], "linux"),
    ).toEqual({
      kind: "blocked",
      wrapper: "arch",
    });
  });

  test.each(["chrt", "doas", "ionice", "setsid", "sudo", "taskset"])(
    "fails closed for blocked dispatch wrapper %s",
    (wrapper) => {
      expect(unwrapKnownDispatchWrapperInvocation([wrapper, "bash", "-lc", "echo hi"])).toEqual({
        kind: "blocked",
        wrapper,
      });
    },
  );
});

describe("resolveDispatchWrapperTrustPlan", () => {
  test("allows non-semantic env passthrough", () => {
    expect(resolveDispatchWrapperTrustPlan(["env", "--", "bash", "-lc", "echo hi"])).toEqual({
      argv: ["bash", "-lc", "echo hi"],
      wrappers: ["env"],
      policyBlocked: false,
    });
  });

  test.each([
    {
      argv: ["caffeinate", "-d", "-t", "60", "bash", "-lc", "echo hi"],
      wrapper: "caffeinate",
      effectiveArgv: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["nice", "-n", "5", "bash", "-lc", "echo hi"],
      wrapper: "nice",
      effectiveArgv: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["nohup", "--", "bash", "-lc", "echo hi"],
      wrapper: "nohup",
      effectiveArgv: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["sandbox-exec", "-p", "(allow default)", "bash", "-lc", "echo hi"],
      wrapper: "sandbox-exec",
      effectiveArgv: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["sandbox-exec", "-D", "PROFILE", "bash", "-lc", "echo hi"],
      wrapper: "sandbox-exec",
      effectiveArgv: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["stdbuf", "-o", "L", "bash", "-lc", "echo hi"],
      wrapper: "stdbuf",
      effectiveArgv: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["time", "-p", "bash", "-lc", "echo hi"],
      wrapper: "time",
      effectiveArgv: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["timeout", "--signal=TERM", "5s", "bash", "-lc", "echo hi"],
      wrapper: "timeout",
      effectiveArgv: ["bash", "-lc", "echo hi"],
    },
    ...(process.platform === "darwin"
      ? [
          {
            argv: ["arch", "-arm64", "bash", "-lc", "echo hi"],
            wrapper: "arch",
            effectiveArgv: ["bash", "-lc", "echo hi"],
          },
          {
            argv: ["xcrun", "bash", "-lc", "echo hi"],
            wrapper: "xcrun",
            effectiveArgv: ["bash", "-lc", "echo hi"],
          },
        ]
      : []),
  ])("keeps transparent wrapper handling in sync for %s", ({ argv, wrapper, effectiveArgv }) => {
    expectTransparentDispatchWrapperCase({ argv, wrapper, effectiveArgv });
  });

  test("unwraps transparent wrapper chains", () => {
    expect(
      resolveDispatchWrapperTrustPlan(["nohup", "nice", "-n", "5", "bash", "-lc", "echo hi"]),
    ).toEqual({
      argv: ["bash", "-lc", "echo hi"],
      wrappers: ["nohup", "nice"],
      policyBlocked: false,
    });
  });

  test("blocks arch trust unwrapping outside macOS", () => {
    expect(
      resolveDispatchWrapperTrustPlan(
        ["arch", "-arm64", "bash", "-lc", "echo hi"],
        undefined,
        "linux",
      ),
    ).toEqual({
      argv: ["arch", "-arm64", "bash", "-lc", "echo hi"],
      wrappers: [],
      policyBlocked: true,
      blockedWrapper: "arch",
    });
  });

  test("blocks semantic env usage even when it reaches a shell wrapper", () => {
    expect(resolveDispatchWrapperTrustPlan(["env", "FOO=bar", "bash", "-lc", "echo hi"])).toEqual({
      argv: ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      wrappers: ["env"],
      policyBlocked: true,
      blockedWrapper: "env",
    });
  });

  test("blocks wrapper overflow beyond the configured depth", () => {
    expect(
      resolveDispatchWrapperTrustPlan(["nohup", "timeout", "5s", "bash", "-lc", "echo hi"], 1),
    ).toEqual({
      argv: ["timeout", "5s", "bash", "-lc", "echo hi"],
      wrappers: ["nohup"],
      policyBlocked: true,
      blockedWrapper: "timeout",
    });
  });
});

describe("hasEnvManipulationBeforeShellWrapper", () => {
  test.each([
    {
      argv: ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: true,
    },
    {
      argv: ["timeout", "5s", "env", "--", "bash", "-lc", "echo hi"],
      expected: false,
    },
    {
      argv: ["timeout", "5s", "env", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: true,
    },
    {
      argv: ["sudo", "bash", "-lc", "echo hi"],
      expected: false,
    },
  ])("detects env manipulation before shell wrappers for %j", ({ argv, expected }) => {
    expect(hasEnvManipulationBeforeShellWrapper(argv)).toBe(expected);
  });
});

describe("resolveShellWrapperTransportArgv", () => {
  test.each([
    {
      argv: ["env", "cmd.exe", "/d", "/s", "/c", "echo hi"],
      expected: ["cmd.exe", "/d", "/s", "/c", "echo hi"],
    },
    {
      argv: ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c", "echo hi"],
      expected: ["cmd.exe", "/d", "/s", "/c", "echo hi"],
    },
    {
      argv: ["bash", "script.sh"],
      expected: null,
    },
  ])("resolves wrapper transport argv for %j", ({ argv, expected }) => {
    expect(resolveShellWrapperTransportArgv(argv)).toEqual(expected);
  });
});

describe("isShellWrapperInvocation", () => {
  test.each([
    {
      argv: ["bash", "script.sh"],
      expected: true,
    },
    {
      argv: ["/usr/bin/env", "SHELLOPTS=xtrace", "bash", "-lc", "echo hi"],
      expected: true,
    },
    {
      argv: ["busybox", "sh", "script.sh"],
      expected: true,
    },
    {
      argv: ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"],
      expected: false,
    },
  ])("detects shell-wrapper executable invocations for %j", ({ argv, expected }) => {
    expect(isShellWrapperInvocation(argv)).toBe(expected);
  });
});

describe("extractEnvAssignmentKeysFromDispatchWrappers", () => {
  test.each([
    {
      argv: ["env", "FOO=bar", "BAR=baz", "bash", "-lc", "echo hi"],
      expected: ["BAR", "FOO"],
    },
    {
      argv: ["nice", "-n", "5", "env", "-u", "PATH", "TERM=xterm", "bash", "-lc", "echo hi"],
      expected: ["TERM"],
    },
    {
      argv: ["env", "--split-string", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: [],
    },
    {
      argv: ["env", "--", "bash", "-lc", "echo hi"],
      expected: [],
    },
  ])("extracts env assignment prelude keys for %j", ({ argv, expected }) => {
    expect(extractEnvAssignmentKeysFromDispatchWrappers(argv)).toEqual(expected);
  });
});

describe("extractShellWrapperCommand", () => {
  test.each([
    {
      argv: ["bash", "-lc", "echo hi"],
      expectedInline: "echo hi",
      expectedCommand: { isWrapper: true, command: "echo hi" },
    },
    {
      argv: ["busybox", "sh", "-lc", "echo hi"],
      expectedInline: "echo hi",
      expectedCommand: { isWrapper: true, command: "echo hi" },
    },
    {
      argv: ["env", "--", "pwsh", "-Command", "Get-Date"],
      expectedInline: "Get-Date",
      expectedCommand: { isWrapper: true, command: "Get-Date" },
    },
    {
      argv: ["bash", "script.sh"],
      expectedInline: null,
      expectedCommand: { isWrapper: false, command: null },
    },
  ])("extracts inline commands for %j", ({ argv, expectedInline, expectedCommand }) => {
    expect(extractShellWrapperInlineCommand(argv)).toBe(expectedInline);
    expect(extractShellWrapperCommand(argv)).toEqual(expectedCommand);
  });

  test("prefers an explicit raw command override when provided", () => {
    expect(extractShellWrapperCommand(["bash", "-lc", "echo hi"], "  run this instead  ")).toEqual({
      isWrapper: true,
      command: "run this instead",
    });
  });
});
