import type { MoltbotConfig } from "../../config/config.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
  DEFAULT_SANDBOX_BROWSER_CDP_PORT,
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
  DEFAULT_SANDBOX_BROWSER_PREFIX,
  DEFAULT_SANDBOX_BROWSER_VNC_PORT,
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IDLE_HOURS,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_MAX_AGE_DAYS,
  DEFAULT_SANDBOX_WORKDIR,
  DEFAULT_SANDBOX_WORKSPACE_ROOT,
} from "./constants.js";
import { resolveSandboxToolPolicyForAgent } from "./tool-policy.js";
import type {
  SandboxBrowserConfig,
  SandboxConfig,
  SandboxDockerConfig,
  SandboxPruneConfig,
  SandboxScope,
} from "./types.js";

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
  const agentDocker = params.scope === "shared" ? undefined : params.agentDocker;
  const globalDocker = params.globalDocker;

  const env = agentDocker?.env
    ? { ...(globalDocker?.env ?? { LANG: "C.UTF-8" }), ...agentDocker.env }
    : (globalDocker?.env ?? { LANG: "C.UTF-8" });

  const ulimits = agentDocker?.ulimits
    ? { ...globalDocker?.ulimits, ...agentDocker.ulimits }
    : globalDocker?.ulimits;

  const binds = [...(globalDocker?.binds ?? []), ...(agentDocker?.binds ?? [])];

  return {
    image: agentDocker?.image ?? globalDocker?.image ?? DEFAULT_SANDBOX_IMAGE,
    containerPrefix:
      agentDocker?.containerPrefix ??
      globalDocker?.containerPrefix ??
      DEFAULT_SANDBOX_CONTAINER_PREFIX,
    workdir: agentDocker?.workdir ?? globalDocker?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
    readOnlyRoot: agentDocker?.readOnlyRoot ?? globalDocker?.readOnlyRoot ?? true,
    tmpfs: agentDocker?.tmpfs ?? globalDocker?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
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
    apparmorProfile: agentDocker?.apparmorProfile ?? globalDocker?.apparmorProfile,
    dns: agentDocker?.dns ?? globalDocker?.dns,
    extraHosts: agentDocker?.extraHosts ?? globalDocker?.extraHosts,
    binds: binds.length ? binds : undefined,
  };
}

export function resolveSandboxBrowserConfig(params: {
  scope: SandboxScope;
  globalBrowser?: Partial<SandboxBrowserConfig>;
  agentBrowser?: Partial<SandboxBrowserConfig>;
}): SandboxBrowserConfig {
  const agentBrowser = params.scope === "shared" ? undefined : params.agentBrowser;
  const globalBrowser = params.globalBrowser;
  return {
    enabled: agentBrowser?.enabled ?? globalBrowser?.enabled ?? false,
    image: agentBrowser?.image ?? globalBrowser?.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE,
    containerPrefix:
      agentBrowser?.containerPrefix ??
      globalBrowser?.containerPrefix ??
      DEFAULT_SANDBOX_BROWSER_PREFIX,
    cdpPort: agentBrowser?.cdpPort ?? globalBrowser?.cdpPort ?? DEFAULT_SANDBOX_BROWSER_CDP_PORT,
    vncPort: agentBrowser?.vncPort ?? globalBrowser?.vncPort ?? DEFAULT_SANDBOX_BROWSER_VNC_PORT,
    noVncPort:
      agentBrowser?.noVncPort ?? globalBrowser?.noVncPort ?? DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
    headless: agentBrowser?.headless ?? globalBrowser?.headless ?? false,
    enableNoVnc: agentBrowser?.enableNoVnc ?? globalBrowser?.enableNoVnc ?? true,
    allowHostControl: agentBrowser?.allowHostControl ?? globalBrowser?.allowHostControl ?? false,
    autoStart: agentBrowser?.autoStart ?? globalBrowser?.autoStart ?? true,
    autoStartTimeoutMs:
      agentBrowser?.autoStartTimeoutMs ??
      globalBrowser?.autoStartTimeoutMs ??
      DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
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
    idleHours: agentPrune?.idleHours ?? globalPrune?.idleHours ?? DEFAULT_SANDBOX_IDLE_HOURS,
    maxAgeDays: agentPrune?.maxAgeDays ?? globalPrune?.maxAgeDays ?? DEFAULT_SANDBOX_MAX_AGE_DAYS,
  };
}

export function resolveSandboxConfigForAgent(cfg?: MoltbotConfig, agentId?: string): SandboxConfig {
  const agent = cfg?.agents?.defaults?.sandbox;

  // Agent-specific sandbox config overrides global
  let agentSandbox: typeof agent | undefined;
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  if (agentConfig?.sandbox) {
    agentSandbox = agentConfig.sandbox;
  }

  const scope = resolveSandboxScope({
    scope: agentSandbox?.scope ?? agent?.scope,
    perSession: agentSandbox?.perSession ?? agent?.perSession,
  });

  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, agentId);

  return {
    mode: agentSandbox?.mode ?? agent?.mode ?? "off",
    scope,
    workspaceAccess: agentSandbox?.workspaceAccess ?? agent?.workspaceAccess ?? "none",
    workspaceRoot:
      agentSandbox?.workspaceRoot ?? agent?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
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
      allow: toolPolicy.allow,
      deny: toolPolicy.deny,
    },
    prune: resolveSandboxPruneConfig({
      scope,
      globalPrune: agent?.prune,
      agentPrune: agentSandbox?.prune,
    }),
  };
}
