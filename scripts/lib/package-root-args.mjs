// Parses package-root CLI/env overrides for package validation scripts.
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readPackageRootValue(value, optionName) {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

/** Parse `--package-root` or an environment fallback into an absolute package root. */
export function parsePackageRootArg(argv, envName) {
  let packageRoot = process.env[envName];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-root") {
      packageRoot = readPackageRootValue(argv[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--package-root=")) {
      packageRoot = readPackageRootValue(arg.slice("--package-root=".length), "--package-root");
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { packageRoot: path.resolve(packageRoot ?? defaultPackageRoot) };
}
