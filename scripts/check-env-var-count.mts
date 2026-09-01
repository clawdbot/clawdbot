import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  enforceRatchetScalar,
  loadRatchetReference,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetScalar,
  reportRatchetSuccess,
} from "./lib/shrink-ratchet.mts";

const BUDGET_PATH = "config/env-var-count-budget.txt";
const SOURCE_ROOTS = ["src", "packages", "extensions"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const ENV_VAR_PATTERN = /OPENCLAW_[A-Z0-9_]+/gu;

export function isCountedSourcePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  if (!SOURCE_ROOTS.some((root) => normalized.startsWith(root + "/"))) {
    return false;
  }
  if (!SOURCE_EXTENSIONS.has(path.posix.extname(normalized))) {
    return false;
  }
  if (
    /^(?:extensions\/(?:qa-lab|test-support)|.*\/(?:__tests__|test|tests|test-utils|test-support))\//u.test(
      normalized,
    )
  ) {
    return false;
  }
  return !/(?:^|[./-])(?:e2e|live-helpers|live-harness|spec|suite|test|test-helpers|test-harness|test-setup|test-support|test-utils)(?:[./-]|$)/u.test(
    normalized,
  );
}

export function collectEnvVarNames(root = process.cwd(), options: { staged?: boolean } = {}) {
  const staged = options.staged === true;
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      ...(staged ? [] : ["--others", "--exclude-standard"]),
      "--",
      ...SOURCE_ROOTS,
    ],
    { cwd: root, maxBuffer: 256 * 1024 * 1024 },
  )
    .toString("utf8")
    .split("\0")
    .filter(isCountedSourcePath)
    .filter((file) => staged || fs.existsSync(path.join(root, file)));
  const sources = staged ? loadRatchetSources(root, files).values() : files;
  const names = new Set<string>();
  for (const entry of sources) {
    const source = staged ? entry : fs.readFileSync(path.join(root, entry), "utf8");
    for (const match of source.matchAll(ENV_VAR_PATTERN)) {
      names.add(match[0]);
    }
  }
  return [...names].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function parseBudget(source: string) {
  return parseRatchetScalar(source, BUDGET_PATH);
}

function readBaseBudget(root: string, ref: string) {
  const resolved = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (resolved.status !== 0) {
    throw new Error(`Could not resolve env-var count base ref: ${ref}`);
  }
  const mergeBase = spawnSync("git", ["merge-base", "HEAD", ref], {
    cwd: root,
    encoding: "utf8",
  });
  const baselineRef = mergeBase.stdout.trim();
  // Exit 1 with no output is git reporting no shared ancestor; a real failure exits 128.
  // Shallow clones and grafted agent checkouts resolve the ref but truncate history, and
  // only the growth comparison needs a baseline, so skip it rather than failing the gate.
  if (mergeBase.status === 1 && !baselineRef) {
    process.stderr.write(
      `[env-var-count] ${ref} shares no reachable ancestor here; skipping the base-budget comparison\n`,
    );
    return null;
  }
  if (mergeBase.status !== 0 || !baselineRef) {
    throw new Error(`Could not resolve env-var count merge base for: ${ref}`);
  }
  return loadRatchetReference(root, baselineRef, BUDGET_PATH, parseBudget);
}

export function main(argv: string[] = process.argv.slice(2), root = process.cwd()) {
  const baseIndex = argv.indexOf("--base");
  const baseRef = baseIndex < 0 ? "origin/main" : argv[baseIndex + 1];
  const staged = argv.includes("--staged");
  const expectedLength = (baseIndex >= 0 ? 2 : 0) + (staged ? 1 : 0);
  if (!baseRef || argv.length !== expectedLength) {
    throw new Error(
      "Usage: node --import tsx scripts/check-env-var-count.mts [--staged] [--base <git-ref>]",
    );
  }
  const budget = loadRatchetSnapshot(root, BUDGET_PATH, staged, parseBudget);
  const baseBudget = readBaseBudget(root, baseRef);
  if (baseBudget !== null) {
    enforceRatchetScalar(budget, baseBudget, {
      increased: `OPENCLAW_* budget grew from ${baseBudget} to ${budget}`,
    });
  }
  const names = collectEnvVarNames(root, { staged });
  enforceRatchetScalar(names.length, budget, {
    decreased: `OPENCLAW_* count ${names.length} is below budget ${budget}; update ${BUDGET_PATH}`,
    increased: `OPENCLAW_* count ${names.length} exceeds budget ${budget}; update ${BUDGET_PATH}`,
  });
  reportRatchetSuccess(`OPENCLAW_* count ${names.length}/${budget}`);
  return names.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
