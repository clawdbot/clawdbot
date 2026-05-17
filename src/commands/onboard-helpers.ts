import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { cancel, isCancel } from "@clack/prompts";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../agents/workspace.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { resolveConfigPath } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveControlUiLinks } from "../gateway/control-ui-links.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { probeGateway } from "../gateway/probe.js";
import {
  detectBrowserOpenSupport,
  openUrl,
  resolveBrowserOpenCommand,
} from "../infra/browser-open.js";
import { detectBinary } from "../infra/detect-binary.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { visibleWidth } from "../terminal/ansi.js";
import { decorativeEmoji, supportsDecorativeEmoji } from "../terminal/decorative-emoji.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { resolveConfigDir, shortenHomeInString, shortenHomePath, sleep } from "../utils.js";
import { VERSION } from "../version.js";
import type { NodeManagerChoice, OnboardMode, ResetScope } from "./onboard-types.js";
export { randomToken } from "./random-token.js";

export { detectBinary };
export { detectBrowserOpenSupport, openUrl, resolveBrowserOpenCommand };
export { resolveControlUiLinks };

export function guardCancel<T>(value: T | symbol, runtime: RuntimeEnv): T {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    runtime.exit(0);
    throw new Error("unreachable");
  }
  return value;
}

export function summarizeExistingConfig(config: OpenClawConfig): string {
  const rows: string[] = [];
  const defaults = config.agents?.defaults;
  if (defaults?.workspace) {
    rows.push(shortenHomeInString(`Workspace: ${defaults.workspace}`));
  }
  if (defaults?.model) {
    const model = resolveAgentModelPrimaryValue(defaults.model);
    if (model) {
      rows.push(shortenHomeInString(`Model: ${model}`));
    }
  }
  const gatewaySummary = summarizeGatewayConfig(config);
  if (gatewaySummary) {
    rows.push(shortenHomeInString(gatewaySummary));
  }
  if (config.skills?.install?.nodeManager) {
    rows.push(shortenHomeInString(`Node manager: ${config.skills.install.nodeManager}`));
  }
  return rows.length ? rows.join("\n") : "No key settings detected.";
}

function summarizeGatewayConfig(config: OpenClawConfig): string | null {
  const gateway = config.gateway;
  if (
    !gateway?.mode &&
    typeof gateway?.port !== "number" &&
    !gateway?.bind &&
    !gateway?.remote?.url
  ) {
    return null;
  }
  const mode = normalizeOptionalString(gateway.mode);
  const bind = formatGatewayBind(gateway.bind);
  const remoteUrl = normalizeOptionalString(gateway.remote?.url);
  const useRemoteUrl = remoteUrl !== undefined && mode !== "local";
  const endpoint =
    useRemoteUrl && remoteUrl
      ? remoteUrl
      : typeof gateway.port === "number"
        ? `:${gateway.port}`
        : undefined;
  const words: string[] = [];
  if (mode) {
    words.push(mode);
  }
  if (bind) {
    words.push(mode ? `via ${bind}` : bind);
  }
  if (mode === "remote" && !remoteUrl) {
    words.push("(missing remote URL)");
    return `Gateway: ${words.join(" ")}`;
  }
  if (endpoint) {
    words.push(`${useRemoteUrl ? "at" : "on"} ${endpoint}`);
  }
  return `Gateway: ${words.length > 0 ? words.join(" ") : "configured"}`;
}

function formatGatewayBind(value: string | undefined): string | undefined {
  switch (value) {
    case "lan":
      return "LAN";
    case "loopback":
      return "loopback";
    case "tailnet":
      return "tailnet";
    case "auto":
      return "auto";
    case "custom":
      return "custom";
    default:
      return normalizeOptionalString(value);
  }
}

export function normalizeGatewayTokenInput(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  // Reject the literal string "undefined" — a common bug when JS undefined
  // gets coerced to a string via template literals or String(undefined).
  if (trimmed === "undefined" || trimmed === "null") {
    return "";
  }
  return trimmed;
}

export function validateGatewayPasswordInput(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "Required";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "Required";
  }
  if (trimmed === "undefined" || trimmed === "null") {
    return 'Cannot be the literal string "undefined" or "null"';
  }
  return undefined;
}

export function printWizardHeader(runtime: RuntimeEnv) {
  const bannerWidth = 54;
  const icon = decorativeEmoji("🦞");
  const title = supportsDecorativeEmoji() && icon ? `${icon} OPENCLAW ${icon}` : "OPENCLAW";
  const pad = Math.max(0, bannerWidth - visibleWidth(title));
  const titleLine = `${" ".repeat(Math.floor(pad / 2))}${title}${" ".repeat(Math.ceil(pad / 2))}`;
  const header = [
    "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
    "██░▄▄▄░██░▄▄░██░▄▄▄██░▀██░██░▄▄▀██░████░▄▄▀██░███░██",
    "██░███░██░▀▀░██░▄▄▄██░█░█░██░█████░████░▀▀░██░█░█░██",
    "██░▀▀▀░██░█████░▀▀▀██░██▄░██░▀▀▄██░▀▀░█░██░██▄▀▄▀▄██",
    "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
    titleLine,
    " ",
  ].join("\n");
  runtime.log(header);
}

export function applyWizardMetadata(
  cfg: OpenClawConfig,
  params: { command: string; mode: OnboardMode },
): OpenClawConfig {
  const commit =
    normalizeOptionalString(process.env.GIT_COMMIT) ?? normalizeOptionalString(process.env.GIT_SHA);
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

export function formatControlUiSshHint(params: {
  port: number;
  basePath?: string;
  token?: string;
}): string {
  const basePath = normalizeControlUiBasePath(params.basePath);
  const uiPath = basePath ? `${basePath}/` : "/";
  const localUrl = `http://localhost:${params.port}${uiPath}`;
  const authedUrl = params.token
    ? `${localUrl}#token=${encodeURIComponent(params.token)}`
    : undefined;
  const sshTarget = resolveSshTargetHint();
  return [
    "No GUI detected. Open from your computer:",
    `ssh -N -L ${params.port}:127.0.0.1:${params.port} ${sshTarget}`,
    "Then open:",
    localUrl,
    authedUrl,
    "Docs:",
    "https://docs.openclaw.ai/gateway/remote",
    "https://docs.openclaw.ai/web/control-ui",
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

export async function ensureWorkspaceAndSessions(
  workspaceDir: string,
  runtime: RuntimeEnv,
  options?: {
    skipBootstrap?: boolean;
    skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
    agentId?: string;
  },
) {
  const ws = await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: !options?.skipBootstrap,
    skipOptionalBootstrapFiles: options?.skipOptionalBootstrapFiles,
  });
  runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(options?.agentId);
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
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

export async function moveToTrash(pathname: string, runtime: RuntimeEnv): Promise<void> {
  if (!pathname) {
    return;
  }
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await runCommandWithTimeout(["trash", pathname], { timeoutMs: 5000 });
    runtime.log(`Moved to Trash: ${shortenHomePath(pathname)}`);
  } catch {
    runtime.log(`Failed to move to Trash (manual delete): ${shortenHomePath(pathname)}`);
  }
}

export async function handleReset(scope: ResetScope, workspaceDir: string, runtime: RuntimeEnv) {
  await moveToTrash(resolveConfigPath(), runtime);
  if (scope === "config") {
    return;
  }
  await moveToTrash(path.join(resolveConfigDir(), "credentials"), runtime);
  await moveToTrash(resolveSessionTranscriptsDirForAgent(), runtime);
  if (scope === "full") {
    await moveToTrash(workspaceDir, runtime);
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
    const probe = await probeGateway({
      url,
      timeoutMs,
      auth: {
        token: params.token,
        password: params.password,
      },
      detailLevel: "none",
    });
    return probe.ok ? { ok: true } : { ok: false, detail: probe.error ?? undefined };
  } catch (err) {
    return { ok: false, detail: summarizeError(err) };
  }
}

export async function waitForGatewayReachable(params: {
  url: string;
  token?: string;
  password?: string;
  /** Total time to wait before giving up. */
  deadlineMs?: number;
  /** Per-probe timeout (each probe makes a full gateway health request). */
  probeTimeoutMs?: number;
  /** Delay between probes. */
  pollMs?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const deadlineMs = params.deadlineMs ?? 15_000;
  const pollMs = params.pollMs ?? 400;
  const probeTimeoutMs = params.probeTimeoutMs ?? 1500;
  const startedAt = Date.now();
  let lastDetail: string | undefined;

  while (Date.now() - startedAt < deadlineMs) {
    const probe = await probeGatewayReachable({
      url: params.url,
      token: params.token,
      password: params.password,
      timeoutMs: probeTimeoutMs,
    });
    if (probe.ok) {
      return probe;
    }
    lastDetail = probe.detail;
    await sleep(pollMs);
  }

  return { ok: false, detail: lastDetail };
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
