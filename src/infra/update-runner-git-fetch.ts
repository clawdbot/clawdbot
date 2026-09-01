import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { escapeRegExp } from "../shared/regexp.js";
import { runStep } from "./update-runner-command.js";
import type {
  CommandRunner,
  UpdateRunnerOptions,
  UpdateStepResult,
} from "./update-runner-types.js";

type RemoteFetchConfig = Map<string, string[]>;

function isBroadRefspecMapping(source: string, destination: string): boolean {
  const sourceWildcard = source.indexOf("*");
  const destinationWildcard = destination.indexOf("*");
  return (
    sourceWildcard >= 0 &&
    destinationWildcard >= 0 &&
    source.slice(0, sourceWildcard) === "refs/" &&
    destination.slice(0, destinationWildcard) === "refs/"
  );
}

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
  const normalized = refspec.trim();
  if (normalized.startsWith("^")) {
    return false;
  }
  const withoutForce = normalized.replace(/^\+/u, "");
  if (/^tag\s+\S+$/u.test(withoutForce)) {
    return true;
  }
  const [source = "", destination = ""] = withoutForce.split(":", 2).map((ref) => ref.trim());
  if ([source, destination].some((ref) => ref === "refs/tags" || ref.startsWith("refs/tags/"))) {
    return true;
  }

  // A broad refs/*:refs/* mapping expands a tag source into refs/tags locally;
  // keep it out of the preliminary refresh so the canonical tag fetch owns updates.
  return isBroadRefspecMapping(source, destination);
}

function isNegativeFetchRefspec(refspec: string): boolean {
  return refspec.trim().startsWith("^");
}

function isBroadFetchRefspec(refspec: string): boolean {
  const withoutForce = refspec.trim().replace(/^\+/u, "");
  const [source = "", destination = ""] = withoutForce.split(":", 2).map((ref) => ref.trim());
  return isBroadRefspecMapping(source, destination);
}

function isPlainMirrorFetchRefspec(refspec: string): boolean {
  const withoutForce = refspec.trim().replace(/^\+/u, "");
  const [source = "", destination = ""] = withoutForce.split(":", 2).map((ref) => ref.trim());
  return source === "refs/*" && destination === "refs/*";
}

function isFullTagNamespaceExclusion(refspec: string): boolean {
  const normalized = refspec.trim();
  return normalized === "^refs/tags" || normalized === "^refs/tags/*";
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
  let fetchConfigStdout = "";
  const fetchConfigStep = await runStep({
    runCommand: async (command, options) => {
      const result = await runCommand(command, options);
      fetchConfigStdout = result.stdout;
      return result.code === 1 ? { ...result, code: 0 } : result;
    },
    name: "git config fetch refspecs",
    argv: fetchConfigArgv,
    cwd: gitRoot,
    timeoutMs,
    progress,
    results: steps,
  });
  if (fetchConfigStep.exitCode !== 0) {
    return { reason: "fetch-failed" };
  }
  const fetchConfig = parseRemoteFetchConfig(fetchConfigStdout);
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
    // --refmap= ignores remote.*.fetch, so carry configured exclusions into argv explicitly.
    // Git versions without negative-refspec support reject this before any ref mutation.
    const negativeRefspecs = configuredRefspecs?.filter(isNegativeFetchRefspec) ?? [];
    const needsTagExclusion =
      configuredRefspecs?.some(isPlainMirrorFetchRefspec) === true &&
      !negativeRefspecs.some(isFullTagNamespaceExclusion);
    const explicitNegativeRefspecs = needsTagExclusion
      ? [...negativeRefspecs, "^refs/tags/*"]
      : negativeRefspecs;
    const branchRefspecs = configuredRefspecs
      ? [
          ...new Set(
            configuredRefspecs.flatMap((refspec) => {
              if (
                !isNegativeFetchRefspec(refspec) &&
                (!isTagFetchRefspec(refspec) ||
                  (explicitNegativeRefspecs.length > 0 && isBroadFetchRefspec(refspec)))
              ) {
                return [refspec];
              }
              return [];
            }),
          ),
        ]
      : undefined;
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
      ...(configuredRefspecs ? [...(branchRefspecs ?? []), ...explicitNegativeRefspecs] : []),
    ];
    const fetchStep = await executeStep(`git fetch ${remote}`, fetchArgv);
    if (fetchStep.exitCode !== 0) {
      // Match `git fetch --all`: attempt every non-skipped remote before returning failure.
      fetchFailed = true;
    }
  }
  return fetchFailed ? { reason: "fetch-failed" } : { remotes };
}
