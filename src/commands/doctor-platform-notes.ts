import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { MoltbotConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const execFileAsync = promisify(execFile);

function resolveHomeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export async function noteMacLaunchAgentOverrides() {
  if (process.platform !== "darwin") return;
  const markerPath = path.join(resolveHomeDir(), ".clawdbot", "disable-launchagent");
  const hasMarker = fs.existsSync(markerPath);
  if (!hasMarker) return;

  const displayMarkerPath = shortenHomePath(markerPath);
  const lines = [
    `- LaunchAgent writes are disabled via ${displayMarkerPath}.`,
    "- To restore default behavior:",
    `  rm ${displayMarkerPath}`,
  ].filter((line): line is string => Boolean(line));
  note(lines.join("\n"), "Gateway (macOS)");
}

async function launchctlGetenv(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("/bin/launchctl", ["getenv", name], { encoding: "utf8" });
    const value = String(result.stdout ?? "").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasConfigGatewayCreds(cfg: MoltbotConfig): boolean {
  const localToken =
    typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway?.auth?.token.trim() : "";
  const localPassword =
    typeof cfg.gateway?.auth?.password === "string" ? cfg.gateway?.auth?.password.trim() : "";
  const remoteToken =
    typeof cfg.gateway?.remote?.token === "string" ? cfg.gateway?.remote?.token.trim() : "";
  const remotePassword =
    typeof cfg.gateway?.remote?.password === "string" ? cfg.gateway?.remote?.password.trim() : "";
  return Boolean(localToken || localPassword || remoteToken || remotePassword);
}

export async function noteMacLaunchctlGatewayEnvOverrides(
  cfg: MoltbotConfig,
  deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
    noteFn?: typeof note;
  },
) {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "darwin") return;
  if (!hasConfigGatewayCreds(cfg)) return;

  const getenv = deps?.getenv ?? launchctlGetenv;
  const envToken = await getenv("CLAWDBOT_GATEWAY_TOKEN");
  const envPassword = await getenv("CLAWDBOT_GATEWAY_PASSWORD");
  if (!envToken && !envPassword) return;

  const lines = [
    "- launchctl environment overrides detected (can cause confusing unauthorized errors).",
    envToken ? "- `CLAWDBOT_GATEWAY_TOKEN` is set; it overrides config tokens." : undefined,
    envPassword
      ? "- `CLAWDBOT_GATEWAY_PASSWORD` is set; it overrides config passwords."
      : undefined,
    "- Clear overrides and restart the app/gateway:",
    envToken ? "  launchctl unsetenv CLAWDBOT_GATEWAY_TOKEN" : undefined,
    envPassword ? "  launchctl unsetenv CLAWDBOT_GATEWAY_PASSWORD" : undefined,
  ].filter((line): line is string => Boolean(line));

  (deps?.noteFn ?? note)(lines.join("\n"), "Gateway (macOS)");
}
