#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  findUnmatchedExplicitTestTargets,
  isTestFileTarget,
  resolveChangedTestTargetPlan,
} from "../test-projects.test-support.mts";
import { crabboxGatePlanDigest, validateCrabboxGatePlan } from "./crabbox-gate-contract.mjs";

type ChangedPath = { path: string; status: "A" | "D" | "M" | "T" };

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DOCS_OR_INSTRUCTIONS = /^(?:docs\/|(?:.+\/)?AGENTS\.md$|(?:.+\/)?CLAUDE\.md$)/u;

function listChangedPaths(baseSha: string, headSha: string, cwd: string): ChangedPath[] {
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "--no-renames", "-z", `${baseSha}...${headSha}`],
    { cwd, encoding: "utf8" },
  );
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  if (fields.length % 2 !== 0) {
    throw new Error("git returned malformed changed-path metadata");
  }
  const changedPaths: ChangedPath[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const rawStatus = fields[index];
    const changedPath = fields[index + 1];
    if (
      !rawStatus ||
      !changedPath ||
      !["A", "D", "M", "T"].includes(rawStatus) ||
      path.posix.normalize(changedPath) !== changedPath ||
      changedPath.startsWith("../") ||
      changedPath.startsWith("/")
    ) {
      throw new Error(`Crabbox gate cannot safely plan changed path ${changedPath ?? "unknown"}`);
    }
    changedPaths.push({ path: changedPath, status: rawStatus as ChangedPath["status"] });
  }
  return changedPaths.toSorted((a, b) =>
    `${a.path}\0${a.status}`.localeCompare(`${b.path}\0${b.status}`),
  );
}

export function createCrabboxGatePlan({
  baseSha,
  changedPaths,
  cwd = process.cwd(),
  headSha,
  resolvePathPlan = (changedPath: string) =>
    resolveChangedTestTargetPlan([changedPath], {
      broad: false,
      combineSiblingWithImportGraph: true,
      cwd,
      forceFullImportGraph: true,
      includeExtensionImpact: false,
    }),
}: {
  baseSha: string;
  changedPaths: ChangedPath[];
  cwd?: string;
  headSha: string;
  resolvePathPlan?: (changedPath: string) => {
    mode: string;
    skippedBroadFallbackPaths?: string[];
    targets: string[];
  };
}) {
  if (!SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(headSha)) {
    throw new Error("Crabbox gate plan requires exact base and head SHAs");
  }
  const targets = new Set<string>();
  for (const entry of changedPaths) {
    if (DOCS_OR_INSTRUCTIONS.test(entry.path)) {
      continue;
    }
    if (!existsSync(path.join(cwd, entry.path))) {
      throw new Error(`Crabbox gate refuses deleted or missing executable path ${entry.path}`);
    }
    const pathPlan = resolvePathPlan(entry.path);
    if (
      pathPlan.mode !== "targets" ||
      (pathPlan.skippedBroadFallbackPaths?.length ?? 0) > 0 ||
      pathPlan.targets.length === 0
    ) {
      throw new Error(`Crabbox gate has no complete targeted test plan for ${entry.path}`);
    }
    for (const target of pathPlan.targets) {
      if (
        !isTestFileTarget(target) ||
        /^test\/vitest\/.+\.config\.ts$/u.test(target) ||
        findUnmatchedExplicitTestTargets([target], cwd).length > 0
      ) {
        throw new Error(`Crabbox gate refuses broad or unmatched target ${target}`);
      }
      targets.add(target);
    }
  }
  return validateCrabboxGatePlan({
    baseSha,
    changedPaths: changedPaths.toSorted((a, b) =>
      `${a.path}\0${a.status}`.localeCompare(`${b.path}\0${b.status}`),
    ),
    headSha,
    targets: [...targets].toSorted((a, b) => a.localeCompare(b)),
    version: 1,
  });
}

export function resolveCrabboxGatePlan({
  baseSha,
  cwd = process.cwd(),
  headSha,
}: {
  baseSha: string;
  cwd?: string;
  headSha: string;
}) {
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  if (actualHead !== headSha) {
    throw new Error(`Crabbox gate planner checkout is at ${actualHead}, expected ${headSha}`);
  }
  return createCrabboxGatePlan({
    baseSha,
    changedPaths: listChangedPaths(baseSha, headSha, cwd),
    cwd,
    headSha,
  });
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Crabbox gate planner requires flag/value pairs");
    }
    values.set(flag, value);
  }
  return {
    baseSha: values.get("--base") ?? "",
    headSha: values.get("--head") ?? "",
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const plan = resolveCrabboxGatePlan(args);
    process.stdout.write(`${JSON.stringify({ ...plan, digest: crabboxGatePlanDigest(plan) })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
