import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import {
  addAllowlistEntry,
  analyzeArgvCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  requiresExecApproval,
  normalizeExecApprovals,
  recordAllowlistUse,
  resolveExecApprovals,
  resolveSafeBins,
  ensureExecApprovals,
  readExecApprovalsSnapshot,
  resolveExecApprovalsSocketPath,
  saveExecApprovals,
  type ExecAsk,
  type ExecSecurity,
  type ExecApprovalsFile,
  type ExecAllowlistEntry,
  type ExecCommandSegment,
} from "../infra/exec-approvals.js";
import {
  requestExecHostViaSocket,
  type ExecHostRequest,
  type ExecHostResponse,
  type ExecHostRunResult,
} from "../infra/exec-host.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { loadConfig } from "../config/config.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../browser/control-service.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { detectMime } from "../media/mime.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { ensureClawdbotCliOnPath } from "../infra/path-env.js";
import { VERSION } from "../version.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

import { ensureNodeHostConfig, saveNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import { GatewayClient } from "../gateway/client.js";

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
};

type SystemRunParams = {
  command: string[];
  rawCommand?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approved?: boolean | null;
  approvalDecision?: string | null;
  runId?: string | null;
};

type SystemWhichParams = {
  bins: string[];
};

type BrowserProxyParams = {
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
};

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

type SystemExecApprovalsSetParams = {
  file: ExecApprovalsFile;
  baseHash?: string | null;
};

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

type RunResult = {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
  truncated: boolean;
};

function resolveExecSecurity(value?: string): ExecSecurity {
  return value === "deny" || value === "allowlist" || value === "full" ? value : "allowlist";
}

function resolveExecAsk(value?: string): ExecAsk {
  return value === "off" || value === "on-miss" || value === "always" ? value : "on-miss";
}

type ExecEventPayload = {
  sessionKey: string;
  runId: string;
  host: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
  success?: boolean;
  output?: string;
  reason?: string;
};

type NodeInvokeRequestPayload = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  idempotencyKey?: string | null;
};

const OUTPUT_CAP = 200_000;
const OUTPUT_EVENT_TAIL = 20_000;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const BROWSER_PROXY_MAX_FILE_BYTES = 10 * 1024 * 1024;

const execHostEnforced = process.env.CLAWDBOT_NODE_EXEC_HOST?.trim().toLowerCase() === "app";
const execHostFallbackAllowed =
  process.env.CLAWDBOT_NODE_EXEC_FALLBACK?.trim().toLowerCase() !== "0";

const blockedEnvKeys = new Set([
  "NODE_OPTIONS",
  "PYTHONHOME",
  "PYTHONPATH",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
]);

const blockedEnvPrefixes = ["DYLD_", "LD_"];

class SkillBinsCache {
  private bins = new Set<string>();
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;
  private readonly fetch: () => Promise<string[]>;

  constructor(fetch: () => Promise<string[]>) {
    this.fetch = fetch;
  }

  async current(force = false): Promise<Set<string>> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const bins = await this.fetch();
      this.bins = new Set(bins);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = new Set();
      }
    }
  }
}

function sanitizeEnv(
  overrides?: Record<string, string> | null,
): Record<string, string> | undefined {
  if (!overrides) return undefined;
  const merged = { ...process.env } as Record<string, string>;
  const basePath = process.env.PATH ?? DEFAULT_NODE_PATH;
  for (const [rawKey, value] of Object.entries(overrides)) {
    const key = rawKey.trim();
    if (!key) continue;
    const upper = key.toUpperCase();
    if (upper === "PATH") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (!basePath || trimmed === basePath) {
        merged[key] = trimmed;
        continue;
      }
      const suffix = `${path.delimiter}${basePath}`;
      if (trimmed.endsWith(suffix)) {
        merged[key] = trimmed;
      }
      continue;
    }
    if (blockedEnvKeys.has(upper)) continue;
    if (blockedEnvPrefixes.some((prefix) => upper.startsWith(prefix))) continue;
    merged[key] = value;
  }
  return merged;
}

function normalizeProfileAllowlist(raw?: string[]): string[] {
  return Array.isArray(raw) ? raw.map((entry) => entry.trim()).filter(Boolean) : [];
}

function resolveBrowserProxyConfig() {
  const cfg = loadConfig();
  const proxy = cfg.nodeHost?.browserProxy;
  const allowProfiles = normalizeProfileAllowlist(proxy?.allowProfiles);
  const enabled = proxy?.enabled !== false;
  return { enabled, allowProfiles };
}

let browserControlReady: Promise<void> | null = null;

async function ensureBrowserControlService(): Promise<void> {
  if (browserControlReady) return browserControlReady;
  browserControlReady = (async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    if (!resolved.enabled) {
      throw new Error("browser control disabled");
    }
    const started = await startBrowserControlServiceFromConfig();
    if (!started) throw new Error("browser control disabled");
  })();
  return browserControlReady;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, label?: string): Promise<T> {
  const resolved =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(1, Math.floor(timeoutMs))
      : undefined;
  if (!resolved) return await promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label ?? "request"} timed out`));
    }, resolved);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isProfileAllowed(params: { allowProfiles: string[]; profile?: string | null }) {
  const { allowProfiles, profile } = params;
  if (!allowProfiles.length) return true;
  if (!profile) return false;
  return allowProfiles.includes(profile.trim());
}

function collectBrowserProxyPaths(payload: unknown): string[] {
  const paths = new Set<string>();
  const obj =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  if (!obj) return [];
  if (typeof obj.path === "string" && obj.path.trim()) paths.add(obj.path.trim());
  if (typeof obj.imagePath === "string" && obj.imagePath.trim()) paths.add(obj.imagePath.trim());
  const download = obj.download;
  if (download && typeof download === "object") {
    const dlPath = (download as Record<string, unknown>).path;
    if (typeof dlPath === "string" && dlPath.trim()) paths.add(dlPath.trim());
  }
  return [...paths];
}

async function readBrowserProxyFile(filePath: string): Promise<BrowserProxyFile | null> {
  const stat = await fsPromises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > BROWSER_PROXY_MAX_FILE_BYTES) {
    throw new Error(
      `browser proxy file exceeds ${Math.round(BROWSER_PROXY_MAX_FILE_BYTES / (1024 * 1024))}MB`,
    );
  }
  const buffer = await fsPromises.readFile(filePath);
  const mimeType = await detectMime({ buffer, filePath });
  return { path: filePath, base64: buffer.toString("base64"), mimeType };
}

function formatCommand(argv: string[]): string {
  return argv
    .map((arg) => {
      const trimmed = arg.trim();
      if (!trimmed) return '""';
      const needsQuotes = /\s|"/.test(trimmed);
      if (!needsQuotes) return trimmed;
      return `"${trimmed.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

function truncateOutput(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  return { text: `... (truncated) ${raw.slice(raw.length - maxChars)}`, truncated: true };
}

function redactExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  return {
    ...file,
    socket: socketPath ? { path: socketPath } : undefined,
  };
}

function requireExecApprovalsBaseHash(
  params: SystemExecApprovalsSetParams,
  snapshot: ExecApprovalsSnapshot,
) {
  if (!snapshot.exists) return;
  if (!snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash unavailable; reload and retry");
  }
  const baseHash = typeof params.baseHash === "string" ? params.baseHash.trim() : "";
  if (!baseHash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash required; reload and retry");
  }
  if (baseHash !== snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
  }
}

async function runCommand(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
): Promise<RunResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (outputLen >= OUTPUT_CAP) {
        truncated = true;
        return;
      }
      const remaining = OUTPUT_CAP - outputLen;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      const str = slice.toString("utf8");
      outputLen += slice.length;
      if (target === "stdout") stdout += str;
      else stderr += str;
      if (chunk.length > remaining) truncated = true;
    };

    child.stdout?.on("data", (chunk) => onChunk(chunk as Buffer, "stdout"));
    child.stderr?.on("data", (chunk) => onChunk(chunk as Buffer, "stderr"));

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    const finalize = (exitCode?: number, error?: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        success: exitCode === 0 && !timedOut && !error,
        stdout,
        stderr,
        error: error ?? null,
        truncated,
      });
    };

    child.on("error", (err) => {
      finalize(undefined, err.message);
    });
    child.on("exit", (code) => {
      finalize(code === null ? undefined : code, null);
    });
  });
}

function resolveEnvPath(env?: Record<string, string>): string[] {
  const raw =
    env?.PATH ??
    (env as Record<string, string>)?.Path ??
    process.env.PATH ??
    process.env.Path ??
    DEFAULT_NODE_PATH;
  return raw.split(path.delimiter).filter(Boolean);
}

function ensureNodePathEnv(): string {
  ensureClawdbotCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) return current;
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

function resolveExecutable(bin: string, env?: Record<string, string>) {
  if (bin.includes("/") || bin.includes("\\")) return null;
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((ext) => ext.toLowerCase())
      : [""];
  for (const dir of resolveEnvPath(env)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function handleSystemWhich(params: SystemWhichParams, env?: Record<string, string>) {
  const bins = params.bins.map((bin) => bin.trim()).filter(Boolean);
  const found: Record<string, string> = {};
  for (const bin of bins) {
    const path = resolveExecutable(bin, env);
    if (path) found[bin] = path;
  }
  return { bins: found };
}

function buildExecEventPayload(payload: ExecEventPayload): ExecEventPayload {
  if (!payload.output) return payload;
  const trimmed = payload.output.trim();
  if (!trimmed) return payload;
  const { text } = truncateOutput(trimmed, OUTPUT_EVENT_TAIL);
  return { ...payload, output: text };
}

async function runViaMacAppExecHost(params: {
  approvals: ReturnType<typeof resolveExecApprovals>;
  request: ExecHostRequest;
}): Promise<ExecHostResponse | null> {
  const { approvals, request } = params;
  return await requestExecHostViaSocket({
    socketPath: approvals.socketPath,
    token: approvals.token,
    request,
  });
}

export async function runNodeHost(opts: NodeHostRunOptions): Promise<void> {
  const config = await ensureNodeHostConfig();
  const nodeId = opts.nodeId?.trim() || config.nodeId;
  if (nodeId !== config.nodeId) {
    config.nodeId = nodeId;
  }
  const displayName =
    opts.displayName?.trim() || config.displayName || (await getMachineDisplayName());
  config.displayName = displayName;
  const gateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? loadConfig().gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
  };
  config.gateway = gateway;
  await saveNodeHostConfig(config);

  const cfg = loadConfig();
  const browserProxy = resolveBrowserProxyConfig();
  const resolvedBrowser = resolveBrowserConfig(cfg.browser, cfg);
  const browserProxyEnabled = browserProxy.enabled && resolvedBrowser.enabled;
  const isRemoteMode = cfg.gateway?.mode === "remote";
  const token =
    process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
    (isRemoteMode ? cfg.gateway?.remote?.token : cfg.gateway?.auth?.token);
  const password =
    process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    (isRemoteMode ? cfg.gateway?.remote?.password : cfg.gateway?.auth?.password);

  const host = gateway.host ?? "127.0.0.1";
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const url = `${scheme}://${host}:${port}`;
  const pathEnv = ensureNodePathEnv();
  // eslint-disable-next-line no-console
  console.log(`node host PATH: ${pathEnv}`);

  const client = new GatewayClient({
    url,
    token: token?.trim() || undefined,
    password: password?.trim() || undefined,
    instanceId: nodeId,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: displayName,
    clientVersion: VERSION,
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    caps: ["system", ...(browserProxyEnabled ? ["browser"] : [])],
    commands: [
      "system.run",
      "system.which",
      "system.execApprovals.get",
      "system.execApprovals.set",
      ...(browserProxyEnabled ? ["browser.proxy"] : []),
    ],
    pathEnv,
    permissions: undefined,
    deviceIdentity: loadOrCreateDeviceIdentity(),
    tlsFingerprint: gateway.tlsFingerprint,
    onEvent: (evt) => {
      if (evt.event !== "node.invoke.request") return;
      const payload = coerceNodeInvokePayload(evt.payload);
      if (!payload) return;
      void handleInvoke(payload, client, skillBins);
    },
    onConnectError: (err) => {
      // keep retrying (handled by GatewayClient)
      // eslint-disable-next-line no-console
      console.error(`node host gateway connect failed: ${err.message}`);
    },
    onClose: (code, reason) => {
      // eslint-disable-next-line no-console
      console.error(`node host gateway closed (${code}): ${reason}`);
    },
  });

  const skillBins = new SkillBinsCache(async () => {
    const res = (await client.request("skills.bins", {})) as
      | { bins?: unknown[] }
      | null
      | undefined;
    const bins = Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
    return bins;
  });

  client.start();
  await new Promise(() => {});
}

async function handleInvoke(
  frame: NodeInvokeRequestPayload,
  client: GatewayClient,
  skillBins: SkillBinsCache,
) {
  const command = String(frame.command ?? "");
  if (command === "system.execApprovals.get") {
    try {
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: snapshot.path,
        exists: snapshot.exists,
        hash: snapshot.hash,
        file: redactExecApprovals(snapshot.file),
      };
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      const message = String(err);
      const code = message.toLowerCase().includes("timed out") ? "TIMEOUT" : "INVALID_REQUEST";
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code, message },
      });
    }
    return;
  }

  if (command === "system.execApprovals.set") {
    try {
      const params = decodeParams<SystemExecApprovalsSetParams>(frame.paramsJSON);
      if (!params.file || typeof params.file !== "object") {
        throw new Error("INVALID_REQUEST: exec approvals file required");
      }
      ensureExecApprovals();
      const snapshot = readExecApprovalsSnapshot();
      requireExecApprovalsBaseHash(params, snapshot);
      const normalized = normalizeExecApprovals(params.file);
      const currentSocketPath = snapshot.file.socket?.path?.trim();
      const currentToken = snapshot.file.socket?.token?.trim();
      const socketPath =
        normalized.socket?.path?.trim() ?? currentSocketPath ?? resolveExecApprovalsSocketPath();
      const token = normalized.socket?.token?.trim() ?? currentToken ?? "";
      const next: ExecApprovalsFile = {
        ...normalized,
        socket: {
          path: socketPath,
          token,
        },
      };
      saveExecApprovals(next);
      const nextSnapshot = readExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: nextSnapshot.path,
        exists: nextSnapshot.exists,
        hash: nextSnapshot.hash,
        file: redactExecApprovals(nextSnapshot.file),
      };
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: String(err) },
      });
    }
    return;
  }

  if (command === "system.which") {
    try {
      const params = decodeParams<SystemWhichParams>(frame.paramsJSON);
      if (!Array.isArray(params.bins)) {
        throw new Error("INVALID_REQUEST: bins required");
      }
      const env = sanitizeEnv(undefined);
      const payload = await handleSystemWhich(params, env);
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: String(err) },
      });
    }
    return;
  }

  if (command === "browser.proxy") {
    try {
      const params = decodeParams<BrowserProxyParams>(frame.paramsJSON);
      const pathValue = typeof params.path === "string" ? params.path.trim() : "";
      if (!pathValue) {
        throw new Error("INVALID_REQUEST: path required");
      }
      const proxyConfig = resolveBrowserProxyConfig();
      if (!proxyConfig.enabled) {
        throw new Error("UNAVAILABLE: node browser proxy disabled");
      }
      await ensureBrowserControlService();
      const cfg = loadConfig();
      const resolved = resolveBrowserConfig(cfg.browser, cfg);
      const requestedProfile = typeof params.profile === "string" ? params.profile.trim() : "";
      const allowedProfiles = proxyConfig.allowProfiles;
      if (allowedProfiles.length > 0) {
        if (pathValue !== "/profiles") {
          const profileToCheck = requestedProfile || resolved.defaultProfile;
          if (!isProfileAllowed({ allowProfiles: allowedProfiles, profile: profileToCheck })) {
            throw new Error("INVALID_REQUEST: browser profile not allowed");
          }
        } else if (requestedProfile) {
          if (!isProfileAllowed({ allowProfiles: allowedProfiles, profile: requestedProfile })) {
            throw new Error("INVALID_REQUEST: browser profile not allowed");
          }
        }
      }

      const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
      const path = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
      const body = params.body;
      const query: Record<string, unknown> = {};
      if (requestedProfile) {
        query.profile = requestedProfile;
      }
      const rawQuery = params.query ?? {};
      for (const [key, value] of Object.entries(rawQuery)) {
        if (value === undefined || value === null) continue;
        query[key] = typeof value === "string" ? value : String(value);
      }
      const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
      const response = await withTimeout(
        dispatcher.dispatch({
          method: method === "DELETE" ? "DELETE" : method === "POST" ? "POST" : "GET",
          path,
          query,
          body,
        }),
        params.timeoutMs,
        "browser proxy request",
      );
      if (response.status >= 400) {
        const message =
          response.body && typeof response.body === "object" && "error" in response.body
            ? String((response.body as { error?: unknown }).error)
            : `HTTP ${response.status}`;
        throw new Error(message);
      }
      const result = response.body as unknown;
      if (allowedProfiles.length > 0 && path === "/profiles") {
        const obj =
          typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
        const profiles = Array.isArray(obj.profiles) ? obj.profiles : [];
        obj.profiles = profiles.filter((entry) => {
          if (!entry || typeof entry !== "object") return false;
          const name = (entry as Record<string, unknown>).name;
          return typeof name === "string" && allowedProfiles.includes(name);
        });
      }
      let files: BrowserProxyFile[] | undefined;
      const paths = collectBrowserProxyPaths(result);
      if (paths.length > 0) {
        const loaded = await Promise.all(
          paths.map(async (p) => {
            try {
              const file = await readBrowserProxyFile(p);
              if (!file) {
                throw new Error("file not found");
              }
              return file;
            } catch (err) {
              throw new Error(`browser proxy file read failed for ${p}: ${String(err)}`);
            }
          }),
        );
        if (loaded.length > 0) files = loaded;
      }
      const payload: BrowserProxyResult = files ? { result, files } : { result };
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    } catch (err) {
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: String(err) },
      });
    }
    return;
  }

  if (command !== "system.run") {
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "command not supported" },
    });
    return;
  }

  let params: SystemRunParams;
  try {
    params = decodeParams<SystemRunParams>(frame.paramsJSON);
  } catch (err) {
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: String(err) },
    });
    return;
  }

  if (!Array.isArray(params.command) || params.command.length === 0) {
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "command required" },
    });
    return;
  }

  const argv = params.command.map((item) => String(item));
  const rawCommand = typeof params.rawCommand === "string" ? params.rawCommand.trim() : "";
  const cmdText = rawCommand || formatCommand(argv);
  const agentId = params.agentId?.trim() || undefined;
  const cfg = loadConfig();
  const agentExec = agentId ? resolveAgentConfig(cfg, agentId)?.tools?.exec : undefined;
  const configuredSecurity = resolveExecSecurity(agentExec?.security ?? cfg.tools?.exec?.security);
  const configuredAsk = resolveExecAsk(agentExec?.ask ?? cfg.tools?.exec?.ask);
  const approvals = resolveExecApprovals(agentId, {
    security: configuredSecurity,
    ask: configuredAsk,
  });
  const security = approvals.agent.security;
  const ask = approvals.agent.ask;
  const autoAllowSkills = approvals.agent.autoAllowSkills;
  const sessionKey = params.sessionKey?.trim() || "node";
  const runId = params.runId?.trim() || crypto.randomUUID();
  const env = sanitizeEnv(params.env ?? undefined);
  const safeBins = resolveSafeBins(agentExec?.safeBins ?? cfg.tools?.exec?.safeBins);
  const bins = autoAllowSkills ? await skillBins.current() : new Set<string>();
  let analysisOk = false;
  let allowlistMatches: ExecAllowlistEntry[] = [];
  let allowlistSatisfied = false;
  let segments: ExecCommandSegment[] = [];
  if (rawCommand) {
    const allowlistEval = evaluateShellAllowlist({
      command: rawCommand,
      allowlist: approvals.allowlist,
      safeBins,
      cwd: params.cwd ?? undefined,
      env,
      skillBins: bins,
      autoAllowSkills,
    });
    analysisOk = allowlistEval.analysisOk;
    allowlistMatches = allowlistEval.allowlistMatches;
    allowlistSatisfied =
      security === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
    segments = allowlistEval.segments;
  } else {
    const analysis = analyzeArgvCommand({ argv, cwd: params.cwd ?? undefined, env });
    const allowlistEval = evaluateExecAllowlist({
      analysis,
      allowlist: approvals.allowlist,
      safeBins,
      cwd: params.cwd ?? undefined,
      skillBins: bins,
      autoAllowSkills,
    });
    analysisOk = analysis.ok;
    allowlistMatches = allowlistEval.allowlistMatches;
    allowlistSatisfied =
      security === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
    segments = analysis.segments;
  }

  const useMacAppExec = process.platform === "darwin";
  if (useMacAppExec) {
    const approvalDecision =
      params.approvalDecision === "allow-once" || params.approvalDecision === "allow-always"
        ? params.approvalDecision
        : null;
    const execRequest: ExecHostRequest = {
      command: argv,
      rawCommand: rawCommand || null,
      cwd: params.cwd ?? null,
      env: params.env ?? null,
      timeoutMs: params.timeoutMs ?? null,
      needsScreenRecording: params.needsScreenRecording ?? null,
      agentId: agentId ?? null,
      sessionKey: sessionKey ?? null,
      approvalDecision,
    };
    const response = await runViaMacAppExecHost({ approvals, request: execRequest });
    if (!response) {
      if (execHostEnforced || !execHostFallbackAllowed) {
        await sendNodeEvent(
          client,
          "exec.denied",
          buildExecEventPayload({
            sessionKey,
            runId,
            host: "node",
            command: cmdText,
            reason: "companion-unavailable",
          }),
        );
        await sendInvokeResult(client, frame, {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "COMPANION_APP_UNAVAILABLE: macOS app exec host unreachable",
          },
        });
        return;
      }
    } else if (!response.ok) {
      const reason = response.error.reason ?? "approval-required";
      await sendNodeEvent(
        client,
        "exec.denied",
        buildExecEventPayload({
          sessionKey,
          runId,
          host: "node",
          command: cmdText,
          reason,
        }),
      );
      await sendInvokeResult(client, frame, {
        ok: false,
        error: { code: "UNAVAILABLE", message: response.error.message },
      });
      return;
    } else {
      const result: ExecHostRunResult = response.payload;
      const combined = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
      await sendNodeEvent(
        client,
        "exec.finished",
        buildExecEventPayload({
          sessionKey,
          runId,
          host: "node",
          command: cmdText,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          success: result.success,
          output: combined,
        }),
      );
      await sendInvokeResult(client, frame, {
        ok: true,
        payloadJSON: JSON.stringify(result),
      });
      return;
    }
  }

  if (security === "deny") {
    await sendNodeEvent(
      client,
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "security=deny",
      }),
    );
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DISABLED: security=deny" },
    });
    return;
  }

  const requiresAsk = requiresExecApproval({
    ask,
    security,
    analysisOk,
    allowlistSatisfied,
  });

  const approvalDecision =
    params.approvalDecision === "allow-once" || params.approvalDecision === "allow-always"
      ? params.approvalDecision
      : null;
  const approvedByAsk = approvalDecision !== null || params.approved === true;
  if (requiresAsk && !approvedByAsk) {
    await sendNodeEvent(
      client,
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "approval-required",
      }),
    );
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
    });
    return;
  }
  if (approvalDecision === "allow-always" && security === "allowlist") {
    if (analysisOk) {
      for (const segment of segments) {
        const pattern = segment.resolution?.resolvedPath ?? "";
        if (pattern) addAllowlistEntry(approvals.file, agentId, pattern);
      }
    }
  }

  if (security === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) {
    await sendNodeEvent(
      client,
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "allowlist-miss",
      }),
    );
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: allowlist miss" },
    });
    return;
  }

  if (allowlistMatches.length > 0) {
    const seen = new Set<string>();
    for (const match of allowlistMatches) {
      if (!match?.pattern || seen.has(match.pattern)) continue;
      seen.add(match.pattern);
      recordAllowlistUse(
        approvals.file,
        agentId,
        match,
        cmdText,
        segments[0]?.resolution?.resolvedPath,
      );
    }
  }

  if (params.needsScreenRecording === true) {
    await sendNodeEvent(
      client,
      "exec.denied",
      buildExecEventPayload({
        sessionKey,
        runId,
        host: "node",
        command: cmdText,
        reason: "permission:screenRecording",
      }),
    );
    await sendInvokeResult(client, frame, {
      ok: false,
      error: { code: "UNAVAILABLE", message: "PERMISSION_MISSING: screenRecording" },
    });
    return;
  }

  const result = await runCommand(
    argv,
    params.cwd?.trim() || undefined,
    env,
    params.timeoutMs ?? undefined,
  );
  if (result.truncated) {
    const suffix = "... (truncated)";
    if (result.stderr.trim().length > 0) {
      result.stderr = `${result.stderr}\n${suffix}`;
    } else {
      result.stdout = `${result.stdout}\n${suffix}`;
    }
  }
  const combined = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
  await sendNodeEvent(
    client,
    "exec.finished",
    buildExecEventPayload({
      sessionKey,
      runId,
      host: "node",
      command: cmdText,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success: result.success,
      output: combined,
    }),
  );

  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON: JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ?? null,
    }),
  });
}

function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  return JSON.parse(raw) as T;
}

function coerceNodeInvokePayload(payload: unknown): NodeInvokeRequestPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!id || !nodeId || !command) return null;
  const paramsJSON =
    typeof obj.paramsJSON === "string"
      ? obj.paramsJSON
      : obj.params !== undefined
        ? JSON.stringify(obj.params)
        : null;
  const timeoutMs = typeof obj.timeoutMs === "number" ? obj.timeoutMs : null;
  const idempotencyKey = typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : null;
  return {
    id,
    nodeId,
    command,
    paramsJSON,
    timeoutMs,
    idempotencyKey,
  };
}

async function sendInvokeResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
) {
  try {
    await client.request("node.invoke.result", buildNodeInvokeResultParams(frame, result));
  } catch {
    // ignore: node invoke responses are best-effort
  }
}

export function buildNodeInvokeResultParams(
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
): {
  id: string;
  nodeId: string;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
} {
  const params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string;
    error?: { code?: string; message?: string };
  } = {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: result.ok,
  };
  if (result.payload !== undefined) {
    params.payload = result.payload;
  }
  if (typeof result.payloadJSON === "string") {
    params.payloadJSON = result.payloadJSON;
  }
  if (result.error) {
    params.error = result.error;
  }
  return params;
}

async function sendNodeEvent(client: GatewayClient, event: string, payload: unknown) {
  try {
    await client.request("node.event", {
      event,
      payloadJSON: payload ? JSON.stringify(payload) : null,
    });
  } catch {
    // ignore: node events are best-effort
  }
}
