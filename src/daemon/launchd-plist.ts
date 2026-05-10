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

function parseGeneratedEnvValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) {
    return trimmed;
  }
  return trimmed.slice(1, -1).replaceAll("'\\''", "'");
}

async function readLaunchAgentEnvironmentFile(
  programArguments: string[],
): Promise<Record<string, string>> {
  const envFilePath = programArguments[1];
  if (!programArguments[0]?.endsWith("-env-wrapper.sh") || !envFilePath) {
    return {};
  }
  let content = "";
  try {
    content = await fs.readFile(envFilePath, "utf8");
  } catch {
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

function unwrapGeneratedEnvWrapperArgs(programArguments: string[]): string[] {
  if (!programArguments[0]?.endsWith("-env-wrapper.sh") || !programArguments[1]) {
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
    const fileEnvironment = await readLaunchAgentEnvironmentFile(args);
    const effectiveProgramArguments = unwrapGeneratedEnvWrapperArgs(args);
    const environment = { ...inlineEnvironment, ...fileEnvironment };
    const environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource> = {};
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
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${plistEscape(label)}</string>\n    ${commentXml}\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n    <key>ExitTimeOut</key>\n    <integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}</integer>\n    <key>ProcessType</key>\n    <string>${LAUNCH_AGENT_PROCESS_TYPE}</string>\n    <key>ThrottleInterval</key>\n    <integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>\n    <key>Umask</key>\n    <integer>${LAUNCH_AGENT_UMASK_DECIMAL}</integer>\n    <key>ProgramArguments</key>\n    <array>${argsXml}\n    </array>\n    ${workingDirXml}\n    <key>StandardOutPath</key>\n    <string>${plistEscape(stdoutPath)}</string>\n    <key>StandardErrorPath</key>\n    <string>${plistEscape(stderrPath)}</string>${envXml}\n  </dict>\n</plist>\n`;
}
