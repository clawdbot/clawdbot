import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-utils.js";

type WindowsSpawnResolution = "direct" | "node-entrypoint" | "exe-entrypoint" | "shell-fallback";

type WindowsSpawnCandidateResolution = Exclude<WindowsSpawnResolution, "shell-fallback">;

type WindowsSpawnProgramCandidate = {
  command: string;
  leadingArgv: string[];
  resolution: WindowsSpawnCandidateResolution | "unresolved-wrapper";
  windowsHide?: boolean;
};

export type WindowsSpawnProgram = {
  command: string;
  leadingArgv: string[];
  resolution: WindowsSpawnResolution;
  shell?: boolean;
  windowsHide?: boolean;
};

export type WindowsSpawnInvocation = {
  command: string;
  argv: string[];
  resolution: WindowsSpawnResolution;
  shell?: boolean;
  windowsHide?: boolean;
};

export type ResolveWindowsSpawnProgramParams = {
  command: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  packageName?: string;
  allowShellFallback?: boolean;
};

function isFilePath(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsExecutablePath(command: string, env: NodeJS.ProcessEnv): string {
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return command;
  }

  const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const pathEntries = pathValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasExtension = path.extname(command).length > 0;
  const pathExtRaw =
    env.PATHEXT ??
    env.Pathext ??
    process.env.PATHEXT ??
    process.env.Pathext ??
    ".EXE;.CMD;.BAT;.COM";
  const pathExt = hasExtension
    ? [""]
    : pathExtRaw
        .split(";")
        .map((ext) => ext.trim())
        .filter(Boolean)
        .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

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
    return normalizeOptionalString(binField) ?? null;
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

function resolveWindowsSpawnProgramCandidate(
  params: ResolveWindowsSpawnProgramParams,
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

export function resolveWindowsSpawnProgram(
  params: ResolveWindowsSpawnProgramParams,
): WindowsSpawnProgram {
  const candidate = resolveWindowsSpawnProgramCandidate(params);
  if (candidate.resolution !== "unresolved-wrapper") {
    return {
      command: candidate.command,
      leadingArgv: candidate.leadingArgv,
      resolution: candidate.resolution,
      windowsHide: candidate.windowsHide,
    };
  }
  if (params.allowShellFallback === true) {
    return {
      command: candidate.command,
      leadingArgv: [],
      resolution: "shell-fallback",
      shell: true,
    };
  }
  throw new Error(
    `${path.basename(candidate.command)} wrapper resolved, but no executable/Node entrypoint could be resolved without shell execution.`,
  );
}

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
