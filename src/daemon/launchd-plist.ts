/** Reads and renders macOS LaunchAgent plists for gateway service installs. */
import fs from "node:fs/promises";
import { asOptionalRecord, isStringRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { runExec } from "../process/exec.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceCommandSnapshot,
  GatewayServiceEnvironmentValueSource,
  GatewayServiceReadOptions,
} from "./service-types.js";

// launchd defaults to a 10s spawn throttle. Keep that default explicitly so
// crash loops back off instead of respawning every second while still allowing
// explicit kickstart restarts to take effect.
const LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS = 10;
export const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 20;
// launchd stores plist integer values in decimal; 0o077 renders as 63 (owner-only files).
const LAUNCH_AGENT_UMASK_DECIMAL = 0o077;
const LAUNCH_AGENT_PROCESS_TYPE = "Interactive";
const LAUNCH_AGENT_STDIN_PATH = "/dev/null";
export const LAUNCH_AGENT_ENV_WRAPPER_SHELL = "/bin/sh";

const plistEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const plistUnescape = (value: string): string =>
  value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");

export function parseLaunchdPlistLabel(contents: string): string | null {
  const match = contents.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/i);
  const rawLabel = match?.at(1);
  return rawLabel === undefined ? null : plistUnescape(rawLabel).trim() || null;
}

type ReadLaunchAgentProgramArgumentsOptions = GatewayServiceReadOptions & {
  expectedEnvironmentWrapperPath?: string;
  expectedEnvironmentFilePath?: string;
  generatedEnvironmentLabel?: string;
};

export function quoteLaunchAgentEnvironmentValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseGeneratedEnvValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) {
    return trimmed;
  }
  return trimmed.slice(1, -1).replaceAll("'\\''", "'");
}

function includesGeneratedEnvironmentPathToken(value: string | undefined, token: string): boolean {
  return Boolean(value?.replaceAll("\\", "/").includes(token));
}

function includesGeneratedEnvironmentDirToken(value: string | undefined): boolean {
  return Boolean(value?.replaceAll("\\", "/").includes("/service-env/"));
}

function resolveSiblingGeneratedEnvFilePath(
  envFilePath: string,
  options?: ReadLaunchAgentProgramArgumentsOptions,
): string | undefined {
  const label = options?.generatedEnvironmentLabel?.trim();
  if (!label) {
    return undefined;
  }
  const serviceEnvMarker = "/service-env/";
  const markerIndex = envFilePath.replaceAll("\\", "/").lastIndexOf(serviceEnvMarker);
  if (markerIndex < 0) {
    return undefined;
  }
  // Custom state dirs can also contain service-env; use the generated env dir closest to the file.
  const serviceEnvDirEnd = markerIndex + serviceEnvMarker.length - 1;
  return `${envFilePath.slice(0, serviceEnvDirEnd)}/${label}.env`;
}

function isExpectedGeneratedEnvWrapperPair(
  wrapperPath: string | undefined,
  envFilePath: string | undefined,
  options?: ReadLaunchAgentProgramArgumentsOptions,
): boolean {
  if (!wrapperPath || !envFilePath) {
    return false;
  }
  if (!options) {
    return wrapperPath.endsWith("-env-wrapper.sh");
  }
  if (
    options.expectedEnvironmentWrapperPath &&
    options.expectedEnvironmentFilePath &&
    wrapperPath === options.expectedEnvironmentWrapperPath &&
    envFilePath === options.expectedEnvironmentFilePath
  ) {
    return true;
  }
  const label = options.generatedEnvironmentLabel?.trim();
  if (!label) {
    return false;
  }
  // Legacy/corrupted plists may preserve the label-derived wrapper name inside
  // a mangled service-env path. Still unwrap it so the next rewrite can repair.
  return (
    includesGeneratedEnvironmentDirToken(wrapperPath) &&
    includesGeneratedEnvironmentDirToken(envFilePath) &&
    includesGeneratedEnvironmentPathToken(wrapperPath, `${label}-env-wrapper.sh`) &&
    includesGeneratedEnvironmentPathToken(envFilePath, `${label}.env`)
  );
}

function resolveGeneratedEnvWrapperLayout(
  programArguments: string[],
  options?: ReadLaunchAgentProgramArgumentsOptions,
): { envFilePath: string; commandStartIndex: number } | null {
  if (programArguments[0] === LAUNCH_AGENT_ENV_WRAPPER_SHELL) {
    const wrapperPath = programArguments[1];
    const envFilePath = programArguments[2];
    if (isExpectedGeneratedEnvWrapperPair(wrapperPath, envFilePath, options) && envFilePath) {
      return { envFilePath, commandStartIndex: 3 };
    }
  }
  const wrapperPath = programArguments[0];
  const envFilePath = programArguments[1];
  if (isExpectedGeneratedEnvWrapperPair(wrapperPath, envFilePath, options) && envFilePath) {
    return { envFilePath, commandStartIndex: 2 };
  }
  return null;
}

async function readLaunchAgentEnvironmentFile(
  programArguments: string[],
  options?: ReadLaunchAgentProgramArgumentsOptions,
): Promise<Record<string, string>> {
  const layout = resolveGeneratedEnvWrapperLayout(programArguments, options);
  if (!layout) {
    return {};
  }
  const envFilePath = layout.envFilePath;
  let content = "";
  const candidateEnvFilePaths = options?.requireEffective
    ? [envFilePath]
    : Array.from(
        new Set(
          [
            envFilePath,
            resolveSiblingGeneratedEnvFilePath(envFilePath, options),
            options?.expectedEnvironmentFilePath,
          ].filter((candidate): candidate is string => Boolean(candidate)),
        ),
      );
  // Corrupted wrapper args can still point near the generated env dir. Try the
  // sibling canonical env file before giving up so repair rewrites retain env.
  for (const candidate of candidateEnvFilePaths) {
    try {
      content = await fs.readFile(candidate, "utf8");
      break;
    } catch (error) {
      if (options?.requireEffective) {
        throw error;
      }
      // Keep trying; mangled wrapper args may still have the canonical env file.
    }
  }
  if (!content) {
    return {};
  }
  const environment: Record<string, string> = {};
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] ?? "";
    const line = options?.requireEffective ? rawLine.trimStart() : rawLine.trim();
    if (!line.trim() || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
    if (!match) {
      if (options?.requireEffective) {
        throw new Error("Unsupported LaunchAgent environment syntax");
      }
      continue;
    }
    const key = match[1];
    let value = match[2];
    if (!key || value === undefined) {
      continue;
    }
    let parsedValue = parseGeneratedEnvValue(value);
    if (options?.requireEffective) {
      // The writer's quoted literals can span physical lines; retain their exact newline bytes.
      while (
        quoteLaunchAgentEnvironmentValue(parsedValue) !== value.trim() &&
        index + 1 < lines.length
      ) {
        value += `\n${lines[++index]}`;
        parsedValue = parseGeneratedEnvValue(value);
      }
      // Strict inspection accepts the writer's literal syntax, never shell expressions.
      if (quoteLaunchAgentEnvironmentValue(parsedValue) !== value.trim()) {
        throw new Error("Unsupported LaunchAgent environment value");
      }
    }
    environment[key] = parsedValue;
  }
  return environment;
}

function unwrapGeneratedEnvWrapperArgs(
  programArguments: string[],
  options?: ReadLaunchAgentProgramArgumentsOptions,
): string[] {
  const layout = resolveGeneratedEnvWrapperLayout(programArguments, options);
  if (!layout) {
    return programArguments;
  }
  return programArguments.slice(layout.commandStartIndex);
}

const renderEnvDict = (env: Record<string, string | undefined> | undefined): string => {
  if (!env) {
    return "";
  }
  // An explicit empty NODE_OPTIONS blocks inherited supervisor preload/heap flags.
  const entries = Object.entries(env).filter(
    ([key, value]) => typeof value === "string" && (value.trim() || key === "NODE_OPTIONS"),
  );
  if (entries.length === 0) {
    return "";
  }
  const items = entries
    .map(
      ([key, value]) =>
        `\n    <key>${plistEscape(key)}</key>\n    <string>${plistEscape(value?.trim() ?? "")}</string>`,
    )
    .join("");
  return `\n    <key>EnvironmentVariables</key>\n    <dict>${items}\n    </dict>`;
};

async function decodeLaunchAgentPlist(
  contents: Uint8Array,
  timeoutMs?: number,
): Promise<GatewayServiceCommandSnapshot> {
  // Decode the captured bytes, not a second path read: native parsing must validate
  // the complete definition whose command and environment we report.
  const { stdout } = await runExec("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    input: contents,
    timeoutMs: Math.min(timeoutMs ?? 5_000, 5_000),
    maxBuffer: 1024 * 1024,
    logOutput: false,
  });
  const plist = asOptionalRecord(JSON.parse(stdout));
  const programArguments = plist?.ProgramArguments;
  const workingDirectory = plist?.WorkingDirectory;
  const environment = plist?.EnvironmentVariables;
  if (
    !Array.isArray(programArguments) ||
    !programArguments.every((arg): arg is string => typeof arg === "string") ||
    (workingDirectory !== undefined && typeof workingDirectory !== "string") ||
    (environment !== undefined && !isStringRecord(environment))
  ) {
    throw new Error("Invalid LaunchAgent command fields");
  }
  return { programArguments, workingDirectory, environment };
}

export async function readLaunchAgentProgramArgumentsFromFile(
  plistPath: string,
  options?: ReadLaunchAgentProgramArgumentsOptions,
): Promise<GatewayServiceCommandConfig | null> {
  try {
    const plist = await fs.readFile(plistPath).catch(async (error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        if (options?.requireEffective) {
          const absent = await fs.lstat(plistPath).then(
            () => false,
            (statError: unknown) => hasErrnoCode(statError, "ENOENT"),
          );
          if (!absent) {
            throw new Error("Unreadable LaunchAgent definition");
          }
        }
        return null;
      }
      throw error;
    });
    if (plist === null) {
      return null;
    }
    const {
      programArguments: args,
      workingDirectory,
      environment: inlineEnvironment = {},
    } = await decodeLaunchAgentPlist(plist, options?.timeoutMs);
    const fileEnvironment = await readLaunchAgentEnvironmentFile(args, options);
    const effectiveProgramArguments = unwrapGeneratedEnvWrapperArgs(args, options);
    if (options?.requireEffective && !effectiveProgramArguments[0]) {
      throw new Error("Missing LaunchAgent command");
    }
    const environment = { ...inlineEnvironment, ...fileEnvironment };
    const environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource> = {};
    // Track source provenance so repair flows can tell inline plist env from the
    // generated env file and preserve both when they overlap.
    for (const key of Object.keys(inlineEnvironment)) {
      environmentValueSources[key] = Object.hasOwn(fileEnvironment, key)
        ? "inline-and-file"
        : "inline";
    }
    for (const key of Object.keys(fileEnvironment)) {
      environmentValueSources[key] = Object.hasOwn(inlineEnvironment, key)
        ? "inline-and-file"
        : "file";
    }
    return {
      programArguments: effectiveProgramArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      ...(Object.keys(environmentValueSources).length > 0 ? { environmentValueSources } : {}),
      sourcePath: plistPath,
    };
  } catch {
    if (options?.requireEffective) {
      throw new Error("Effective LaunchAgent service command could not be inspected.");
    }
    return null;
  }
}

export function buildLaunchAgentPlist({
  label,
  comment,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment,
}: {
  label: string;
  comment?: string;
  programArguments: string[];
  workingDirectory?: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string | undefined>;
}): string {
  const argsXml = programArguments
    .map((arg) => `\n      <string>${plistEscape(arg)}</string>`)
    .join("");
  const workingDirXml = workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${plistEscape(workingDirectory)}</string>`
    : "";
  const commentXml = comment?.trim()
    ? `\n    <key>Comment</key>\n    <string>${plistEscape(comment.trim())}</string>`
    : "";
  const envXml = renderEnvDict(environment);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${plistEscape(label)}</string>\n    ${commentXml}\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n    <key>ExitTimeOut</key>\n    <integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}</integer>\n    <key>ProcessType</key>\n    <string>${LAUNCH_AGENT_PROCESS_TYPE}</string>\n    <key>ThrottleInterval</key>\n    <integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>\n    <key>Umask</key>\n    <integer>${LAUNCH_AGENT_UMASK_DECIMAL}</integer>\n    <key>ProgramArguments</key>\n    <array>${argsXml}\n    </array>\n    ${workingDirXml}\n    <key>StandardInPath</key>\n    <string>${plistEscape(LAUNCH_AGENT_STDIN_PATH)}</string>\n    <key>StandardOutPath</key>\n    <string>${plistEscape(stdoutPath)}</string>\n    <key>StandardErrorPath</key>\n    <string>${plistEscape(stderrPath)}</string>${envXml}\n  </dict>\n</plist>\n`;
}
