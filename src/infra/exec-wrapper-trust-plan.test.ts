import { describe, expect, test } from "vitest";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";

describe("resolveExecWrapperTrustPlan", () => {
  test.each([
    {
      name: "unwraps transparent caffeinate wrappers before shell policy checks",
      enabled: process.platform !== "win32",
      argv: ["/usr/bin/caffeinate", "-d", "-w", "42", "sh", "-c", "echo hi"],
      expected: {
        argv: ["sh", "-c", "echo hi"],
        policyArgv: ["sh", "-c", "echo hi"],
        wrapperChain: ["caffeinate"],
        policyBlocked: false,
        shellWrapperExecutable: true,
        shellInlineCommand: "echo hi",
      },
    },
    {
      name: "unwraps dispatch wrappers and shell multiplexers into one trust plan",
      enabled: process.platform !== "win32",
      argv: ["/usr/bin/time", "-p", "busybox", "sh", "-c", "echo hi"],
      expected: {
        argv: ["sh", "-c", "echo hi"],
        policyArgv: ["busybox", "sh", "-c", "echo hi"],
        wrapperChain: ["time", "busybox"],
        policyBlocked: false,
        shellWrapperExecutable: true,
        shellInlineCommand: "echo hi",
      },
    },
    {
      name: "unwraps script wrappers before evaluating nested shell payloads",
      enabled: process.platform === "darwin" || process.platform === "freebsd",
      argv: ["/usr/bin/script", "-q", "/dev/null", "sh", "-c", "echo hi"],
      expected: {
        argv: ["sh", "-c", "echo hi"],
        policyArgv: ["sh", "-c", "echo hi"],
        wrapperChain: ["script"],
        policyBlocked: false,
        shellWrapperExecutable: true,
        shellInlineCommand: "echo hi",
      },
    },
    {
      name: "unwraps sandbox-exec wrappers before evaluating nested shell payloads",
      enabled: process.platform !== "win32",
      argv: ["/usr/bin/sandbox-exec", "-p", "(allow default)", "sh", "-c", "echo hi"],
      expected: {
        argv: ["sh", "-c", "echo hi"],
        policyArgv: ["sh", "-c", "echo hi"],
        wrapperChain: ["sandbox-exec"],
        policyBlocked: false,
        shellWrapperExecutable: true,
        shellInlineCommand: "echo hi",
      },
    },
    {
      name: "omits startup shell inline payloads from trust plans",
      enabled: process.platform !== "win32",
      argv: ["bash", "--login", "-c", "echo hi"],
      expected: {
        argv: ["bash", "--login", "-c", "echo hi"],
        policyArgv: ["bash", "--login", "-c", "echo hi"],
        wrapperChain: [],
        policyBlocked: false,
        shellWrapperExecutable: true,
        shellInlineCommand: null,
      },
    },
    {
      name: "fails closed for unsupported shell multiplexer applets",
      enabled: true,
      argv: ["busybox", "sed", "-n", "1p"],
      expected: {
        argv: ["busybox", "sed", "-n", "1p"],
        policyArgv: ["busybox", "sed", "-n", "1p"],
        wrapperChain: [],
        policyBlocked: true,
        blockedWrapper: "busybox",
        shellWrapperExecutable: false,
        shellInlineCommand: null,
      },
    },
    {
      name: "fails closed when outer-wrapper depth overflows",
      enabled: true,
      argv: ["nohup", "timeout", "5s", "busybox", "sh", "-lc", "echo hi"],
      depth: 2,
      expected: {
        argv: ["busybox", "sh", "-lc", "echo hi"],
        policyArgv: ["busybox", "sh", "-lc", "echo hi"],
        wrapperChain: ["nohup", "timeout"],
        policyBlocked: true,
        blockedWrapper: "busybox",
        shellWrapperExecutable: false,
        shellInlineCommand: null,
      },
    },
    {
      name: "keeps the blocked dispatch argv as the policy target after transparent unwraps",
      enabled: process.platform !== "win32",
      argv: ["/usr/bin/time", "-p", "/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
      expected: {
        argv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
        policyArgv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
        wrapperChain: [],
        policyBlocked: true,
        blockedWrapper: "env",
        shellWrapperExecutable: false,
        shellInlineCommand: null,
      },
    },
  ])("$name", ({ enabled, argv, depth, expected }) => {
    if (!enabled) {
      return;
    }
    expect(resolveExecWrapperTrustPlan(argv, depth)).toEqual(expected);
  });
});
