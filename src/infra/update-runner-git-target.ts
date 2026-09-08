import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { gitNullConfigPath } from "./git-exec.js";
import { isBetaTag, isStableTag, type UpdateChannel } from "./update-channels.js";
import { compareSemverStrings } from "./update-check.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

function quoteGitConfig(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n").replace(/\t/gu, "\\t").replaceAll("\b", "\\b")}"`;
}

function gitConfigEntry(key: string, value: string): string {
  const match = /^([a-z][a-z0-9-]*)\.(?:(.*)\.)?([a-z][a-z0-9-]*)$/iu.exec(key);
  if (!match || /[\r\n]/u.test(match[2] ?? "")) {
    throw new Error("Could not preserve Git target inspection configuration");
  }
  return `[${match[1]}${match[2] === undefined ? "" : ` ${quoteGitConfig(match[2])}`}]\n\t${match[3]} = ${quoteGitConfig(value)}\n`;
}

/** Fetch and candidate selection must not update the installed repository before admission. */
export async function withGitTargetInspectionRoot<T>(
  params: { root: string; runCommand: CommandRunner; timeoutMs: number },
  inspect: (root: string, runCommand: CommandRunner) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-admission-"));
  const inspectionRoot = path.join(temporaryRoot, "repository.git");
  const command = async (root: string, args: string[], allowMissing = false) => {
    const result = await params.runCommand(["git", "-C", root, ...args], {
      cwd: root,
      timeoutMs: params.timeoutMs,
    });
    if (result.code !== 0 && !(allowMissing && result.code === 1)) {
      // Configuration can contain credentials; never include its output in errors.
      throw new Error(`Git target inspection ${args[0]} failed (exit ${result.code})`);
    }
    return result.stdout;
  };
  try {
    await command(params.root, [
      "clone",
      "--mirror",
      "--shared",
      "--template=",
      "--",
      params.root,
      inspectionRoot,
    ]);
    await command(inspectionRoot, ["config", "--remove-section", "remote.origin"]);
    const config = await command(
      params.root,
      [
        "config",
        "--includes",
        "--null",
        "--get-regexp",
        "^((remote|branch|url|http|credential|protocol|filter|fetch|transfer|ssh|user|author|committer|gpg)\\.|commit\\.gpgsign$|core\\.(sshcommand|gitproxy|askpass)$)",
      ],
      true,
    );
    const entries: string[] = [];
    for (const entry of config.split("\0").filter(Boolean)) {
      const separator = entry.indexOf("\n");
      const key = separator === -1 ? entry : entry.slice(0, separator);
      const value = separator === -1 ? "true" : entry.slice(separator + 1);
      entries.push(gitConfigEntry(key, value));
    }
    await fs.appendFile(path.join(inspectionRoot, "config"), entries.join(""), { mode: 0o600 });
    const runInspectionCommand: CommandRunner = (argv, options) =>
      params.runCommand(
        argv[0] === "git" && argv[1] === "-C" && argv[2] === inspectionRoot
          ? // Keep relative remote URLs rooted at the original checkout, but direct
            // all Git metadata writes to the private mirror's independent Git dir.
            [
              "git",
              "-C",
              // Publication may move a new checkout after validation. Cleanup
              // owns only the private Git dir and needs no source-relative transport.
              argv[3] === "worktree" && (argv[4] === "remove" || argv[4] === "prune")
                ? inspectionRoot
                : params.root,
              `--git-dir=${inspectionRoot}`,
              ...argv.slice(3),
            ]
          : argv,
        argv[0] === "git"
          ? {
              ...options,
              // Source-context includes and worktree settings were flattened
              // above. Do not apply globals twice or reselect includes here.
              env: {
                ...options.env,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: gitNullConfigPath(),
                GIT_CONFIG_COUNT: "0",
              },
            }
          : options,
      );
    return await inspect(inspectionRoot, runInspectionCommand);
  } finally {
    // Only this invocation's private inspection clone, never the installed checkout.
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

type GitTargetSchemaMetadata =
  | { status: "ok"; schemaVersions?: OpenClawSchemaVersions }
  | { status: "unreadable"; reason: string };

export async function readGitTargetSchemaVersions(params: {
  runCommand: CommandRunner;
  root: string;
  revision: string;
  timeoutMs: number;
}): Promise<GitTargetSchemaMetadata> {
  let result: Awaited<ReturnType<CommandRunner>>;
  try {
    result = await params.runCommand(
      ["git", "-C", params.root, "show", `${params.revision}:package.json`],
      { cwd: params.root, timeoutMs: params.timeoutMs },
    );
  } catch (error) {
    return { status: "unreadable", reason: String(error) };
  }
  if (result.code !== 0) {
    return {
      status: "unreadable",
      reason: `git show ${params.revision}:package.json exited ${result.code}`,
    };
  }
  try {
    const schemaVersions = parsePackageOpenClawSchemaVersions(JSON.parse(result.stdout) as unknown);
    return { status: "ok", ...(schemaVersions ? { schemaVersions } : {}) };
  } catch (error) {
    return { status: "unreadable", reason: `target package.json unparseable: ${String(error)}` };
  }
}

export async function prepareGitMutation(params: {
  runCommand: CommandRunner;
  root: string;
  revision: string;
  timeoutMs: number;
  beforeGitMutation?: UpdateRunnerOptions["beforeGitMutation"];
}): Promise<{
  allowGatewayServiceRepair?: boolean;
  allowGatewayActivation?: boolean;
}> {
  const target = await readGitTargetSchemaVersions(params);
  const preparation = await params.beforeGitMutation?.(
    target.status === "ok"
      ? target.schemaVersions
        ? { schemaVersions: target.schemaVersions }
        : {}
      : { metadataUnreadable: target.reason },
  );
  return preparation ?? {};
}

export async function selectGitInspectionTarget(
  params: Parameters<typeof runGitCandidatePreflight>[0] & {
    channel: UpdateChannel;
    beforeCandidate: (revision: string) => Promise<void>;
  },
) {
  const tag =
    params.channel === "dev"
      ? undefined
      : await resolveChannelTag(
          params.runCommand,
          params.gitRoot,
          params.timeoutMs,
          params.channel,
        );
  if (params.channel !== "dev" && !tag) {
    return { status: "error" as const, reason: "no-release-tag" };
  }
  return runGitCandidatePreflight({ ...params, targetRevision: tag ?? undefined });
}

export async function readBranchName(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
): Promise<string | null> {
  const result = await runCommand(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs,
  }).catch(() => null);
  const branch = result?.code === 0 ? result.stdout.trim() : "";
  return branch || null;
}

async function listGitTags(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
): Promise<string[]> {
  const result = await runCommand(["git", "-C", root, "tag", "--list", "v*", "--sort=-v:refname"], {
    timeoutMs,
  }).catch(() => null);
  return result?.code === 0 ? normalizeStringEntries(result.stdout.split("\n")) : [];
}

/**
 * Picks the single remote release tags are force-fetched from. The checkout's
 * retained tracking remote (`branch.<main>.remote`) wins when it is still
 * declared, because a detached release checkout keeps that config and a fork
 * `origin` can be tag-less; otherwise the clone's canonical `origin`, then the
 * only declared remote. Multiple non-origin remotes need explicit tracking.
 */
export function resolveReleaseTagRemote(
  remotes: readonly string[],
  trackedUpdateRemote: string,
): string | undefined {
  if (trackedUpdateRemote && remotes.includes(trackedUpdateRemote)) {
    return trackedUpdateRemote;
  }
  return remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
}

export async function resolveChannelTag(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
  channel: Exclude<UpdateChannel, "dev">,
): Promise<string | null> {
  const tags = await listGitTags(runCommand, root, timeoutMs);
  return selectChannelTag(tags, channel);
}

export function selectChannelTag(
  tags: readonly string[],
  channel: Exclude<UpdateChannel, "dev">,
): string | null {
  const orderedTags = normalizeStringEntries(tags).toSorted((left, right) => {
    const comparison = compareSemverStrings(left, right);
    return comparison == null ? right.localeCompare(left) : -comparison;
  });
  if (channel === "beta") {
    const betaTag = orderedTags.find((tag) => isBetaTag(tag)) ?? null;
    const stableTag = orderedTags.find((tag) => isStableTag(tag)) ?? null;
    if (!betaTag) {
      return stableTag;
    }
    if (!stableTag) {
      return betaTag;
    }
    const comparison = compareSemverStrings(betaTag, stableTag);
    return comparison != null && comparison < 0 ? stableTag : betaTag;
  }
  return orderedTags.find((tag) => isStableTag(tag)) ?? null;
}
