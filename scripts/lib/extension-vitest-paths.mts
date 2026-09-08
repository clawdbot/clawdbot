import path from "node:path";
import { vitestOptionConsumesNextArg } from "./vitest-cli-mode.mts";

const EXTENSIONS_PATH_PREFIX = "extensions/";
const repoRoot = path.resolve(import.meta.dirname, "../..");

export function normalizeRelativePath(inputPath: string, cwd = process.cwd()): string {
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

export function relativizeExtensionVitestPath(inputPath: string, cwd = process.cwd()): string {
  const normalized = normalizeRelativePath(inputPath, cwd);
  return normalized.startsWith(EXTENSIONS_PATH_PREFIX)
    ? normalized.slice(EXTENSIONS_PATH_PREFIX.length)
    : normalized;
}

export function relativizeExtensionVitestArgs(vitestArgs: string[], cwd = process.cwd()): string[] {
  const args: string[] = [];
  for (let index = 0; index < vitestArgs.length; index += 1) {
    const arg = vitestArgs[index]!;
    if (arg === "--") {
      // Native separator tails are opaque operands, not test-file filters.
      args.push(...vitestArgs.slice(index));
      break;
    }
    const value = vitestArgs[index + 1];
    if (vitestOptionConsumesNextArg(arg, value)) {
      args.push(
        arg,
        arg === "--exclude" || arg === "--exclude="
          ? relativizeExtensionVitestPath(value!, cwd)
          : value!,
      );
      index += 1;
      continue;
    }

    const excludePrefix = "--exclude=";
    if (arg.startsWith(excludePrefix) && arg.length > excludePrefix.length) {
      args.push(
        `${excludePrefix}${relativizeExtensionVitestPath(arg.slice(excludePrefix.length), cwd)}`,
      );
      continue;
    }

    args.push(arg.startsWith("-") ? arg : relativizeExtensionVitestPath(arg, cwd));
  }
  return args;
}
