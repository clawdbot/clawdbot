/** Shared helpers for onboarding, reset, gateway checks, and wizard output. */
import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { cancel, isCancel } from "@clack/prompts";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../agents/workspace.js";
import { printClawBanner } from "../cli/claw-banner.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { resolveConfigPath } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { GatewayAuthMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveAdvertisedControlUiLinks,
  resolveControlUiLinks,
  resolveLocalControlUiProbeLinks,
} from "../gateway/control-ui-links.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { probeGateway, type GatewayProbeResult } from "../gateway/probe.js";
import {
  detectBrowserOpenSupport,
  openUrl,
  resolveBrowserOpenCommand,
} from "../infra/browser-open.js";
import { detectBinary } from "../infra/detect-binary.js";
import { movePathToTrash } from "../infra/fs-safe.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveConfigDir, shortenHomeInString, shortenHomePath, sleep } from "../utils.js";
import { VERSION } from "../version.js";
import type { OnboardMode, ResetScope } from "./onboard-types.js";
export { randomToken } from "./random-token.js";

export { detectBinary };
export { detectBrowserOpenSupport, openUrl, resolveBrowserOpenCommand };
export { resolveAdvertisedControlUiLinks, resolveControlUiLinks, resolveLocalControlUiProbeLinks };

/** Builds the token-authenticated Control UI URL shown by onboarding surfaces. */
export function buildOnboardingControlUiUrl(params: {
  httpUrl: string;
  authMode?: GatewayAuthMode;
  token?: string;
  suppressTokenOutput?: boolean;
}): string {
  return params.authMode === "token" && params.token && !params.suppressTokenOutput
    ? `${params.httpUrl}#token=${encodeURIComponent(params.token)}`
    : params.httpUrl;
}

/** Handles Clack cancellation by exiting through the runtime. */
export function guardCancel<T>(value: T | symbol, runtime: RuntimeEnv, exitCode = 0): T {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    runtime.exit(exitCode);
    throw new Error("unreachable");
  }
  return value;
}

/** Summarizes existing config values before onboarding overwrites or reuses them. */
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

/** Normalizes gateway token prompts while rejecting JS stringification sentinels. */
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

/** Validates gateway password prompt input. */
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

/** Prints the onboarding banner: pixel mascot beside the OPENCLAW wordmark. */
export async function printWizardHeader(runtime: RuntimeEnv): Promise<void> {
  await printClawBanner(runtime);
}

/** Records wizard provenance metadata on config writes. */
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

/** Formats the no-GUI SSH tunnel hint for opening the Control UI remotely. */
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
    "BYOH note: lan, tailnet, and custom bind are currently IPv4-only.",
    "If your host is IPv6-only, use an IPv4 sidecar or proxy in front of the Gateway.",
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

/** Ensures workspace bootstrap files and session transcript directories exist. */
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

/** Moves a path to Trash when it exists, logging a manual-delete fallback on failure. */
export async function moveToTrash(pathname: string, runtime: RuntimeEnv): Promise<boolean> {
  if (!pathname) {
    return false;
  }
  try {
    await fs.lstat(pathname);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const targetPath = path.resolve(pathname);
    const sourcePath = await resolveMoveToTrashSourcePath(targetPath);
    await movePathToTrash(sourcePath, {
      allowedRoots: await resolveMoveToTrashAllowedRoots(sourcePath),
    });
    runtime.log(`Moved to Trash: ${shortenHomePath(pathname)}`);
    return true;
  } catch {
    runtime.log(`Failed to move to Trash (manual delete): ${shortenHomePath(pathname)}`);
    return false;
  }
}

async function resolveMoveToTrashSourcePath(targetPath: string): Promise<string> {
  return path.join(await fs.realpath(path.dirname(targetPath)), path.basename(targetPath));
}

async function resolveMoveToTrashAllowedRoots(targetPath: string): Promise<string[]> {
  const allowedRoots = [path.dirname(targetPath)];
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    try {
      // fs-safe resolves valid symlinks before allow-root checks; include the
      // resolved parent so deleting a configured symlink moves the link itself.
      allowedRoots.push(path.dirname(await fs.realpath(targetPath)));
    } catch {
      // Broken symlinks are handled lexically by fs-safe.
    }
  }
  return uniqueStrings(allowedRoots);
}

/** Deletes onboarding-managed state according to the selected reset scope. */
export async function handleReset(scope: ResetScope, workspaceDir: string, runtime: RuntimeEnv) {
  await moveToTrash(resolveConfigPath(), runtime);
  if (scope === "config") {
    return;
  }
  await moveToTrash(path.join(resolveConfigDir(), "credentials"), runtime);
  await moveToTrash(resolveSessionTranscriptsDirForAgent(), runtime);
  if (scope === "full") {
    const legacyPlan = prepareLegacyWorkspaceStateReset(workspaceDir);
    const statePlan = prepareWorkspaceStateDeletion(workspaceDir);
    const workspaceRemoved = await moveToTrash(workspaceDir, runtime);
    if (workspaceRemoved) {
      const legacyCleanup = await removeLegacyWorkspaceStateForReset(legacyPlan);
      for (const warning of legacyCleanup.warnings) {
        runtime.log(warning);
      }
      deleteWorkspaceState(statePlan);
    }
  }
}

type OnboardingGatewayProbeParams = {
  url: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
  timeoutMs?: number;
};

function runOnboardingGatewayProbe(
  params: OnboardingGatewayProbeParams,
  detailLevel: "none" | "config",
): Promise<GatewayProbeResult> {
  const url = params.url.trim();
  const timeoutMs = params.timeoutMs ?? Math.max(1500, params.preauthHandshakeTimeoutMs ?? 0);
  return probeGateway({
    url,
    timeoutMs,
    auth: {
      token: params.token,
      password: params.password,
    },
    ...(params.tlsFingerprint ? { tlsFingerprint: params.tlsFingerprint } : {}),
    ...(params.preauthHandshakeTimeoutMs
      ? { preauthHandshakeTimeoutMs: params.preauthHandshakeTimeoutMs }
      : {}),
    detailLevel,
  });
}

/** Runs a single lightweight gateway probe for onboarding readiness checks. */
export async function probeGatewayReachable(
  params: OnboardingGatewayProbeParams,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const probe = await runOnboardingGatewayProbe(params, "none");
    if (!probe.ok) {
      return { ok: false, detail: probe.error ?? undefined };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: summarizeError(err) };
  }
}

export type GatewayConfiguredModelProbeResult =
  | { kind: "configured" }
  | { kind: "missing-configured-model"; detail: string }
  | { kind: "reachable-unverified"; detail?: string }
  | { kind: "unreachable"; detail?: string };

const RECOGNIZED_GATEWAY_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(ConnectErrorDetailCodes),
);

function didProbeReachGateway(probe: GatewayProbeResult): boolean {
  const connectErrorCode = readConnectErrorDetailCode(probe.connectErrorDetails);
  const recognizedConnectError =
    connectErrorCode !== null && RECOGNIZED_GATEWAY_CONNECT_ERROR_CODES.has(connectErrorCode);
  const serverVersion = probe.server?.version?.trim();
  const serverConnectionId = probe.server?.connId?.trim();
  // Opening a WebSocket proves only that something is listening. A Gateway is
  // established by a hello-ok server identity or its typed connect rejection.
  return recognizedConnectError || Boolean(serverVersion && serverConnectionId);
}

/** Reads only Gateway config and classifies whether its default agent has inference. */
export async function probeGatewayConfiguredModel(
  params: OnboardingGatewayProbeParams,
): Promise<GatewayConfiguredModelProbeResult> {
  let probe: GatewayProbeResult;
  try {
    probe = await runOnboardingGatewayProbe(params, "config");
  } catch (err) {
    return { kind: "unreachable", detail: summarizeError(err) };
  }
  const detail = probe.error ?? undefined;
  if (!didProbeReachGateway(probe)) {
    return { kind: "unreachable", ...(detail ? { detail } : {}) };
  }
  if (!probe.ok) {
    return { kind: "reachable-unverified", detail };
  }
  const snapshot = probe.configSnapshot as {
    valid?: unknown;
    runtimeConfig?: unknown;
    config?: unknown;
  } | null;
  const configCandidate =
    snapshot?.valid === true ? (snapshot.runtimeConfig ?? snapshot.config) : null;
  if (!configCandidate || typeof configCandidate !== "object" || Array.isArray(configCandidate)) {
    return {
      kind: "reachable-unverified",
      detail: "Gateway returned an invalid config snapshot",
    };
  }
  try {
    const config = configCandidate as OpenClawConfig;
    const model = resolveAgentEffectiveModelPrimary(config, resolveDefaultAgentId(config));
    return model
      ? { kind: "configured" }
      : {
          kind: "missing-configured-model",
          detail: "Gateway default agent has no configured model",
        };
  } catch {
    return {
      kind: "reachable-unverified",
      detail: "Gateway returned an invalid config snapshot",
    };
  }
}

/** Polls gateway reachability until success or deadline. */
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
  const pollMs = resolveTimerTimeoutMs(params.pollMs ?? 400, 400, 0);
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
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollMs, remainingMs));
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
  return line.length > 120 ? `${truncateUtf16Safe(line, 119)}…` : line;
}

export const testing = { summarizeError };

/** Default workspace path shown by onboarding prompts. */
export const DEFAULT_WORKSPACE = DEFAULT_AGENT_WORKSPACE_DIR;
