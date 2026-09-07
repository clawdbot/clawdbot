import { runManagedCommand, signalExitCode } from "./managed-child-process.mts";

const DEFAULT_CWD = process.cwd();
const GIT_TIMEOUT_MS = 60_000;
const TERMINAL_GIT_EXIT_CODES = new Set([
  signalExitCode("SIGHUP"),
  signalExitCode("SIGINT"),
  signalExitCode("SIGTERM"),
]);

function readRefOptionValue(argv: string[], index: number, optionName: string) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]) {
  const args = { base: "", head: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") {
      args.base = readRefOptionValue(argv, i, "--base");
      i += 1;
      continue;
    }
    if (argv[i] === "--head") {
      args.head = readRefOptionValue(argv, i, "--head");
      i += 1;
    }
  }
  return args;
}

type GitFailure = Error & { exitCode: number | null; timedOut: boolean };
type GitRunnerOptions = {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
export type GitRunner = (args: string[]) => Promise<string>;

function formatGitArgs(args: string[]) {
  return args.join(" ");
}

export function gitExitCode(error: unknown) {
  if (!(error instanceof Error) || !("exitCode" in error)) {
    return null;
  }
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : null;
}

export function isTerminalGitFailure(error: unknown) {
  const exitCode = gitExitCode(error);
  return exitCode !== null && TERMINAL_GIT_EXIT_CODES.has(exitCode);
}

function createGitError(args: string[], error: unknown, timeoutMs: number): GitFailure {
  const metadata =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; signal?: unknown; stderr?: unknown })
      : {};
  const exitCode =
    typeof metadata.code === "number" && Number.isSafeInteger(metadata.code) ? metadata.code : null;
  const details = error instanceof Error ? error.message : String(error);
  const timedOut =
    metadata.code === "ETIMEDOUT" ||
    metadata.signal === "SIGTERM" ||
    /timed out|timeout/i.test(details);
  const stderr = typeof metadata.stderr === "string" ? metadata.stderr.trim() : "";
  let message: string;
  if (timedOut) {
    message = `docs:check-i18n-glossary: git ${formatGitArgs(args)} timed out after ${timeoutMs}ms.`;
  } else if (stderr) {
    message = `docs:check-i18n-glossary: git ${formatGitArgs(args)} failed: ${stderr}`;
  } else {
    // Raw spawn and process-tree cleanup failures can reject without stderr;
    // keep the runner's cause so a missing git executable or failed cleanup
    // stays actionable instead of degrading to a generic command failure.
    message = `docs:check-i18n-glossary: git ${formatGitArgs(args)} failed${details ? `: ${details}` : "."}`;
  }
  const wrapped = new Error(message, { cause: error }) as GitFailure;
  wrapped.exitCode = exitCode;
  wrapped.timedOut = timedOut;
  return wrapped;
}

/** Runs glossary Git lookups through the managed process-tree boundary. */
export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const cwd = options.cwd ?? DEFAULT_CWD;
  const env = options.env ?? process.env;
  return async (args: string[]) => {
    let stdout = "";
    let stderr = "";
    let status: number;
    try {
      status = await runManagedCommand({
        bin: "git",
        args,
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Git takes its refs and paths as direct argv; cmd.exe wrapping would
        // reject legal Windows documentation pathnames such as `docs/a&b.md`.
        shell: false,
        // This check runs in automation with a one-minute per-lookup budget.
        // Git has no useful recovery work after the deadline, so do not add
        // the managed runner's default five-second termination grace.
        timeoutKillGraceMs: 0,
        timeoutForceKillOnLeaderExit: true,
        timeoutMs,
        onReady: (child) => {
          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk) => {
            stderr += chunk;
          });
        },
      });
    } catch (error) {
      throw createGitError(args, error, timeoutMs);
    }
    if (status !== 0) {
      throw createGitError(
        args,
        Object.assign(new Error(`git exited with code ${status}`), {
          code: status,
          stderr,
        }),
        timeoutMs,
      );
    }
    return stdout.trim();
  };
}

/**
 * Reads a file from the merge-base revision. A machine-readable `git ls-tree`
 * result decides whether an absent base file should use the empty fallback;
 * all other git failures, including timeouts, propagate to the caller.
 */
export async function readGitFile(base: string, relPath: string, git: GitRunner) {
  const listing = await git(["ls-tree", base, "--", `:(literal)${relPath}`]);
  if (listing === "") {
    return "";
  }
  return await git(["show", `${base}:${relPath}`]);
}
