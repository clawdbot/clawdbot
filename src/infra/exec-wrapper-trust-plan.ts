// Builds the trust plan for exec wrappers before commands are launched.
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import {
  MAX_DISPATCH_WRAPPER_DEPTH,
  resolveDispatchWrapperTrustPlan,
  unwrapKnownDispatchWrapperInvocation,
} from "./dispatch-wrapper-resolution.js";
import {
  extractBindableShellWrapperInlineCommand,
  isShellWrapperExecutable,
  unwrapKnownShellMultiplexerInvocation,
} from "./shell-wrapper-resolution.js";

type ExecWrapperTrustPlan = {
  argv: string[];
  policyArgv: string[];
  wrapperChain: string[];
  policyBlocked: boolean;
  blockedWrapper?: string;
  shellWrapperExecutable: boolean;
  shellInlineCommand: string | null;
};

function blockedExecWrapperTrustPlan(params: {
  argv: string[];
  policyArgv?: string[];
  wrapperChain: string[];
  blockedWrapper: string;
}): ExecWrapperTrustPlan {
  return {
    argv: params.argv,
    policyArgv: params.policyArgv ?? params.argv,
    wrapperChain: params.wrapperChain,
    policyBlocked: true,
    blockedWrapper: params.blockedWrapper,
    shellWrapperExecutable: false,
    shellInlineCommand: null,
  };
}

function finalizeExecWrapperTrustPlan(
  argv: string[],
  policyArgv: string[],
  wrapperChain: string[],
  policyBlocked: boolean,
): ExecWrapperTrustPlan {
  const rawExecutable = argv[0]?.trim() ?? "";
  const shellWrapperExecutable =
    !policyBlocked && rawExecutable.length > 0 && isShellWrapperExecutable(rawExecutable);
  const plan: ExecWrapperTrustPlan = {
    argv,
    policyArgv,
    wrapperChain,
    policyBlocked,
    shellWrapperExecutable,
    shellInlineCommand: shellWrapperExecutable
      ? extractBindableShellWrapperInlineCommand(argv)
      : null,
  };
  return plan;
}

const TRANSPARENT_SHELL_ARGV_CARRIERS = new Set(["builtin", "command", "exec"]);

type ShellArgvCarrierUnwrapResult =
  | { kind: "not-wrapper" }
  | { kind: "blocked"; wrapper: string }
  | { kind: "unwrapped"; wrapper: string; argv: string[] };

function commandCarrierUsesDefaultPathSearch(argv: string[]): boolean {
  if (argv[0]?.trim() !== "command") {
    return false;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--" || !token.startsWith("-")) {
      return false;
    }
    if (/^-[^-]*p/u.test(token)) {
      return true;
    }
  }
  return false;
}

function unwrapTransparentShellArgvCarrierInvocation(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): ShellArgvCarrierUnwrapResult {
  if (platform === "win32") {
    return { kind: "not-wrapper" };
  }
  const token0 = argv[0]?.trim();
  if (!token0) {
    return { kind: "not-wrapper" };
  }
  if (!TRANSPARENT_SHELL_ARGV_CARRIERS.has(token0)) {
    return { kind: "not-wrapper" };
  }
  if (commandCarrierUsesDefaultPathSearch(argv)) {
    return { kind: "blocked", wrapper: token0 };
  }
  const unwrapped = resolveCarrierCommandArgv(argv, 0, { includeExec: true });
  return unwrapped && unwrapped.length > 0
    ? { kind: "unwrapped", wrapper: token0, argv: unwrapped }
    : { kind: "blocked", wrapper: token0 };
}

/**
 * Resolves transparent dispatch wrappers into the executable that policy should inspect.
 * Shell multiplexers keep their original argv as the trust target while exposing the
 * nested shell command for shell-specific approval checks.
 */
export function resolveExecWrapperTrustPlan(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
  platform: NodeJS.Platform = process.platform,
): ExecWrapperTrustPlan {
  let current = argv;
  let policyArgv = argv;
  let sawShellMultiplexer = false;
  const wrapperChain: string[] = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const dispatchPlan = resolveDispatchWrapperTrustPlan(
      current,
      maxDepth - wrapperChain.length,
      platform,
    );
    if (dispatchPlan.policyBlocked) {
      return blockedExecWrapperTrustPlan({
        argv: dispatchPlan.argv,
        policyArgv: dispatchPlan.argv,
        wrapperChain,
        blockedWrapper: dispatchPlan.blockedWrapper ?? current[0] ?? "unknown",
      });
    }
    if (dispatchPlan.wrappers.length > 0) {
      wrapperChain.push(...dispatchPlan.wrappers);
      current = dispatchPlan.argv;
      if (!sawShellMultiplexer) {
        policyArgv = current;
      }
      if (wrapperChain.length >= maxDepth) {
        break;
      }
      continue;
    }

    const shellArgvCarrierUnwrap = unwrapTransparentShellArgvCarrierInvocation(current, platform);
    if (shellArgvCarrierUnwrap.kind === "blocked") {
      return blockedExecWrapperTrustPlan({
        argv: current,
        policyArgv,
        wrapperChain,
        blockedWrapper: shellArgvCarrierUnwrap.wrapper,
      });
    }
    if (shellArgvCarrierUnwrap.kind === "unwrapped") {
      wrapperChain.push(shellArgvCarrierUnwrap.wrapper);
      current = shellArgvCarrierUnwrap.argv;
      if (!sawShellMultiplexer) {
        policyArgv = current;
      }
      if (wrapperChain.length >= maxDepth) {
        break;
      }
      continue;
    }

    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(current);
    if (shellMultiplexerUnwrap.kind === "blocked") {
      return blockedExecWrapperTrustPlan({
        argv: current,
        policyArgv,
        wrapperChain,
        blockedWrapper: shellMultiplexerUnwrap.wrapper,
      });
    }
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
      wrapperChain.push(shellMultiplexerUnwrap.wrapper);
      if (!sawShellMultiplexer) {
        // Trust policy must see the multiplexer applet, not only the shell it launches.
        policyArgv = current;
        sawShellMultiplexer = true;
      }
      current = shellMultiplexerUnwrap.argv;
      if (wrapperChain.length >= maxDepth) {
        break;
      }
      continue;
    }

    break;
  }

  if (wrapperChain.length >= maxDepth) {
    const dispatchOverflow = unwrapKnownDispatchWrapperInvocation(current, platform);
    if (dispatchOverflow.kind === "blocked" || dispatchOverflow.kind === "unwrapped") {
      return blockedExecWrapperTrustPlan({
        argv: current,
        policyArgv,
        wrapperChain,
        blockedWrapper: dispatchOverflow.wrapper,
      });
    }
    const shellArgvCarrierOverflow = unwrapTransparentShellArgvCarrierInvocation(current, platform);
    if (
      shellArgvCarrierOverflow.kind === "blocked" ||
      shellArgvCarrierOverflow.kind === "unwrapped"
    ) {
      return blockedExecWrapperTrustPlan({
        argv: current,
        policyArgv,
        wrapperChain,
        blockedWrapper: shellArgvCarrierOverflow.wrapper,
      });
    }
    const shellMultiplexerOverflow = unwrapKnownShellMultiplexerInvocation(current);
    if (
      shellMultiplexerOverflow.kind === "blocked" ||
      shellMultiplexerOverflow.kind === "unwrapped"
    ) {
      return blockedExecWrapperTrustPlan({
        argv: current,
        policyArgv,
        wrapperChain,
        blockedWrapper: shellMultiplexerOverflow.wrapper,
      });
    }
  }

  return finalizeExecWrapperTrustPlan(current, policyArgv, wrapperChain, false);
}
