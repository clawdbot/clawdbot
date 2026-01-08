import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type BrowserBridge,
  startBrowserBridgeServer,
  stopBrowserBridgeServer,
} from "../browser/bridge-server.js";
import {
  type ResolvedBrowserConfig,
  resolveProfile,
} from "../browser/config.js";
import { DEFAULT_CLAWD_BROWSER_COLOR } from "../browser/constants.js";
import type { ClawdbotConfig } from "../config/config.js";
import { STATE_DIR_CLAWDBOT } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentIdFromSessionKey } from "./agent-scope.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "./workspace.js";

export type SandboxToolPolicy = {
  allow?: string[];
  deny?: string[];
};

export type SandboxWorkspaceAccess = "none" | "ro" | "rw";

export type SandboxBrowserConfig = {
  enabled: boolean;
  image: string;
  containerPrefix: string;
  cdpPort: number;
  vncPort: number;
  noVncPort: number;
  headless: boolean;
  enableNoVnc: boolean;
};

export type SandboxDockerConfig = {
  image: string;
  containerPrefix: string;
  workdir: string;
  readOnlyRoot: boolean;
  tmpfs: string[];
  network: string;
  user?: string;
  capDrop: string[];
  env?: Record<string, string>;
  setupCommand?: string;
  pidsLimit?: number;
  memory?: string | number;
  memorySwap?: string | number;
  cpus?: number;
  ulimits?: Record<string, string | number | { soft?: number; hard?: number }>;
  seccompProfile?: string;
  apparmorProfile?: string;
  dns?: string[];
  extraHosts?: string[];
};

export type SandboxPruneConfig = {
  idleHours: number;
  maxAgeDays: number;
};

export type SandboxScope = "session" | "agent" | "shared";

export type SandboxConfig = {
  mode: "off" | "non-main" | "all";
  scope: SandboxScope;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceRoot: string;
  docker: SandboxDockerConfig;
  browser: SandboxBrowserConfig;
  tools: SandboxToolPolicy;
  prune: SandboxPruneConfig;
};

export type SandboxBrowserContext = {
  controlUrl: string;
  noVncUrl?: string;
  containerName: string;
};

export type SandboxContext = {
  enabled: boolean;
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  containerName: string;
  containerWorkdir: string;
  docker: SandboxDockerConfig;
  tools: SandboxToolPolicy;
  browser?: SandboxBrowserContext;
};

export type SandboxWorkspaceInfo = {
  workspaceDir: string;
  containerWorkdir: string;
};

const DEFAULT_SANDBOX_WORKSPACE_ROOT = path.join(
  os.homedir(),
  ".clawdbot",
  "sandboxes",
);
export const DEFAULT_SANDBOX_IMAGE = "clawdbot-sandbox:bookworm-slim";
const DEFAULT_SANDBOX_CONTAINER_PREFIX = "clawdbot-sbx-";
const DEFAULT_SANDBOX_WORKDIR = "/workspace";
const DEFAULT_SANDBOX_IDLE_HOURS = 24;
const DEFAULT_SANDBOX_MAX_AGE_DAYS = 7;
const DEFAULT_TOOL_ALLOW = [
  "bash",
  "process",
  "read",
  "write",
  "edit",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
];
const DEFAULT_TOOL_DENY = [
  "browser",
  "canvas",
  "nodes",
  "cron",
  "discord",
  "gateway",
];
export const DEFAULT_SANDBOX_BROWSER_IMAGE =
  "clawdbot-sandbox-browser:bookworm-slim";
export const DEFAULT_SANDBOX_COMMON_IMAGE =
  "clawdbot-sandbox-common:bookworm-slim";
const DEFAULT_SANDBOX_BROWSER_PREFIX = "clawdbot-sbx-browser-";
const DEFAULT_SANDBOX_BROWSER_CDP_PORT = 9222;
const DEFAULT_SANDBOX_BROWSER_VNC_PORT = 5900;
const DEFAULT_SANDBOX_BROWSER_NOVNC_PORT = 6080;
const SANDBOX_AGENT_WORKSPACE_MOUNT = "/agent";

const SANDBOX_STATE_DIR = path.join(STATE_DIR_CLAWDBOT, "sandbox");
const SANDBOX_REGISTRY_PATH = path.join(SANDBOX_STATE_DIR, "containers.json");
const SANDBOX_BROWSER_REGISTRY_PATH = path.join(
  SANDBOX_STATE_DIR,
  "browsers.json",
);

type SandboxRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
};

type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

type SandboxBrowserRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  cdpPort: number;
  noVncPort?: number;
};

type SandboxBrowserRegistry = {
  entries: SandboxBrowserRegistryEntry[];
};

let lastPruneAtMs = 0;
const BROWSER_BRIDGES = new Map<
  string,
  { bridge: BrowserBridge; containerName: string }
>();

function normalizeToolList(values?: string[]) {
  if (!values) return [];
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toLowerCase());
}

function isToolAllowed(policy: SandboxToolPolicy, name: string) {
  const deny = new Set(normalizeToolList(policy.deny));
  if (deny.has(name.toLowerCase())) return false;
  const allow = normalizeToolList(policy.allow);
  if (allow.length === 0) return true;
  return allow.includes(name.toLowerCase());
}

export function resolveSandboxScope(params: {
  scope?: SandboxScope;
  perSession?: boolean;
}): SandboxScope {
  if (params.scope) return params.scope;
  if (typeof params.perSession === "boolean") {
    return params.perSession ? "session" : "shared";
  }
  return "agent";
}

export function resolveSandboxDockerConfig(params: {
  scope: SandboxScope;
  globalDocker?: Partial<SandboxDockerConfig>;
  agentDocker?: Partial<SandboxDockerConfig>;
}): SandboxDockerConfig {
  const agentDocker =
    params.scope === "shared" ? undefined : params.agentDocker;
  const globalDocker = params.globalDocker;

  const env = agentDocker?.env
    ? { ...(globalDocker?.env ?? { LANG: "C.UTF-8" }), ...agentDocker.env }
    : (globalDocker?.env ?? { LANG: "C.UTF-8" });

  const ulimits = agentDocker?.ulimits
    ? { ...globalDocker?.ulimits, ...agentDocker.ulimits }
    : globalDocker?.ulimits;

  return {
    image: agentDocker?.image ?? globalDocker?.image ?? DEFAULT_SANDBOX_IMAGE,
    containerPrefix:
      agentDocker?.containerPrefix ??
      globalDocker?.containerPrefix ??
      DEFAULT_SANDBOX_CONTAINER_PREFIX,
    workdir:
      agentDocker?.workdir ?? globalDocker?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
    readOnlyRoot:
      agentDocker?.readOnlyRoot ?? globalDocker?.readOnlyRoot ?? true,
    tmpfs: agentDocker?.tmpfs ??
      globalDocker?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
    network: agentDocker?.network ?? globalDocker?.network ?? "none",
    user: agentDocker?.user ?? globalDocker?.user,
    capDrop: agentDocker?.capDrop ?? globalDocker?.capDrop ?? ["ALL"],
    env,
    setupCommand: agentDocker?.setupCommand ?? globalDocker?.setupCommand,
    pidsLimit: agentDocker?.pidsLimit ?? globalDocker?.pidsLimit,
    memory: agentDocker?.memory ?? globalDocker?.memory,
    memorySwap: agentDocker?.memorySwap ?? globalDocker?.memorySwap,
    cpus: agentDocker?.cpus ?? globalDocker?.cpus,
    ulimits,
    seccompProfile: agentDocker?.seccompProfile ?? globalDocker?.seccompProfile,
    apparmorProfile:
      agentDocker?.apparmorProfile ?? globalDocker?.apparmorProfile,
    dns: agentDocker?.dns ?? globalDocker?.dns,
    extraHosts: agentDocker?.extraHosts ?? globalDocker?.extraHosts,
  };
}

export function resolveSandboxBrowserConfig(params: {
  scope: SandboxScope;
  globalBrowser?: Partial<SandboxBrowserConfig>;
  agentBrowser?: Partial<SandboxBrowserConfig>;
}): SandboxBrowserConfig {
  const agentBrowser =
    params.scope === "shared" ? undefined : params.agentBrowser;
  const globalBrowser = params.globalBrowser;
  return {
    enabled: agentBrowser?.enabled ?? globalBrowser?.enabled ?? false,
    image:
      agentBrowser?.image ??
      globalBrowser?.image ??
      DEFAULT_SANDBOX_BROWSER_IMAGE,
    containerPrefix:
      agentBrowser?.containerPrefix ??
      globalBrowser?.containerPrefix ??
      DEFAULT_SANDBOX_BROWSER_PREFIX,
    cdpPort:
      agentBrowser?.cdpPort ??
      globalBrowser?.cdpPort ??
      DEFAULT_SANDBOX_BROWSER_CDP_PORT,
    vncPort:
      agentBrowser?.vncPort ??
      globalBrowser?.vncPort ??
      DEFAULT_SANDBOX_BROWSER_VNC_PORT,
    noVncPort:
      agentBrowser?.noVncPort ??
      globalBrowser?.noVncPort ??
      DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
    headless: agentBrowser?.headless ?? globalBrowser?.headless ?? false,
    enableNoVnc:
      agentBrowser?.enableNoVnc ?? globalBrowser?.enableNoVnc ?? true,
  };
}

export function resolveSandboxPruneConfig(params: {
  scope: SandboxScope;
  globalPrune?: Partial<SandboxPruneConfig>;
  agentPrune?: Partial<SandboxPruneConfig>;
}): SandboxPruneConfig {
  const agentPrune = params.scope === "shared" ? undefined : params.agentPrune;
  const globalPrune = params.globalPrune;
  return {
    idleHours:
      agentPrune?.idleHours ??
      globalPrune?.idleHours ??
      DEFAULT_SANDBOX_IDLE_HOURS,
    maxAgeDays:
      agentPrune?.maxAgeDays ??
      globalPrune?.maxAgeDays ??
      DEFAULT_SANDBOX_MAX_AGE_DAYS,
  };
}

function resolveSandboxScopeKey(scope: SandboxScope, sessionKey: string) {
  const trimmed = sessionKey.trim() || "main";
  if (scope === "shared") return "shared";
  if (scope === "session") return trimmed;
  const agentId = resolveAgentIdFromSessionKey(trimmed);
  return `agent:${agentId}`;
}

export function resolveSandboxConfigForAgent(
  cfg?: ClawdbotConfig,
  agentId?: string,
): SandboxConfig {
  const agent = cfg?.agent?.sandbox;

  // Agent-specific sandbox config overrides global
  let agentSandbox: typeof agent | undefined;
  if (agentId && cfg?.routing?.agents) {
    const agentConfig = cfg.routing.agents[agentId];
    if (agentConfig && typeof agentConfig === "object") {
      agentSandbox = agentConfig.sandbox;
    }
  }

  const scope = resolveSandboxScope({
    scope: agentSandbox?.scope ?? agent?.scope,
    perSession: agentSandbox?.perSession ?? agent?.perSession,
  });

  return {
    mode: agentSandbox?.mode ?? agent?.mode ?? "off",
    scope,
    workspaceAccess:
      agentSandbox?.workspaceAccess ?? agent?.workspaceAccess ?? "none",
    workspaceRoot:
      agentSandbox?.workspaceRoot ??
      agent?.workspaceRoot ??
      DEFAULT_SANDBOX_WORKSPACE_ROOT,
    docker: resolveSandboxDockerConfig({
      scope,
      globalDocker: agent?.docker,
      agentDocker: agentSandbox?.docker,
    }),
    browser: resolveSandboxBrowserConfig({
      scope,
      globalBrowser: agent?.browser,
      agentBrowser: agentSandbox?.browser,
    }),
    tools: {
      allow:
        agentSandbox?.tools?.allow ?? agent?.tools?.allow ?? DEFAULT_TOOL_ALLOW,
      deny:
        agentSandbox?.tools?.deny ?? agent?.tools?.deny ?? DEFAULT_TOOL_DENY,
    },
    prune: resolveSandboxPruneConfig({
      scope,
      globalPrune: agent?.prune,
      agentPrune: agentSandbox?.prune,
    }),
  };
}

function shouldSandboxSession(
  cfg: SandboxConfig,
  sessionKey: string,
  mainKey: string,
) {
  if (cfg.mode === "off") return false;
  if (cfg.mode === "all") return true;
  return sessionKey.trim() !== mainKey.trim();
}

function slugifySessionKey(value: string) {
  const trimmed = value.trim() || "session";
  const hash = crypto
    .createHash("sha1")
    .update(trimmed)
    .digest("hex")
    .slice(0, 8);
  const safe = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = safe.slice(0, 32) || "session";
  return `${base}-${hash}`;
}

function resolveSandboxWorkspaceDir(root: string, sessionKey: string) {
  const resolvedRoot = resolveUserPath(root);
  const slug = slugifySessionKey(sessionKey);
  return path.join(resolvedRoot, slug);
}

async function readRegistry(): Promise<SandboxRegistry> {
  try {
    const raw = await fs.readFile(SANDBOX_REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SandboxRegistry;
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // ignore
  }
  return { entries: [] };
}

async function writeRegistry(registry: SandboxRegistry) {
  await fs.mkdir(SANDBOX_STATE_DIR, { recursive: true });
  await fs.writeFile(
    SANDBOX_REGISTRY_PATH,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
}

async function updateRegistry(entry: SandboxRegistryEntry) {
  const registry = await readRegistry();
  const existing = registry.entries.find(
    (item) => item.containerName === entry.containerName,
  );
  const next = registry.entries.filter(
    (item) => item.containerName !== entry.containerName,
  );
  next.push({
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
  });
  await writeRegistry({ entries: next });
}

async function removeRegistryEntry(containerName: string) {
  const registry = await readRegistry();
  const next = registry.entries.filter(
    (item) => item.containerName !== containerName,
  );
  if (next.length === registry.entries.length) return;
  await writeRegistry({ entries: next });
}

async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  try {
    const raw = await fs.readFile(SANDBOX_BROWSER_REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SandboxBrowserRegistry;
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // ignore
  }
  return { entries: [] };
}

async function writeBrowserRegistry(registry: SandboxBrowserRegistry) {
  await fs.mkdir(SANDBOX_STATE_DIR, { recursive: true });
  await fs.writeFile(
    SANDBOX_BROWSER_REGISTRY_PATH,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
}

async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  const registry = await readBrowserRegistry();
  const existing = registry.entries.find(
    (item) => item.containerName === entry.containerName,
  );
  const next = registry.entries.filter(
    (item) => item.containerName !== entry.containerName,
  );
  next.push({
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
  });
  await writeBrowserRegistry({ entries: next });
}

async function removeBrowserRegistryEntry(containerName: string) {
  const registry = await readBrowserRegistry();
  const next = registry.entries.filter(
    (item) => item.containerName !== containerName,
  );
  if (next.length === registry.entries.length) return;
  await writeBrowserRegistry({ entries: next });
}

function execDocker(args: string[], opts?: { allowFailure?: boolean }) {
  return new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        const exitCode = code ?? 0;
        if (exitCode !== 0 && !opts?.allowFailure) {
          reject(new Error(stderr.trim() || `docker ${args.join(" ")} failed`));
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });
    },
  );
}

async function readDockerPort(containerName: string, port: number) {
  const result = await execDocker(["port", containerName, `${port}/tcp`], {
    allowFailure: true,
  });
  if (result.code !== 0) return null;
  const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  const match = line.match(/:(\d+)\s*$/);
  if (!match) return null;
  const mapped = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(mapped) ? mapped : null;
}

async function dockerImageExists(image: string) {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  return result.code === 0;
}

async function ensureDockerImage(image: string) {
  const exists = await dockerImageExists(image);
  if (exists) return;
  if (image === DEFAULT_SANDBOX_IMAGE) {
    await execDocker(["pull", "debian:bookworm-slim"]);
    await execDocker(["tag", "debian:bookworm-slim", DEFAULT_SANDBOX_IMAGE]);
    return;
  }
  throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
}

async function dockerContainerState(name: string) {
  const result = await execDocker(
    ["inspect", "-f", "{{.State.Running}}", name],
    { allowFailure: true },
  );
  if (result.code !== 0) return { exists: false, running: false };
  return { exists: true, running: result.stdout.trim() === "true" };
}

async function ensureSandboxWorkspace(
  workspaceDir: string,
  seedFrom?: string,
  skipBootstrap?: boolean,
) {
  await fs.mkdir(workspaceDir, { recursive: true });
  if (seedFrom) {
    const seed = resolveUserPath(seedFrom);
    const files = [
      DEFAULT_AGENTS_FILENAME,
      DEFAULT_SOUL_FILENAME,
      DEFAULT_TOOLS_FILENAME,
      DEFAULT_IDENTITY_FILENAME,
      DEFAULT_USER_FILENAME,
      DEFAULT_BOOTSTRAP_FILENAME,
      DEFAULT_HEARTBEAT_FILENAME,
    ];
    for (const name of files) {
      const src = path.join(seed, name);
      const dest = path.join(workspaceDir, name);
      try {
        await fs.access(dest);
      } catch {
        try {
          const content = await fs.readFile(src, "utf-8");
          await fs.writeFile(dest, content, { encoding: "utf-8", flag: "wx" });
        } catch {
          // ignore missing seed file
        }
      }
    }
  }
  await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: !skipBootstrap,
  });
}

function normalizeDockerLimit(value?: string | number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatUlimitValue(
  name: string,
  value: string | number | { soft?: number; hard?: number },
) {
  if (!name.trim()) return null;
  if (typeof value === "number" || typeof value === "string") {
    const raw = String(value).trim();
    return raw ? `${name}=${raw}` : null;
  }
  const soft =
    typeof value.soft === "number" ? Math.max(0, value.soft) : undefined;
  const hard =
    typeof value.hard === "number" ? Math.max(0, value.hard) : undefined;
  if (soft === undefined && hard === undefined) return null;
  if (soft === undefined) return `${name}=${hard}`;
  if (hard === undefined) return `${name}=${soft}`;
  return `${name}=${soft}:${hard}`;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  scopeKey: string;
  createdAtMs?: number;
  labels?: Record<string, string>;
}) {
  const createdAtMs = params.createdAtMs ?? Date.now();
  const args = ["create", "--name", params.name];
  args.push("--label", "clawdbot.sandbox=1");
  args.push("--label", `clawdbot.sessionKey=${params.scopeKey}`);
  args.push("--label", `clawdbot.createdAtMs=${createdAtMs}`);
  for (const [key, value] of Object.entries(params.labels ?? {})) {
    if (key && value) args.push("--label", `${key}=${value}`);
  }
  if (params.cfg.readOnlyRoot) args.push("--read-only");
  for (const entry of params.cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (params.cfg.network) args.push("--network", params.cfg.network);
  if (params.cfg.user) args.push("--user", params.cfg.user);
  for (const cap of params.cfg.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges");
  if (params.cfg.seccompProfile) {
    args.push("--security-opt", `seccomp=${params.cfg.seccompProfile}`);
  }
  if (params.cfg.apparmorProfile) {
    args.push("--security-opt", `apparmor=${params.cfg.apparmorProfile}`);
  }
  for (const entry of params.cfg.dns ?? []) {
    if (entry.trim()) args.push("--dns", entry);
  }
  for (const entry of params.cfg.extraHosts ?? []) {
    if (entry.trim()) args.push("--add-host", entry);
  }
  if (typeof params.cfg.pidsLimit === "number" && params.cfg.pidsLimit > 0) {
    args.push("--pids-limit", String(params.cfg.pidsLimit));
  }
  const memory = normalizeDockerLimit(params.cfg.memory);
  if (memory) args.push("--memory", memory);
  const memorySwap = normalizeDockerLimit(params.cfg.memorySwap);
  if (memorySwap) args.push("--memory-swap", memorySwap);
  if (typeof params.cfg.cpus === "number" && params.cfg.cpus > 0) {
    args.push("--cpus", String(params.cfg.cpus));
  }
  for (const [name, value] of Object.entries(params.cfg.ulimits ?? {})) {
    const formatted = formatUlimitValue(name, value);
    if (formatted) args.push("--ulimit", formatted);
  }
  return args;
}

async function createSandboxContainer(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  scopeKey: string;
}) {
  const { name, cfg, workspaceDir, scopeKey } = params;
  await ensureDockerImage(cfg.image);

  const args = buildSandboxCreateArgs({
    name,
    cfg,
    scopeKey,
  });
  args.push("--workdir", cfg.workdir);
  const mainMountSuffix =
    params.workspaceAccess === "ro" && workspaceDir === params.agentWorkspaceDir
      ? ":ro"
      : "";
  args.push("-v", `${workspaceDir}:${cfg.workdir}${mainMountSuffix}`);
  if (
    params.workspaceAccess !== "none" &&
    workspaceDir !== params.agentWorkspaceDir
  ) {
    const agentMountSuffix = params.workspaceAccess === "ro" ? ":ro" : "";
    args.push(
      "-v",
      `${params.agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentMountSuffix}`,
    );
  }
  args.push(cfg.image, "sleep", "infinity");

  await execDocker(args);
  await execDocker(["start", name]);

  if (cfg.setupCommand?.trim()) {
    await execDocker(["exec", "-i", name, "sh", "-lc", cfg.setupCommand]);
  }
}

async function ensureSandboxContainer(params: {
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
}) {
  const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
  const slug =
    params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  const name = `${params.cfg.docker.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const state = await dockerContainerState(containerName);
  if (!state.exists) {
    await createSandboxContainer({
      name: containerName,
      cfg: params.cfg.docker,
      workspaceDir: params.workspaceDir,
      workspaceAccess: params.cfg.workspaceAccess,
      agentWorkspaceDir: params.agentWorkspaceDir,
      scopeKey,
    });
  } else if (!state.running) {
    await execDocker(["start", containerName]);
  }
  const now = Date.now();
  await updateRegistry({
    containerName,
    sessionKey: scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
  });
  return containerName;
}

async function ensureSandboxBrowserImage(image: string) {
  const exists = await dockerImageExists(image);
  if (exists) return;
  throw new Error(
    `Sandbox browser image not found: ${image}. Build it with scripts/sandbox-browser-setup.sh.`,
  );
}

function buildSandboxBrowserResolvedConfig(params: {
  controlPort: number;
  cdpPort: number;
  headless: boolean;
}): ResolvedBrowserConfig {
  const controlHost = "127.0.0.1";
  const controlUrl = `http://${controlHost}:${params.controlPort}`;
  const cdpHost = "127.0.0.1";
  return {
    enabled: true,
    controlUrl,
    controlHost,
    controlPort: params.controlPort,
    cdpProtocol: "http",
    cdpHost,
    cdpIsLoopback: true,
    color: DEFAULT_CLAWD_BROWSER_COLOR,
    executablePath: undefined,
    headless: params.headless,
    noSandbox: false,
    attachOnly: true,
    defaultProfile: "clawd",
    profiles: {
      clawd: { cdpPort: params.cdpPort, color: DEFAULT_CLAWD_BROWSER_COLOR },
    },
  };
}

async function ensureSandboxBrowser(params: {
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
}): Promise<SandboxBrowserContext | null> {
  if (!params.cfg.browser.enabled) return null;
  if (!isToolAllowed(params.cfg.tools, "browser")) return null;

  const slug =
    params.cfg.scope === "shared"
      ? "shared"
      : slugifySessionKey(params.scopeKey);
  const name = `${params.cfg.browser.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const state = await dockerContainerState(containerName);
  if (!state.exists) {
    await ensureSandboxBrowserImage(params.cfg.browser.image);
    const args = buildSandboxCreateArgs({
      name: containerName,
      cfg: params.cfg.docker,
      scopeKey: params.scopeKey,
      labels: { "clawdbot.sandboxBrowser": "1" },
    });
    const mainMountSuffix =
      params.cfg.workspaceAccess === "ro" &&
      params.workspaceDir === params.agentWorkspaceDir
        ? ":ro"
        : "";
    args.push(
      "-v",
      `${params.workspaceDir}:${params.cfg.docker.workdir}${mainMountSuffix}`,
    );
    if (
      params.cfg.workspaceAccess !== "none" &&
      params.workspaceDir !== params.agentWorkspaceDir
    ) {
      const agentMountSuffix = params.cfg.workspaceAccess === "ro" ? ":ro" : "";
      args.push(
        "-v",
        `${params.agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentMountSuffix}`,
      );
    }
    args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
    if (params.cfg.browser.enableNoVnc && !params.cfg.browser.headless) {
      args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
    }
    args.push(
      "-e",
      `CLAWDBOT_BROWSER_HEADLESS=${params.cfg.browser.headless ? "1" : "0"}`,
    );
    args.push(
      "-e",
      `CLAWDBOT_BROWSER_ENABLE_NOVNC=${
        params.cfg.browser.enableNoVnc ? "1" : "0"
      }`,
    );
    args.push("-e", `CLAWDBOT_BROWSER_CDP_PORT=${params.cfg.browser.cdpPort}`);
    args.push("-e", `CLAWDBOT_BROWSER_VNC_PORT=${params.cfg.browser.vncPort}`);
    args.push(
      "-e",
      `CLAWDBOT_BROWSER_NOVNC_PORT=${params.cfg.browser.noVncPort}`,
    );
    args.push(params.cfg.browser.image);
    await execDocker(args);
    await execDocker(["start", containerName]);
  } else if (!state.running) {
    await execDocker(["start", containerName]);
  }

  const mappedCdp = await readDockerPort(
    containerName,
    params.cfg.browser.cdpPort,
  );
  if (!mappedCdp) {
    throw new Error(`Failed to resolve CDP port mapping for ${containerName}.`);
  }

  const mappedNoVnc =
    params.cfg.browser.enableNoVnc && !params.cfg.browser.headless
      ? await readDockerPort(containerName, params.cfg.browser.noVncPort)
      : null;

  const existing = BROWSER_BRIDGES.get(params.scopeKey);
  const existingProfile = existing
    ? resolveProfile(existing.bridge.state.resolved, "clawd")
    : null;
  const shouldReuse =
    existing &&
    existing.containerName === containerName &&
    existingProfile?.cdpPort === mappedCdp;
  if (existing && !shouldReuse) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(
      () => undefined,
    );
    BROWSER_BRIDGES.delete(params.scopeKey);
  }
  let bridge: BrowserBridge;
  if (shouldReuse && existing) {
    bridge = existing.bridge;
  } else {
    bridge = await startBrowserBridgeServer({
      resolved: buildSandboxBrowserResolvedConfig({
        controlPort: 0,
        cdpPort: mappedCdp,
        headless: params.cfg.browser.headless,
      }),
    });
  }
  if (!shouldReuse) {
    BROWSER_BRIDGES.set(params.scopeKey, { bridge, containerName });
  }

  const now = Date.now();
  await updateBrowserRegistry({
    containerName,
    sessionKey: params.scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.browser.image,
    cdpPort: mappedCdp,
    noVncPort: mappedNoVnc ?? undefined,
  });

  const noVncUrl =
    mappedNoVnc &&
    params.cfg.browser.enableNoVnc &&
    !params.cfg.browser.headless
      ? `http://127.0.0.1:${mappedNoVnc}/vnc.html?autoconnect=1&resize=remote`
      : undefined;

  return {
    controlUrl: bridge.baseUrl,
    noVncUrl,
    containerName,
  };
}

async function pruneSandboxContainers(cfg: SandboxConfig) {
  const now = Date.now();
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) return;
  const registry = await readRegistry();
  for (const entry of registry.entries) {
    const idleMs = now - entry.lastUsedAtMs;
    const ageMs = now - entry.createdAtMs;
    if (
      (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
      (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
    ) {
      try {
        await execDocker(["rm", "-f", entry.containerName], {
          allowFailure: true,
        });
      } catch {
        // ignore prune failures
      } finally {
        await removeRegistryEntry(entry.containerName);
      }
    }
  }
}

async function pruneSandboxBrowsers(cfg: SandboxConfig) {
  const now = Date.now();
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) return;
  const registry = await readBrowserRegistry();
  for (const entry of registry.entries) {
    const idleMs = now - entry.lastUsedAtMs;
    const ageMs = now - entry.createdAtMs;
    if (
      (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
      (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
    ) {
      try {
        await execDocker(["rm", "-f", entry.containerName], {
          allowFailure: true,
        });
      } catch {
        // ignore prune failures
      } finally {
        await removeBrowserRegistryEntry(entry.containerName);
        const bridge = BROWSER_BRIDGES.get(entry.sessionKey);
        if (bridge?.containerName === entry.containerName) {
          await stopBrowserBridgeServer(bridge.bridge.server).catch(
            () => undefined,
          );
          BROWSER_BRIDGES.delete(entry.sessionKey);
        }
      }
    }
  }
}

async function maybePruneSandboxes(cfg: SandboxConfig) {
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) return;
  lastPruneAtMs = now;
  try {
    await pruneSandboxContainers(cfg);
    await pruneSandboxBrowsers(cfg);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    defaultRuntime.error?.(
      `Sandbox prune failed: ${message ?? "unknown error"}`,
    );
  }
}

export async function resolveSandboxContext(params: {
  config?: ClawdbotConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) return null;
  const agentId = resolveAgentIdFromSessionKey(rawSessionKey);
  const cfg = resolveSandboxConfigForAgent(params.config, agentId);
  const mainKey = params.config?.session?.mainKey?.trim() || "main";
  if (!shouldSandboxSession(cfg, rawSessionKey, mainKey)) return null;

  await maybePruneSandboxes(cfg);

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared"
      ? workspaceRoot
      : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir =
    cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;
  if (workspaceDir === sandboxWorkspaceDir) {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agent?.skipBootstrap,
    );
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  const containerName = await ensureSandboxContainer({
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg,
  });

  const browser = await ensureSandboxBrowser({
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg,
  });

  return {
    enabled: true,
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    workspaceAccess: cfg.workspaceAccess,
    containerName,
    containerWorkdir: cfg.docker.workdir,
    docker: cfg.docker,
    tools: cfg.tools,
    browser: browser ?? undefined,
  };
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: ClawdbotConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) return null;
  const agentId = resolveAgentIdFromSessionKey(rawSessionKey);
  const cfg = resolveSandboxConfigForAgent(params.config, agentId);
  const mainKey = params.config?.session?.mainKey?.trim() || "main";
  if (!shouldSandboxSession(cfg, rawSessionKey, mainKey)) return null;

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared"
      ? workspaceRoot
      : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir =
    cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;
  if (workspaceDir === sandboxWorkspaceDir) {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agent?.skipBootstrap,
    );
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  return {
    workspaceDir,
    containerWorkdir: cfg.docker.workdir,
  };
}
