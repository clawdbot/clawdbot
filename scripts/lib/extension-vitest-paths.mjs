import path from "node:path";

const EXTENSIONS_PATH_PREFIX = "extensions/";
const repoRoot = path.resolve(import.meta.dirname, "../..");
const VITEST_VALUE_FLAGS = new Set([
  "-c",
  "-r",
  "-t",
  "--browser",
  "--changed",
  "--config",
  "--coverage.all",
  "--coverage.exclude",
  "--coverage.extension",
  "--coverage.include",
  "--coverage.provider",
  "--coverage.reporter",
  "--coverage.reportsDirectory",
  "--dir",
  "--environment",
  "--environmentOptions",
  "--hookTimeout",
  "--inspect",
  "--inspectBrk",
  "--maxConcurrency",
  "--maxWorkers",
  "--minWorkers",
  "--mode",
  "--name",
  "--outputFile",
  "--pool",
  "--project",
  "--reporter",
  "--retry",
  "--root",
  "--sequence",
  "--shard",
  "--testNamePattern",
  "--testTimeout",
  "--workspace",
]);

export function normalizeRelativePath(inputPath, cwd = process.cwd()) {
  const absolutePath = path.isAbsolute(inputPath)
    ? inputPath
    : inputPath.startsWith(EXTENSIONS_PATH_PREFIX)
      ? path.resolve(repoRoot, inputPath)
      : path.resolve(cwd, inputPath);
  const repoRelative = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
  return repoRelative === ".." || repoRelative.startsWith("../")
    ? inputPath.split(path.sep).join("/")
    : repoRelative;
}

export function relativizeExtensionVitestPath(inputPath, cwd = process.cwd()) {
  const normalized = normalizeRelativePath(inputPath, cwd);
  return normalized.startsWith(EXTENSIONS_PATH_PREFIX)
    ? normalized.slice(EXTENSIONS_PATH_PREFIX.length)
    : normalized;
}

export function relativizeExtensionVitestArgs(vitestArgs, cwd = process.cwd()) {
  const args = [];
  for (let index = 0; index < vitestArgs.length; index += 1) {
    const arg = vitestArgs[index];
    if (arg === "--exclude") {
      const value = vitestArgs[index + 1];
      args.push(arg);
      if (value) {
        args.push(relativizeExtensionVitestPath(value, cwd));
        index += 1;
      }
      continue;
    }

    if (VITEST_VALUE_FLAGS.has(arg)) {
      args.push(arg);
      const value = vitestArgs[index + 1];
      if (value) {
        args.push(value);
        index += 1;
      }
      continue;
    }

    const excludePrefix = "--exclude=";
    if (arg.startsWith(excludePrefix)) {
      args.push(
        `${excludePrefix}${relativizeExtensionVitestPath(arg.slice(excludePrefix.length), cwd)}`,
      );
      continue;
    }

    args.push(arg.startsWith("-") ? arg : relativizeExtensionVitestPath(arg, cwd));
  }
  return args;
}
