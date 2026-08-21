#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { collectClawHubPublishablePluginPackages } from "./lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.ts";
import {
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  RELEASE_PLAN_SCHEMA,
  validateReleasePlan,
  type ReleasePlan,
  type ReleasePlanPurpose,
} from "./release-plan-contract.mjs";

type ReleasePlanIntent = "publish" | "postpublish-confidence" | "main-qualification";

const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const INVENTORY_PATH = "scripts/release-plan-inventory.json";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function deriveReleasePlanPolicy(
  intent: ReleasePlanIntent,
  version: string,
): {
  profile: "beta" | "stable" | "full";
  purpose: ReleasePlanPurpose;
  soak: boolean;
  tag: string | null;
} {
  const prerelease = /-(?:alpha|beta)\.[1-9][0-9]*$/u.test(version);
  if (intent === "main-qualification") {
    return { profile: "full", purpose: "main-qualification", soak: true, tag: null };
  }
  if (intent === "postpublish-confidence") {
    return {
      profile: "full",
      purpose: "postpublish-confidence",
      soak: true,
      tag: `v${version}`,
    };
  }
  return prerelease
    ? { profile: "beta", purpose: "beta-publish", soak: false, tag: `v${version}` }
    : { profile: "stable", purpose: "stable-publish", soak: true, tag: `v${version}` };
}

function collectAllowedGroups(repoRoot: string): string[] {
  const workflow = parseYaml(readFileSync(resolve(repoRoot, WORKFLOW_PATH), "utf8")) as {
    on?: { workflow_dispatch?: { inputs?: { rerun_group?: { options?: unknown } } } };
  };
  const options = workflow.on?.workflow_dispatch?.inputs?.rerun_group?.options;
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    options.some((entry) => typeof entry !== "string" || !entry)
  ) {
    throw new Error(`${WORKFLOW_PATH} must declare rerun_group choice options`);
  }
  return [...new Set(options)].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function collectPackageInventory(repoRoot: string, version: string) {
  const packages = new Map<string, { name: string; version: string; targets: Set<string> }>();
  packages.set("openclaw", { name: "openclaw", version, targets: new Set(["npm"]) });
  for (const plugin of collectPublishablePluginPackages(repoRoot)) {
    packages.set(plugin.packageName, {
      name: plugin.packageName,
      version: plugin.version,
      targets: new Set(["npm"]),
    });
  }
  for (const plugin of collectClawHubPublishablePluginPackages(repoRoot)) {
    const existing = packages.get(plugin.packageName);
    if (existing && existing.version !== plugin.version) {
      throw new Error(`plugin inventory version mismatch for ${plugin.packageName}`);
    }
    const entry = existing ?? {
      name: plugin.packageName,
      version: plugin.version,
      targets: new Set<string>(),
    };
    entry.targets.add("clawhub");
    packages.set(plugin.packageName, entry);
  }
  return [...packages.values()]
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      targets: [...entry.targets].toSorted(),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function collectPlatformInventory(repoRoot: string) {
  const inventory = readJson(resolve(repoRoot, INVENTORY_PATH)) as {
    schema?: unknown;
    platforms?: unknown;
  };
  if (
    inventory.schema !== "openclaw.release-plan-inventory.v1" ||
    !Array.isArray(inventory.platforms)
  ) {
    throw new Error(`${INVENTORY_PATH} must use openclaw.release-plan-inventory.v1`);
  }
  const platforms = inventory.platforms.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${INVENTORY_PATH} contains an invalid platform entry`);
    }
    const platform = entry as Record<string, unknown>;
    if (typeof platform.id !== "string" || typeof platform.source !== "string") {
      throw new Error(`${INVENTORY_PATH} contains an invalid platform entry`);
    }
    if (!existsSync(resolve(repoRoot, platform.source))) {
      throw new Error(`release platform source does not exist: ${platform.source}`);
    }
    return { id: platform.id, source: platform.source };
  });
  return platforms.toSorted((left, right) => left.id.localeCompare(right.id));
}

export function produceReleasePlan(params: {
  repoRoot?: string;
  intent: ReleasePlanIntent;
  toolingFullRef: string;
}): ReleasePlan {
  const repoRoot = resolve(params.repoRoot ?? ".");
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const worktreeStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (worktreeStatus) {
    throw new Error("release plan source checkout must be clean");
  }
  const toolingMatch = /^refs\/(heads|tags)\/(.+)$/u.exec(params.toolingFullRef);
  if (!toolingMatch) {
    throw new Error("tooling full ref must be a qualified branch or tag ref");
  }
  const toolingSha = execFileSync(
    "git",
    ["rev-parse", "--verify", `${params.toolingFullRef}^{commit}`],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  const rootPackage = readJson(resolve(repoRoot, "package.json")) as { version?: unknown };
  if (typeof rootPackage.version !== "string" || !rootPackage.version) {
    throw new Error("package.json version is required");
  }
  const policy = deriveReleasePlanPolicy(params.intent, rootPackage.version);
  return validateReleasePlan({
    schema: RELEASE_PLAN_SCHEMA,
    release_id: rootPackage.version,
    version: rootPackage.version,
    tag: policy.tag,
    candidate_sha: candidateSha,
    target_context_ref: policy.tag ? `refs/tags/${policy.tag}` : candidateSha,
    purpose: policy.purpose,
    tooling: {
      repository: REPOSITORY,
      workflow_path: WORKFLOW_PATH,
      ref: params.toolingFullRef,
      sha: toolingSha,
    },
    validation: {
      profile: policy.profile,
      soak: policy.soak,
      allowed_groups: collectAllowedGroups(repoRoot),
    },
    inventory: {
      packages: collectPackageInventory(repoRoot, rootPackage.version),
      platforms: collectPlatformInventory(repoRoot),
    },
  });
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const intent = requiredOption(args, "--intent") as ReleasePlanIntent;
  if (!["publish", "postpublish-confidence", "main-qualification"].includes(intent)) {
    throw new Error("--intent must be publish, postpublish-confidence, or main-qualification");
  }
  const plan = produceReleasePlan({
    intent,
    toolingFullRef: requiredOption(args, "--tooling-full-ref"),
  });
  process.stdout.write(canonicalReleasePlanLockJson(createReleasePlanLock(plan)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[release-plan-producer] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
