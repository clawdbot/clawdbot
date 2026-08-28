import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isBunRuntime } from "../daemon/runtime-binary.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { tryProcessCwd } from "./safe-cwd.js";

const requireFromHere = createRequire(import.meta.url);
const OPENCLAW_CLI_ENTRY_BASENAMES = new Set(["openclaw", "openclaw.mjs"]);
const OPENCLAW_PACKAGE_ENTRY_PATHS = new Set([
  path.join("dist", "entry.js"),
  path.join("dist", "entry.mjs"),
  path.join("dist", "index.js"),
  path.join("dist", "index.mjs"),
  path.join("src", "entry.ts"),
]);

export type OpenClawCliInvocation = Readonly<{
  command: string;
  args: string[];
  cwd: string;
  /** Source-mode tsx needs the checkout's config, independent of the caller's cwd. */
  tsxConfigPath?: string;
}>;

/** Keep child CLI launches on the parent's loader/runtime flags without inheriting its debugger. */
export function filterOpenClawChildExecArgv(execArgv: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index] ?? "";
    if (
      arg === "--inspect" ||
      arg.startsWith("--inspect=") ||
      arg === "--inspect-brk" ||
      arg.startsWith("--inspect-brk=") ||
      arg === "--inspect-wait" ||
      arg.startsWith("--inspect-wait=")
    ) {
      const next = execArgv[index + 1];
      if (!arg.includes("=") && typeof next === "string" && !next.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg === "--inspect-port") {
      const next = execArgv[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--inspect-port=")) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function resolveTrustedTsxLoader(packageRoot: string): string | null {
  try {
    return requireFromHere.resolve("tsx", { paths: [packageRoot] });
  } catch {
    return null;
  }
}

function buildPackageRootCliInvocation(
  packageRoot: string,
  execPath: string,
): Pick<OpenClawCliInvocation, "args" | "tsxConfigPath"> {
  const sourceEntry = path.join(packageRoot, "src", "entry.ts");
  if (fs.existsSync(sourceEntry)) {
    const tsxLoader = resolveTrustedTsxLoader(packageRoot);
    if (isBunRuntime(execPath)) {
      return { args: [sourceEntry] };
    }
    if (tsxLoader) {
      return {
        args: ["--import", tsxLoader, sourceEntry],
        tsxConfigPath: path.join(packageRoot, "tsconfig.json"),
      };
    }
  }
  return { args: [path.join(packageRoot, "openclaw.mjs")] };
}

export function resolveCurrentOpenClawCliInvocation(
  args: readonly string[],
  options: {
    argv1?: string;
    cwd?: string;
    execArgv?: readonly string[];
    execPath?: string;
    moduleUrl?: string;
  } = {},
): OpenClawCliInvocation {
  const execPath = options.execPath ?? process.execPath;
  const execArgv = filterOpenClawChildExecArgv(options.execArgv ?? process.execArgv);
  const entry = (options.argv1 ?? process.argv[1])?.trim();
  const cwd = options.cwd ?? tryProcessCwd();
  const entryPackageRoot = entry ? resolveOpenClawPackageRootSync({ argv1: entry }) : null;
  const packageRoot =
    entryPackageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: entry,
      cwd,
      moduleUrl: options.moduleUrl ?? import.meta.url,
    });
  const invocationCwd =
    packageRoot ?? cwd ?? (entry ? path.dirname(path.resolve(entry)) : path.dirname(execPath));
  const entryRelativePath =
    entry && entryPackageRoot
      ? path.relative(path.resolve(entryPackageRoot), path.resolve(entry))
      : null;

  if (
    entry &&
    entry !== execPath &&
    entryPackageRoot &&
    (OPENCLAW_CLI_ENTRY_BASENAMES.has(path.basename(entry)) ||
      (entryRelativePath && OPENCLAW_PACKAGE_ENTRY_PATHS.has(entryRelativePath)))
  ) {
    return {
      command: execPath,
      args: [...execArgv, entry, ...args],
      cwd: invocationCwd,
      ...(entryRelativePath === path.join("src", "entry.ts") && !isBunRuntime(execPath)
        ? { tsxConfigPath: path.join(entryPackageRoot, "tsconfig.json") }
        : {}),
    };
  }
  if (packageRoot) {
    const packageInvocation = buildPackageRootCliInvocation(packageRoot, execPath);
    return {
      command: execPath,
      args: [...packageInvocation.args, ...args],
      cwd: invocationCwd,
      ...(packageInvocation.tsxConfigPath
        ? { tsxConfigPath: packageInvocation.tsxConfigPath }
        : {}),
    };
  }
  return {
    command: execPath,
    args: [...(entry && entry !== execPath ? [entry] : []), ...args],
    cwd: invocationCwd,
  };
}
