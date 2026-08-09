import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { isBetaTag, isStableTag, type UpdateChannel } from "./update-channels.js";
import { compareSemverStrings } from "./update-check.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

type GitTargetSchemaMetadata =
  | { status: "ok"; schemaVersions?: OpenClawSchemaVersions }
  | { status: "unreadable"; reason: string };

async function readGitTargetSchemaVersions(params: {
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

export async function resolveChannelTag(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
  channel: Exclude<UpdateChannel, "dev">,
): Promise<string | null> {
  const tags = await listGitTags(runCommand, root, timeoutMs);
  if (channel === "beta") {
    const betaTag = tags.find((tag) => isBetaTag(tag)) ?? null;
    const stableTag = tags.find((tag) => isStableTag(tag)) ?? null;
    if (!betaTag) {
      return stableTag;
    }
    if (!stableTag) {
      return betaTag;
    }
    const comparison = compareSemverStrings(betaTag, stableTag);
    return comparison != null && comparison < 0 ? stableTag : betaTag;
  }
  return tags.find((tag) => isStableTag(tag)) ?? null;
}
