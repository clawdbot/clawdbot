/** Reads and renders macOS LaunchAgent plists for gateway service installs. */
import fs from "node:fs/promises";
import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";

// launchd defaults to a 10s spawn throttle. Keep that default explicitly so
// crash loops back off instead of respawning every second while still allowing
// explicit kickstart restarts to take effect.
export const LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS = 10;
export const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 20;
// launchd stores plist integer values in decimal; 0o077 renders as 63 (owner-only files).
export const LAUNCH_AGENT_UMASK_DECIMAL = 0o077;
export const LAUNCH_AGENT_PROCESS_TYPE = "Interactive";
export const LAUNCH_AGENT_STDIN_PATH = "/dev/null";

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

type ReadLaunchAgentProgramArgumentsOptions = {
  expectedEnvironmentWrapperPath?: string;
  expectedEnvironmentFilePath?: string;
  generatedEnvironmentLabel?: string;
};

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

function isGeneratedEnvWrapperArgs(
  programArguments: string[],
  options?: ReadLaunchAgentProgramArgumentsOptions,
): boolean {
  const wrapperPath = programArguments[0];
  const envFilePath = programArguments[1];
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

async function readLaunchAgentEnvironmentFile(
  programArguments: string[],
  options?: ReadLaunchAgentProgramArgumentsOptions,
): Promise<Record<string, string>> {
  const envFilePath = programArguments[1];
  if (!isGeneratedEnvWrapperArgs(programArguments, options) || !envFilePath) {
    return {};
  }
  let content = "";
  const candidateEnvFilePaths = Array.from(
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
    } catch {
      // Keep trying; mangled wrapper args may still have the canonical env file.
    }
  }
  if (!content) {
    return {};
  }
  const environment: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) {
      continue;
    }
    environment[key] = parseGeneratedEnvValue(value);
  }
  return environment;
}

function unwrapGeneratedEnvWrapperArgs(
  programArguments: string[],
  options?: ReadLaunchAgentProgramArgumentsOptions,
): string[] {
  if (!isGeneratedEnvWrapperArgs(programArguments, options)) {
    return programArguments;
  }
  return programArguments.slice(2);
}

const renderEnvDict = (env: Record<string, string | undefined> | undefined): string => {
  if (!env) {
    return "";
  }
  const entries = Object.entries(env).filter(
    ([, value]) => typeof value === "string" && value.trim(),
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

export async function readLaunchAgentProgramArgumentsFromFile(plistPath: string): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
  sourcePath?: string;
} | null>;
export async function readLaunchAgentProgramArgumentsFromFile(
  plistPath: string,
  options: ReadLaunchAgentProgramArgumentsOptions,
): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
  sourcePath?: string;
} | null>;
export async function readLaunchAgentProgramArgumentsFromFile(
  plistPath: string,
  options?: ReadLaunchAgentProgramArgumentsOptions,
): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
  sourcePath?: string;
} | null> {
  try {
    const plist = await fs.readFile(plistPath, "utf8");
    const programMatch = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i);
    if (!programMatch) {
      return null;
    }
    const args = Array.from(programMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/gi)).map(
      (match) => plistUnescape(match[1] ?? "").trim(),
    );
    const workingDirMatch = plist.match(
      /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/i,
    );
    const workingDirectory = workingDirMatch ? plistUnescape(workingDirMatch[1] ?? "").trim() : "";
    const envMatch = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/i);
    const inlineEnvironment: Record<string, string> = {};
    if (envMatch) {
      for (const pair of envMatch[1].matchAll(
        /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gi,
      )) {
        const key = plistUnescape(pair[1] ?? "").trim();
        if (!key) {
          continue;
        }
        const value = plistUnescape(pair[2] ?? "").trim();
        inlineEnvironment[key] = value;
      }
    }
    const fileEnvironment = await readLaunchAgentEnvironmentFile(args, options);
    const effectiveProgramArguments = unwrapGeneratedEnvWrapperArgs(args, options);
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
      programArguments: effectiveProgramArguments.filter(Boolean),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      ...(Object.keys(environmentValueSources).length > 0 ? { environmentValueSources } : {}),
      sourcePath: plistPath,
    };
  } catch {
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
