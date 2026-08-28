import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { escapeRegExp } from "../shared/regexp.js";
import { runStep } from "./update-runner-command.js";
import type {
  CommandRunner,
  UpdateRunnerOptions,
  UpdateStepResult,
} from "./update-runner-types.js";

type RemoteFetchConfig = Map<string, string[]>;

function parseRemoteFetchConfig(stdout: string): RemoteFetchConfig {
  const config: RemoteFetchConfig = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^remote\.(.+)\.fetch\s+(.+)$/u.exec(line.trim());
    const remote = match?.[1];
    const refspec = match?.[2];
    if (remote && refspec) {
      config.set(remote, [...(config.get(remote) ?? []), refspec]);
    }
  }
  return config;
}

function isTagFetchRefspec(refspec: string): boolean {
  const [source = "", destination = ""] = refspec.replace(/^[+^]/u, "").split(":", 2);
  return [source, destination].some(
    (ref) => ref === "refs/*" || ref === "refs/tags" || ref.startsWith("refs/tags/"),
  );
}

export type StableGitFetchResult = {
  reason?: "fetch-failed";
  remotes?: string[];
};

export async function prepareStableGitFetch(params: {
  gitRoot: string;
  timeoutMs: number;
  runCommand: CommandRunner;
  progress?: UpdateRunnerOptions["progress"];
  steps: UpdateStepResult[];
  fetchAllArgv: string[];
}): Promise<StableGitFetchResult> {
  const { gitRoot, timeoutMs, runCommand, progress, steps, fetchAllArgv } = params;
  const executeStep = (name: string, argv: string[], allowMissing = false) =>
    runStep({
      runCommand: allowMissing
        ? async (command, options) => {
            const result = await runCommand(command, options);
            return result.code === 1 ? { ...result, code: 0 } : result;
          }
        : runCommand,
      name,
      argv,
      cwd: gitRoot,
      timeoutMs,
      progress,
      results: steps,
    });
  const fetchConfigArgv = ["git", "-C", gitRoot, "config", "--get-regexp", "^remote\\..*\\.fetch$"];
  const fetchConfigResult = await runCommand(fetchConfigArgv, { cwd: gitRoot, timeoutMs });
  if (fetchConfigResult.code !== 0 && fetchConfigResult.code !== 1) {
    return { reason: "fetch-failed" };
  }
  const fetchConfig = parseRemoteFetchConfig(fetchConfigResult.stdout);
  const hasConfiguredTagRefspec = [...fetchConfig.values()].some((refspecs) =>
    refspecs.some(isTagFetchRefspec),
  );
  if (!hasConfiguredTagRefspec) {
    const fetchStep = await executeStep("git fetch", fetchAllArgv);
    return fetchStep.exitCode === 0 ? {} : { reason: "fetch-failed" };
  }

  const remoteStep = await executeStep("git remote", ["git", "-C", gitRoot, "remote"]);
  if (remoteStep.exitCode !== 0) {
    return { reason: "fetch-failed" };
  }
  const remotes = normalizeStringEntries((remoteStep.stdoutTail ?? "").split("\n"));
  let fetchFailed = false;
  for (const remote of remotes) {
    const skipStep = await executeStep(
      "git config remote skip",
      [
        "git",
        "-C",
        gitRoot,
        "config",
        "--type=bool",
        "--get-regexp",
        `^remote\\.${escapeRegExp(remote)}\\.(skipfetchall|skipdefaultupdate)$`,
      ],
      true,
    );
    if (skipStep.exitCode !== 0) {
      return { reason: "fetch-failed" };
    }
    const skipValues = (skipStep.stdoutTail ?? "").trimEnd().split("\n");
    if (skipValues.at(-1)?.endsWith(" true")) {
      continue;
    }
    const configuredRefspecs = fetchConfig.get(remote);
    const branchRefspecs = configuredRefspecs?.filter((refspec) => !isTagFetchRefspec(refspec));
    if (configuredRefspecs && branchRefspecs?.length === 0) {
      continue;
    }
    const fetchArgv = [
      "git",
      "-C",
      gitRoot,
      "fetch",
      "--prune",
      "--no-prune-tags",
      "--no-tags",
      ...(configuredRefspecs ? ["--refmap="] : []),
      "--",
      remote,
      ...(configuredRefspecs ? (branchRefspecs ?? []) : []),
    ];
    const fetchStep = await executeStep(`git fetch ${remote}`, fetchArgv);
    if (fetchStep.exitCode !== 0) {
      // Match `git fetch --all`: attempt every non-skipped remote before returning failure.
      fetchFailed = true;
    }
  }
  return fetchFailed ? { reason: "fetch-failed" } : { remotes };
}
