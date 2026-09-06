/** Builds and revalidates system.run approval plans for cwd and executable paths. */
import fs from "node:fs";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";
import { isBlockedShellWrapperCommand } from "../infra/exec-wrapper-resolution.js";
import { resolveMutableFileOperandSnapshotSync } from "../infra/system-run-approval-binding.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import {
  type ApprovedCwdSnapshot,
  captureApprovedCwdSnapshotSync,
} from "../infra/system-run-cwd-binding.js";

function shouldPinExecutableForApproval(params: {
  shellCommand: string | null;
  wrapperChain: string[] | undefined;
}): boolean {
  return params.shellCommand === null && (params.wrapperChain?.length ?? 0) === 0;
}

export function hardenApprovedExecutionPaths(params: {
  approvedByAsk: boolean;
  argv: string[];
  shellCommand: string | null;
  cwd: string | undefined;
}):
  | {
      ok: true;
      argv: string[];
      argvChanged: boolean;
      cwd: string | undefined;
      approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
    }
  | { ok: false; message: string } {
  if (!params.approvedByAsk) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: params.cwd,
      approvedCwdSnapshot: undefined,
    };
  }

  // Capture an omitted cwd once on the execution host. Approval, persistence,
  // revalidation, and process launch must all bind the same directory identity.
  let hardenedCwd = params.cwd ?? process.cwd();
  const canonicalCwd = captureApprovedCwdSnapshotSync(hardenedCwd);
  if (!canonicalCwd.ok) {
    return canonicalCwd;
  }
  hardenedCwd = canonicalCwd.snapshot.cwd;
  const approvedCwdSnapshot = canonicalCwd.snapshot;

  const resolution = resolveCommandResolutionFromArgv(params.argv, hardenedCwd);
  if (
    params.argv.length === 0 ||
    !shouldPinExecutableForApproval({
      shellCommand: params.shellCommand,
      wrapperChain: resolution?.wrapperChain,
    })
  ) {
    // Wrapper argv must stay intact: replacing its effective executable can shift
    // positional arguments and run a different command than the approved one.
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: hardenedCwd,
      approvedCwdSnapshot,
    };
  }

  const pinnedExecutable =
    resolution?.execution.resolvedRealPath ?? resolution?.execution.resolvedPath;
  if (!pinnedExecutable) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
    };
  }
  if (pinnedExecutable === params.argv[0]) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: hardenedCwd,
      approvedCwdSnapshot,
    };
  }
  const argv = [...params.argv];
  argv[0] = pinnedExecutable;
  return { ok: true, argv, argvChanged: true, cwd: hardenedCwd, approvedCwdSnapshot };
}

export function buildSystemRunApprovalPlan(
  params: {
    command?: unknown;
    rawCommand?: unknown;
    cwd?: unknown;
    agentId?: unknown;
    sessionKey?: unknown;
  },
  bindApproval = true,
): { ok: true; plan: SystemRunApprovalPlan } | { ok: false; message: string } {
  const command = resolveSystemRunCommandRequest({
    command: params.command,
    rawCommand: params.rawCommand,
  });
  if (!command.ok) {
    return { ok: false, message: command.message };
  }
  if (command.argv.length === 0) {
    return { ok: false, message: "command required" };
  }
  if (bindApproval && command.shellPayload === null && isBlockedShellWrapperCommand(command.argv)) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    };
  }
  let cwd = normalizeNullableString(params.cwd) ?? undefined;
  if (!bindApproval) {
    // Ordinary execution follows aliases once; approval binding keeps its stricter path checks.
    try {
      cwd = fs.realpathSync(cwd ?? process.cwd());
    } catch {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: working directory does not exist or is inaccessible",
      };
    }
  }
  const hardening = hardenApprovedExecutionPaths({
    approvedByAsk: bindApproval,
    argv: command.argv,
    shellCommand: command.shellPayload,
    cwd,
  });
  if (!hardening.ok) {
    return hardening;
  }
  const commandText = formatExecCommand(hardening.argv);
  const commandPreview =
    command.previewText?.trim() && command.previewText.trim() !== commandText
      ? command.previewText.trim()
      : null;
  const mutableFileOperand = bindApproval
    ? resolveMutableFileOperandSnapshotSync({
        argv: hardening.argv,
        cwd: hardening.cwd,
        shellCommand: command.shellPayload,
      })
    : { ok: true as const, snapshot: null };
  if (!mutableFileOperand.ok) {
    return mutableFileOperand;
  }
  return {
    ok: true,
    plan: {
      argv: hardening.argv,
      cwd: hardening.cwd ?? null,
      commandText,
      commandPreview,
      agentId: normalizeNullableString(params.agentId),
      sessionKey: normalizeNullableString(params.sessionKey),
      mutableFileOperand: mutableFileOperand.snapshot ?? undefined,
    },
  };
}
