// Windows spawn helpers resolve Windows command execution details for plugin runtimes.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeStringEntries } from "../../packages/normalization-core/src/string-normalization.js";

/** Final execution strategy chosen for a Windows spawn command. */
export type WindowsSpawnResolution =
  | "direct"
  | "node-entrypoint"
  | "exe-entrypoint"
  | "shell-fallback";

/** Direct-spawn resolution before shell fallback is considered. */
export type WindowsSpawnCandidateResolution = Exclude<WindowsSpawnResolution, "shell-fallback">;

/** Direct-spawn candidate before shell fallback policy is applied. */
export type WindowsSpawnProgramCandidate = {
  /** Executable passed to child_process after wrapper resolution. */
  command: string;
  /** Arguments prepended before call-site argv, usually a resolved JS entrypoint. */
  leadingArgv: string[];
  /** Candidate resolution path, or unresolved-wrapper when shell policy must decide. */
  resolution: WindowsSpawnCandidateResolution | "unresolved-wrapper";
  /** Hide the transient Windows console for Node/exe entrypoint launches. */
  windowsHide?: boolean;
};

/** Spawn program after Windows wrapper resolution and fallback policy. */
export type WindowsSpawnProgram = {
  command: string;
  leadingArgv: string[];
  resolution: WindowsSpawnResolution;
  shell?: boolean;
  windowsHide?: boolean;
};

/** Fully materialized child_process invocation for a resolved Windows spawn program. */
export type WindowsSpawnInvocation = {
  command: string;
  argv: string[];
  resolution: WindowsSpawnResolution;
  shell?: boolean;
  windowsHide?: boolean;
};

/** Inputs used to resolve a command into a Windows-safe direct spawn program. */
export type ResolveWindowsSpawnProgramParams = {
  command: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  packageName?: string;
  /** Trusted compatibility escape hatch for callers that intentionally accept shell-mediated wrapper execution. */
  allowShellFallback?: boolean;
};
/** Inputs for candidate resolution that intentionally excludes shell fallback policy. */
export type ResolveWindowsSpawnProgramCandidateParams = Omit<
  ResolveWindowsSpawnProgramParams,
  "allowShellFallback"
>;
/** Parsed executable plus inline arguments from a command string. */
export type WindowsSpawnCommandInlineArgs = {
  executable: string;
  arguments: string;
};

const INLINE_ARGUMENT_EXECUTABLES = new Set([
  "node",
  "node.exe",
  "npm",
  "npm.cmd",
  "npm.exe",
  "npx",
  "npx.cmd",
  "npx.exe",
  "pnpm",
  "pnpm.cmd",
  "pnpm.exe",
  "yarn",
  "yarn.cmd",
  "yarn.exe",
]);

function isFilePath(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function readCommandToken(command: string): { token: string; rest: string } | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('"')) {
    const closeIndex = trimmed.indexOf('"', 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      token: trimmed.slice(1, closeIndex),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }
  const match = trimmed.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  return {
    token: match[1] ?? "",
    rest: (match[2] ?? "").trim(),
  };
}

/** Detect command strings like `node script.js` that should be split before spawn. */
export function detectWindowsSpawnCommandInlineArgs(
  command: string,
): WindowsSpawnCommandInlineArgs | null {
  const parsed = readCommandToken(command);
  if (!parsed?.rest) {
    return null;
  }
  const normalizedToken = parsed.token.replace(/\\/g, "/");
  const executable = normalizeLowercaseStringOrEmpty(path.posix.basename(normalizedToken));
  if (!INLINE_ARGUMENT_EXECUTABLES.has(executable)) {
    return null;
  }
  return {
    executable: parsed.token,
    arguments: parsed.rest,
  };
}

/** Resolve a Windows command name through PATH and PATHEXT so wrapper inspection sees the real file. */
export function resolveWindowsExecutablePath(command: string, env: NodeJS.ProcessEnv): string {
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return command;
  }

  const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const pathEntries = normalizeStringEntries(pathValue.split(";"));
  const hasExtension = path.extname(command).length > 0;
  const pathExtRaw =
    env.PATHEXT ??
    env.Pathext ??
    process.env.PATHEXT ??
    process.env.Pathext ??
    ".EXE;.CMD;.BAT;.COM";
  const pathExt = hasExtension
    ? [""]
    : normalizeStringEntries(pathExtRaw.split(";")).map((ext) =>
        ext.startsWith(".") ? ext : `.${ext}`,
      );

  for (const dir of pathEntries) {
    for (const ext of pathExt) {
      const normalizedExt = normalizeLowercaseStringOrEmpty(ext);
      const uppercaseExt = ext.toUpperCase();
      for (const candidateExt of [ext, normalizedExt, uppercaseExt]) {
        const candidate = path.join(dir, `${command}${candidateExt}`);
        if (isFilePath(candidate)) {
          return candidate;
        }
      }
    }
  }

  return command;
}

function resolveEntrypointFromCmdShim(wrapperPath: string): string | null {
  if (!isFilePath(wrapperPath)) {
    return null;
  }

  try {
    const content = readFileSync(wrapperPath, "utf8");
    const normalizedContent = content.replaceAll("\r\n", "\n").toLowerCase();
    const significantLines = content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const isNpmCmdShim =
      normalizedContent.includes("\ngoto start\n") &&
      normalizedContent.includes("\n:find_dp0\n") &&
      normalizedContent.includes("set dp0=%~dp0") &&
      normalizedContent.includes("call :find_dp0");
    const isDirectForwarder =
      significantLines.length === 2 &&
      /^@echo off$/iu.test(significantLines[0] ?? "") &&
      /^"%~?dp0%?[\\/][^"\r\n]+"\s+%\*$/iu.test(significantLines[1] ?? "");
    const isPnpmCmdShim =
      normalizedContent.includes("@setlocal") &&
      significantLines.some((line) => /^@?if\s+/i.test(line)) &&
      content.includes("%~dp0") &&
      significantLines.some(
        (line) =>
          /"\s*%~?dp0%?[\/\\][^"]+\.(exe|cmd|bat|js|mjs|cjs)"/i.test(line) ||
          /node\s+".*%~?dp0.*"/i.test(line),
      );
    // Only known direct-forwarder shapes are safe to bypass; arbitrary batch
    // wrappers can depend on setup commands before dispatching their target.
    if (!isNpmCmdShim && !isDirectForwarder && !isPnpmCmdShim) {
      return null;
    }
    const candidates: string[] = [];
    for (const match of content.matchAll(/"([^"\r\n]*)"/g)) {
      const token = match[1] ?? "";
      const relMatch = token.match(/%~?dp0%?\s*[\\/]*(.*)$/i);
      const relative = relMatch?.[1]?.trim();
      if (!relative) {
        continue;
      }
      const normalizedRelative = relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, "");
      const candidate = path.resolve(path.dirname(wrapperPath), normalizedRelative);
      if (isFilePath(candidate)) {
        candidates.push(candidate);
      }
    }
    const nonNode = candidates.find((candidate) => {
      const base = normalizeLowercaseStringOrEmpty(path.basename(candidate));
      return base !== "node.exe" && base !== "node";
    });
    if (isDirectForwarder && nonNode) {
      const ext = normalizeLowercaseStringOrEmpty(path.extname(nonNode));
      if (ext !== ".exe" && ext !== ".js" && ext !== ".cjs" && ext !== ".mjs") {
        return null;
      }
    }
    return nonNode ?? null;
  } catch {
    return null;
  }
}

function resolveBinEntry(
  packageName: string | undefined,
  binField: string | Record<string, string> | undefined,
): string | null {
  if (typeof binField === "string") {
    const trimmed = normalizeOptionalString(binField);
    return trimmed || null;
  }
  if (!binField || typeof binField !== "object") {
    return null;
  }

  if (packageName) {
    const preferred = binField[packageName];
    const normalizedPreferred =
      typeof preferred === "string" ? normalizeOptionalString(preferred) : undefined;
    if (normalizedPreferred) {
      return normalizedPreferred;
    }
  }

  for (const value of Object.values(binField)) {
    const normalizedValue = typeof value === "string" ? normalizeOptionalString(value) : undefined;
    if (normalizedValue) {
      return normalizedValue;
    }
  }
  return null;
}

function resolveEntrypointFromPackageJson(
  wrapperPath: string,
  packageName?: string,
): string | null {
  if (!packageName) {
    return null;
  }

  const wrapperDir = path.dirname(wrapperPath);
  const packageDirs = [
    path.resolve(wrapperDir, "..", packageName),
    path.resolve(wrapperDir, "node_modules", packageName),
  ];

  for (const packageDir of packageDirs) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!isFilePath(packageJsonPath)) {
      continue;
    }
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const entryRel = resolveBinEntry(packageName, packageJson.bin);
      if (!entryRel) {
        continue;
      }
      const entryPath = path.resolve(packageDir, entryRel);
      if (isFilePath(entryPath)) {
        return entryPath;
      }
    } catch {
      // Ignore malformed package metadata.
    }
  }

  return null;
}

/** Resolve the safest direct spawn candidate for Windows wrappers, scripts, and binaries. */
export function resolveWindowsSpawnProgramCandidate(
  params: ResolveWindowsSpawnProgramCandidateParams,
): WindowsSpawnProgramCandidate {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const execPath = params.execPath ?? process.execPath;

  if (platform !== "win32") {
    return {
      command: params.command,
      leadingArgv: [],
      resolution: "direct",
    };
  }
  const inlineArgs = detectWindowsSpawnCommandInlineArgs(params.command);
  if (inlineArgs) {
    throw new Error(
      `Windows spawn command must be an executable path only; "${inlineArgs.executable}" was configured with inline arguments "${inlineArgs.arguments}". Put arguments in the caller's args array instead.`,
    );
  }

  const resolvedCommand = resolveWindowsExecutablePath(params.command, env);
  const ext = normalizeLowercaseStringOrEmpty(path.extname(resolvedCommand));
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    return {
      command: execPath,
      leadingArgv: [resolvedCommand],
      resolution: "node-entrypoint",
      windowsHide: true,
    };
  }

  if (ext === ".cmd" || ext === ".bat") {
    const entrypoint =
      resolveEntrypointFromCmdShim(resolvedCommand) ??
      resolveEntrypointFromPackageJson(resolvedCommand, params.packageName);
    if (entrypoint) {
      const entryExt = normalizeLowercaseStringOrEmpty(path.extname(entrypoint));
      if (entryExt === ".exe") {
        return {
          command: entrypoint,
          leadingArgv: [],
          resolution: "exe-entrypoint",
          windowsHide: true,
        };
      }
      return {
        command: execPath,
        leadingArgv: [entrypoint],
        resolution: "node-entrypoint",
        windowsHide: true,
      };
    }

    // Unresolved .cmd/.bat wrappers are not passed through cmd.exe unless the
    // caller explicitly accepts shell metacharacter parsing with allowShellFallback.
    return {
      command: resolvedCommand,
      leadingArgv: [],
      resolution: "unresolved-wrapper",
    };
  }

  return {
    command: resolvedCommand,
    leadingArgv: [],
    resolution: "direct",
  };
}

/** Apply shell-fallback policy when Windows wrapper resolution could not find a direct entrypoint. */
export function applyWindowsSpawnProgramPolicy(params: {
  candidate: WindowsSpawnProgramCandidate;
  allowShellFallback?: boolean;
}): WindowsSpawnProgram {
  if (params.candidate.resolution !== "unresolved-wrapper") {
    return {
      command: params.candidate.command,
      leadingArgv: params.candidate.leadingArgv,
      resolution: params.candidate.resolution,
      windowsHide: params.candidate.windowsHide,
    };
  }
  if (params.allowShellFallback === true) {
    return {
      command: params.candidate.command,
      leadingArgv: [],
      resolution: "shell-fallback",
      shell: true,
    };
  }
  throw new Error(
    `${path.basename(params.candidate.command)} wrapper resolved, but no executable/Node entrypoint could be resolved without shell execution.`,
  );
}

/** Resolve the final Windows spawn program after candidate discovery and fallback policy. */
export function resolveWindowsSpawnProgram(
  params: ResolveWindowsSpawnProgramParams,
): WindowsSpawnProgram {
  const candidate = resolveWindowsSpawnProgramCandidate(params);
  return applyWindowsSpawnProgramPolicy({
    candidate,
    allowShellFallback: params.allowShellFallback,
  });
}

/** Combine a resolved Windows spawn program with call-site argv for actual process launch. */
export function materializeWindowsSpawnProgram(
  program: WindowsSpawnProgram,
  argv: string[],
): WindowsSpawnInvocation {
  return {
    command: program.command,
    argv: [...program.leadingArgv, ...argv],
    resolution: program.resolution,
    shell: program.shell,
    windowsHide: program.windowsHide,
  };
}
