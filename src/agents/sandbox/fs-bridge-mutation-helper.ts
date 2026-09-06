/**
 * Shell plans for pinned sandbox filesystem operations.
 *
 * Selects the local interpreter and supplies quoted Python source to local and remote transports.
 */
import { PATH_ALIAS_POLICIES } from "../../infra/path-alias-guards.js";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-python.js";
import type {
  PathSafetyCheck,
  PinnedSandboxDirectoryEntry,
  PinnedSandboxEntry,
} from "./fs-bridge-path-safety.js";
import type { SandboxFsCommandPlan } from "./fs-bridge-shell-command-plans.js";

const SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES = [
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "/bin/python3",
] as const;

export const SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL = `'${SANDBOX_PINNED_MUTATION_PYTHON.replaceAll("'", `'\\''`)}'`;

function buildPinnedMutationPlan(params: {
  args: string[];
  checks: PathSafetyCheck[];
}): SandboxFsCommandPlan {
  return {
    checks: params.checks,
    recheckBeforeCommand: true,
    // -c executes reliably on older Python builds while stdin carries payload bytes.
    script: [
      "set -eu",
      "python_cmd=''",
      ...SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES.map(
        (candidate) =>
          `if [ -z "$python_cmd" ] && [ -x '${candidate}' ]; then python_cmd='${candidate}'; fi`,
      ),
      'if [ -z "$python_cmd" ]; then python_cmd=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true); fi',
      'if [ -z "$python_cmd" ]; then',
      "  echo >&2 'sandbox pinned mutation helper requires python3 or python'",
      "  exit 127",
      "fi",
      `python_script=${SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL}`,
      'exec "$python_cmd" -c "$python_script" "$@"',
    ].join("\n"),
    args: params.args,
  };
}

export function buildPinnedWritePlan(params: {
  check: PathSafetyCheck;
  pinned: PinnedSandboxEntry;
  mkdir: boolean;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [params.check],
    args: [
      "write",
      params.pinned.mountRootPath,
      params.pinned.relativeParentPath,
      params.pinned.basename,
      params.mkdir ? "1" : "0",
    ],
  });
}

export function buildPinnedCreatePlan(params: {
  check: PathSafetyCheck;
  pinned: PinnedSandboxEntry;
  mkdir: boolean;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [params.check],
    args: [
      "create",
      params.pinned.mountRootPath,
      params.pinned.relativeParentPath,
      params.pinned.basename,
      params.mkdir ? "1" : "0",
    ],
  });
}

export function buildPinnedCopyPlan(params: {
  sourceCheck: PathSafetyCheck;
  destinationCheck: PathSafetyCheck;
  source: PinnedSandboxEntry;
  destination: PinnedSandboxEntry;
  mkdir: boolean;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [params.sourceCheck, params.destinationCheck],
    args: [
      "copy",
      params.source.mountRootPath,
      params.source.relativeParentPath,
      params.source.basename,
      params.destination.mountRootPath,
      params.destination.relativeParentPath,
      params.destination.basename,
      params.mkdir ? "1" : "0",
    ],
  });
}

export function buildPinnedMkdirpPlan(params: {
  check: PathSafetyCheck;
  pinned: PinnedSandboxDirectoryEntry;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [params.check],
    args: ["mkdirp", params.pinned.mountRootPath, params.pinned.relativePath],
  });
}

export function buildPinnedReadDirectoryPlan(params: {
  check: PathSafetyCheck;
  pinned: PinnedSandboxDirectoryEntry;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [params.check],
    args: ["readdir", params.pinned.mountRootPath, params.pinned.relativePath],
  });
}

export function buildPinnedRemovePlan(params: {
  check: PathSafetyCheck;
  pinned: PinnedSandboxEntry;
  recursive?: boolean;
  force?: boolean;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [
      {
        target: params.check.target,
        options: {
          ...params.check.options,
          aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget,
        },
      },
    ],
    args: [
      "remove",
      params.pinned.mountRootPath,
      params.pinned.relativeParentPath,
      params.pinned.basename,
      params.recursive ? "1" : "0",
      params.force === false ? "0" : "1",
    ],
  });
}

export function buildPinnedRenamePlan(params: {
  fromCheck: PathSafetyCheck;
  toCheck: PathSafetyCheck;
  from: PinnedSandboxEntry;
  to: PinnedSandboxEntry;
}): SandboxFsCommandPlan {
  return buildPinnedMutationPlan({
    checks: [
      {
        target: params.fromCheck.target,
        options: {
          ...params.fromCheck.options,
          aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget,
        },
      },
      params.toCheck,
    ],
    args: [
      "rename",
      params.from.mountRootPath,
      params.from.relativeParentPath,
      params.from.basename,
      params.to.mountRootPath,
      params.to.relativeParentPath,
      params.to.basename,
      "1",
    ],
  });
}
