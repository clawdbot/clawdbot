import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BUDGET_PATH = "config/env-var-count-budget.txt";
const SOURCE_ROOTS = ["src", "packages", "extensions"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const ENV_VAR_PATTERN = /OPENCLAW_[A-Z0-9_]+/gu;

export function isCountedSourcePath(filePath) {
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

export function collectEnvVarNames(root = process.cwd(), options = {}) {
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
  const names = new Set();
  for (const file of files) {
    const source = staged
      ? execFileSync("git", ["show", `:${file}`], { cwd: root, encoding: "utf8" })
      : fs.readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(ENV_VAR_PATTERN)) {
      names.add(match[0]);
    }
  }
  return [...names].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function parseBudget(source) {
  const values = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (values.length !== 1 || !/^\d+$/u.test(values[0])) {
    throw new Error(`${BUDGET_PATH} must contain exactly one non-negative integer`);
  }
  return Number(values[0]);
}

function readBaseBudget(root, ref) {
  const resolved = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (resolved.status !== 0) {
    throw new Error(`Could not resolve env-var count base ref: ${ref}`);
  }
  const entry = execFileSync("git", ["ls-tree", "--name-only", ref, "--", BUDGET_PATH], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!entry) {
    return null;
  }
  return parseBudget(
    execFileSync("git", ["show", `${ref}:${BUDGET_PATH}`], { cwd: root, encoding: "utf8" }),
  );
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const baseIndex = argv.indexOf("--base");
  const baseRef = baseIndex >= 0 ? argv[baseIndex + 1] : "origin/main";
  const staged = argv.includes("--staged");
  const expectedLength = (baseIndex >= 0 ? 2 : 0) + (staged ? 1 : 0);
  if ((baseIndex >= 0 && !baseRef) || argv.length !== expectedLength) {
    throw new Error("Usage: node scripts/check-env-var-count.mjs [--staged] [--base <git-ref>]");
  }
  const budgetSource = staged
    ? execFileSync("git", ["show", `:${BUDGET_PATH}`], { cwd: root, encoding: "utf8" })
    : fs.readFileSync(path.join(root, BUDGET_PATH), "utf8");
  const budget = parseBudget(budgetSource);
  const baseBudget = readBaseBudget(root, baseRef);
  if (baseBudget !== null && budget > baseBudget) {
    throw new Error(`OPENCLAW_* budget grew from ${baseBudget} to ${budget}`);
  }
  const names = collectEnvVarNames(root, { staged });
  if (names.length !== budget) {
    const direction = names.length > budget ? "exceeds" : "is below";
    throw new Error(
      `OPENCLAW_* count ${names.length} ${direction} budget ${budget}; update ${BUDGET_PATH}`,
    );
  }
  console.log(`OPENCLAW_* count ${names.length}/${budget}`);
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
