import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";

import { cancel, isCancel } from "@clack/prompts";

import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import type { ClawdbotConfig } from "../config/config.js";
import { CONFIG_PATH_CLAWDBOT } from "../config/config.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { VERSION } from "../version.js";
import type { NodeManagerChoice, ResetScope } from "./onboard-types.js";

export function guardCancel<T>(value: T, runtime: RuntimeEnv): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    runtime.exit(0);
  }
  return value;
}

export function summarizeExistingConfig(config: ClawdbotConfig): string {
  const rows: string[] = [];
  if (config.agent?.workspace)
    rows.push(`workspace: ${config.agent.workspace}`);
  if (config.agent?.model) {
    const model =
      typeof config.agent.model === "string"
        ? config.agent.model
        : config.agent.model.primary;
    if (model) rows.push(`model: ${model}`);
  }
  if (config.gateway?.mode) rows.push(`gateway.mode: ${config.gateway.mode}`);
  if (typeof config.gateway?.port === "number") {
    rows.push(`gateway.port: ${config.gateway.port}`);
  }
  if (config.gateway?.bind) rows.push(`gateway.bind: ${config.gateway.bind}`);
  if (config.gateway?.remote?.url) {
    rows.push(`gateway.remote.url: ${config.gateway.remote.url}`);
  }
  if (config.skills?.install?.nodeManager) {
    rows.push(`skills.nodeManager: ${config.skills.install.nodeManager}`);
  }
  return rows.length ? rows.join("\n") : "No key settings detected.";
}

export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function printWizardHeader(runtime: RuntimeEnv) {
  const header = [
    "░████░█░░░░░█████░█░░░█░███░░████░░████░░▀█▀",
    "█░░░░░█░░░░░█░░░█░█░█░█░█░░█░█░░░█░█░░░█░░█░",
    "█░░░░░█░░░░░█████░█░█░█░█░░█░████░░█░░░█░░█░",
    "█░░░░░█░░░░░█░░░█░█░█░█░█░░█░█░░█░░█░░░█░░█░",
    "░████░█████░█░░░█░░█░█░░███░░████░░░███░░░█░",
    "              🦞 FRESH DAILY 🦞",
  ].join("\n");
  runtime.log(header);
}

export function applyWizardMetadata(
  cfg: ClawdbotConfig,
  params: { command: string; mode: "local" | "remote" },
): ClawdbotConfig {
  const commit =
    process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim() || undefined;
  return {
    ...cfg,
    wizard: {
      ...cfg.wizard,
      lastRunAt: new Date().toISOString(),
      lastRunVersion: VERSION,
      lastRunCommit: commit,
      lastRunCommand: params.command,
      lastRunMode: params.mode,
    },
  };
}

type BrowserOpenSupport = {
  ok: boolean;
  reason?: string;
  command?: string;
};

let wslCached: boolean | null = null;

async function isWSL(): Promise<boolean> {
  if (wslCached !== null) return wslCached;
  if (process.platform !== "linux") {
    wslCached = false;
    return wslCached;
  }
  if (
    process.env.WSL_INTEROP ||
    process.env.WSL_DISTRO_NAME ||
    process.env.WSLENV
  ) {
    wslCached = true;
    return wslCached;
  }
  try {
    const release = (await fs.readFile("/proc/version", "utf8")).toLowerCase();
    wslCached = release.includes("microsoft") || release.includes("wsl");
  } catch {
    wslCached = false;
  }
  return wslCached;
}

type BrowserOpenCommand = {
  argv: string[] | null;
  reason?: string;
  command?: string;
};

async function resolveBrowserOpenCommand(): Promise<BrowserOpenCommand> {
  const platform = process.platform;
  const hasDisplay = Boolean(
    process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
  );
  const isSsh =
    Boolean(process.env.SSH_CLIENT) ||
    Boolean(process.env.SSH_TTY) ||
    Boolean(process.env.SSH_CONNECTION);

  if (isSsh && !hasDisplay && platform !== "win32") {
    return { argv: null, reason: "ssh-no-display" };
  }

  if (platform === "win32") {
    return { argv: ["cmd", "/c", "start", ""], command: "cmd" };
  }

  if (platform === "darwin") {
    const hasOpen = await detectBinary("open");
    return hasOpen
      ? { argv: ["open"], command: "open" }
      : { argv: null, reason: "missing-open" };
  }

  if (platform === "linux") {
    const wsl = await isWSL();
    if (!hasDisplay && !wsl) {
      return { argv: null, reason: "no-display" };
    }
    if (wsl) {
      const hasWslview = await detectBinary("wslview");
      if (hasWslview) return { argv: ["wslview"], command: "wslview" };
      if (!hasDisplay) return { argv: null, reason: "wsl-no-wslview" };
    }
    const hasXdgOpen = await detectBinary("xdg-open");
    return hasXdgOpen
      ? { argv: ["xdg-open"], command: "xdg-open" }
      : { argv: null, reason: "missing-xdg-open" };
  }

  return { argv: null, reason: "unsupported-platform" };
}

export async function detectBrowserOpenSupport(): Promise<BrowserOpenSupport> {
  const resolved = await resolveBrowserOpenCommand();
  if (!resolved.argv) return { ok: false, reason: resolved.reason };
  return { ok: true, command: resolved.command };
}

export function formatControlUiSshHint(params: {
  port: number;
  basePath?: string;
  token?: string;
}): string {
  const basePath = normalizeControlUiBasePath(params.basePath);
  const uiPath = basePath ? `${basePath}/` : "/";
  const localUrl = `http://localhost:${params.port}${uiPath}`;
  const tokenParam = params.token
    ? `?token=${encodeURIComponent(params.token)}`
    : "";
  const authedUrl = params.token ? `${localUrl}${tokenParam}` : undefined;
  const sshTarget = resolveSshTargetHint();
  return [
    "No GUI detected. Open from your computer:",
    `ssh -N -L ${params.port}:127.0.0.1:${params.port} ${sshTarget}`,
    "Then open:",
    localUrl,
    authedUrl,
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveSshTargetHint(): string {
  const user = process.env.USER || process.env.LOGNAME || "user";
  const conn = process.env.SSH_CONNECTION?.trim().split(/\s+/);
  const host = conn?.[2] ?? "<host>";
  return `${user}@${host}`;
}

export async function openUrl(url: string): Promise<boolean> {
  const resolved = await resolveBrowserOpenCommand();
  if (!resolved.argv) return false;
  const command = [...resolved.argv, url];
  try {
    await runCommandWithTimeout(command, { timeoutMs: 5_000 });
    return true;
  } catch {
    // ignore; we still print the URL for manual open
    return false;
  }
}

export async function ensureWorkspaceAndSessions(
  workspaceDir: string,
  runtime: RuntimeEnv,
) {
  const ws = await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: true,
  });
  runtime.log(`Workspace OK: ${ws.dir}`);
  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${sessionsDir}`);
}

export function resolveNodeManagerOptions(): Array<{
  value: NodeManagerChoice;
  label: string;
}> {
  return [
    { value: "npm", label: "npm" },
    { value: "pnpm", label: "pnpm" },
    { value: "bun", label: "bun" },
  ];
}

export async function moveToTrash(
  pathname: string,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!pathname) return;
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await runCommandWithTimeout(["trash", pathname], { timeoutMs: 5000 });
    runtime.log(`Moved to Trash: ${pathname}`);
  } catch {
    runtime.log(`Failed to move to Trash (manual delete): ${pathname}`);
  }
}

export async function handleReset(
  scope: ResetScope,
  workspaceDir: string,
  runtime: RuntimeEnv,
) {
  await moveToTrash(CONFIG_PATH_CLAWDBOT, runtime);
  if (scope === "config") return;
  await moveToTrash(path.join(CONFIG_DIR, "credentials"), runtime);
  await moveToTrash(resolveSessionTranscriptsDir(), runtime);
  if (scope === "full") {
    await moveToTrash(workspaceDir, runtime);
  }
}

export async function detectBinary(name: string): Promise<boolean> {
  if (!name?.trim()) return false;
  const resolved = name.startsWith("~") ? resolveUserPath(name) : name;
  if (path.isAbsolute(resolved) || resolved.startsWith(".")) {
    try {
      await fs.access(resolved);
      return true;
    } catch {
      return false;
    }
  }

  const command =
    process.platform === "win32"
      ? ["where", name]
      : ["/usr/bin/env", "sh", "-lc", `command -v ${name}`];
  try {
    const result = await runCommandWithTimeout(command, { timeoutMs: 2000 });
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function probeGatewayReachable(params: {
  url: string;
  token?: string;
  password?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const url = params.url.trim();
  const timeoutMs = params.timeoutMs ?? 1500;
  try {
    await callGateway({
      url,
      token: params.token,
      password: params.password,
      method: "health",
      timeoutMs,
      clientName: "clawdbot-probe",
      mode: "probe",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: summarizeError(err) };
  }
}

function summarizeError(err: unknown): string {
  let raw = "unknown error";
  if (err instanceof Error) {
    raw = err.message || raw;
  } else if (typeof err === "string") {
    raw = err || raw;
  } else if (err !== undefined) {
    raw = inspect(err, { depth: 2 });
  }
  const line =
    raw
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean) ?? raw;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export const DEFAULT_WORKSPACE = DEFAULT_AGENT_WORKSPACE_DIR;

export function resolveControlUiLinks(params: {
  port: number;
  bind?: "auto" | "lan" | "tailnet" | "loopback";
  basePath?: string;
}): { httpUrl: string; wsUrl: string } {
  const port = params.port;
  const bind = params.bind ?? "loopback";
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  const host =
    bind === "tailnet" || (bind === "auto" && tailnetIPv4)
      ? (tailnetIPv4 ?? "127.0.0.1")
      : "127.0.0.1";
  const basePath = normalizeControlUiBasePath(params.basePath);
  const uiPath = basePath ? `${basePath}/` : "/";
  const wsPath = basePath ? basePath : "";
  return {
    httpUrl: `http://${host}:${port}${uiPath}`,
    wsUrl: `ws://${host}:${port}${wsPath}`,
  };
}
