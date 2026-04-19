import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function parsePackageRootArg(argv, envName) {
  let packageRoot = process.env[envName];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-root") {
      packageRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith("--package-root=")) {
      packageRoot = arg.slice("--package-root=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { packageRoot: path.resolve(packageRoot ?? defaultPackageRoot) };
}
