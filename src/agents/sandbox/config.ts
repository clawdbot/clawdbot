import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SandboxSshSettings } from "../../config/types.sandbox.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
  DEFAULT_SANDBOX_BROWSER_CDP_PORT,
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_BROWSER_NETWORK,
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
  SandboxSshConfig,
} from "./types.js";

export const DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS = [
  "dangerouslyAllowReservedContainerTargets",
  "dangerouslyAllowExternalBindSources",
  "dangerouslyAllowContainerNamespaceJoin",
] as const;

const DEFAULT_SANDBOX_SSH_COMMAND = "ssh";
const DEFAULT_SANDBOX_SSH_WORKSPACE_ROOT = "/tmp/openclaw-sandboxes";

type DangerousSandboxDockerBooleanKey = (typeof DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS)[number];
type DangerousSandboxDockerBooleans = Pick<SandboxDockerConfig, DangerousSandboxDockerBooleanKey>;

function resolveDangerousSandboxDockerBooleans(
  agentDocker?: Partial<SandboxDockerConfig>,
  globalDocker?: Partial<SandboxDockerConfig>,
): DangerousSandboxDockerBooleans {
  const resolved = {} as DangerousSandboxDockerBooleans;
  for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
    resolved[key] = agentDocker?.[key] ?? globalDocker?.[key];
  }
  return resolved;
}

export function resolveSandboxBrowserDockerCreateConfig(params: {
  docker: SandboxDockerConfig;
  browser: SandboxBrowserConfig;
}): SandboxDockerConfig {
  const browserNetwork = params.browser.network.trim();
  const base: SandboxDockerConfig = {
    ...params.docker,
    // Browser container needs network access for Chrome, downloads, etc.
    network: browserNetwork || DEFAULT_SANDBOX_BROWSER_NETWORK,
    // For hashing and consistency, treat browser image as the docker image even though we
    // pass it separately as the final `docker create` argument.
    image: params.browser.image,
  };
  return params.browser.binds !== undefined ? { ...base, binds: params.browser.binds } : base;
}

export function resolveSandboxScope(params: {
  scope?: SandboxScope;
  perSession?: boolean;
}): SandboxScope {
  if (params.scope) {
    return params.scope;
  }
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
    ...resolveDangerousSandboxDockerBooleans(agentDocker, globalDocker),
  };
}

export function resolveSandboxBrowserConfig(params: {
  scope: SandboxScope;
  globalBrowser?: Partial<SandboxBrowserConfig>;
  agentBrowser?: Partial<SandboxBrowserConfig>;
}): SandboxBrowserConfig {
  const agentBrowser = params.scope === "shared" ? undefined : params.agentBrowser;
  const globalBrowser = params.globalBrowser;
  const binds = [...(globalBrowser?.binds ?? []), ...(agentBrowser?.binds ?? [])];
  // Treat `binds: []` as an explicit override, so it can disable `docker.binds` for the browser container.
  const bindsConfigured = globalBrowser?.binds !== undefined || agentBrowser?.binds !== undefined;
  return {
    enabled: agentBrowser?.enabled ?? globalBrowser?.enabled ?? false,
    image: agentBrowser?.image ?? globalBrowser?.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE,
    containerPrefix:
      agentBrowser?.containerPrefix ??
      globalBrowser?.containerPrefix ??
      DEFAULT_SANDBOX_BROWSER_PREFIX,
    network: agentBrowser?.network ?? globalBrowser?.network ?? DEFAULT_SANDBOX_BROWSER_NETWORK,
    cdpPort: agentBrowser?.cdpPort ?? globalBrowser?.cdpPort ?? DEFAULT_SANDBOX_BROWSER_CDP_PORT,
    cdpSourceRange: agentBrowser?.cdpSourceRange ?? globalBrowser?.cdpSourceRange,
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
    binds: bindsConfigured ? binds : undefined,
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

function normalizeRemoteRoot(value: string | undefined, fallback: string): string {
  const normalized = normalizeOptionalString(value) ?? fallback;
  const posix = normalized.replaceAll("\\", "/");
  if (!posix.startsWith("/")) {
    throw new Error(`Sandbox SSH workspaceRoot must be an absolute POSIX path: ${normalized}`);
  }
  return posix.replace(/\/+$/g, "") || "/";
}

export function resolveSandboxSshConfig(params: {
  scope: SandboxScope;
  globalSsh?: Partial<SandboxSshSettings>;
  agentSsh?: Partial<SandboxSshSettings>;
}): SandboxSshConfig {
  const agentSsh = params.scope === "shared" ? undefined : params.agentSsh;
  const globalSsh = params.globalSsh;
  return {
    target: normalizeOptionalString(agentSsh?.target ?? globalSsh?.target),
    command:
      normalizeOptionalString(agentSsh?.command ?? globalSsh?.command) ??
      DEFAULT_SANDBOX_SSH_COMMAND,
    workspaceRoot: normalizeRemoteRoot(
      agentSsh?.workspaceRoot ?? globalSsh?.workspaceRoot,
      DEFAULT_SANDBOX_SSH_WORKSPACE_ROOT,
    ),
    strictHostKeyChecking:
      agentSsh?.strictHostKeyChecking ?? globalSsh?.strictHostKeyChecking ?? true,
    updateHostKeys: agentSsh?.updateHostKeys ?? globalSsh?.updateHostKeys ?? true,
    identityFile: normalizeOptionalString(agentSsh?.identityFile ?? globalSsh?.identityFile),
    certificateFile: normalizeOptionalString(
      agentSsh?.certificateFile ?? globalSsh?.certificateFile,
    ),
    knownHostsFile: normalizeOptionalString(agentSsh?.knownHostsFile ?? globalSsh?.knownHostsFile),
    identityData: normalizeSecretInputString(agentSsh?.identityData ?? globalSsh?.identityData),
    certificateData: normalizeSecretInputString(
      agentSsh?.certificateData ?? globalSsh?.certificateData,
    ),
    knownHostsData: normalizeSecretInputString(
      agentSsh?.knownHostsData ?? globalSsh?.knownHostsData,
    ),
  };
}

export function resolveSandboxConfigForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
): SandboxConfig {
  const agent = cfg?.agents?.defaults?.sandbox;

  // Agent-specific sandbox config overrides global
  let agentSandbox: typeof agent | undefined;
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  if (agentConfig?.sandbox) {
    agentSandbox = agentConfig.sandbox;
  }
  const legacyAgentSandbox = agentSandbox as
    | (typeof agentSandbox & { perSession?: boolean })
    | undefined;
  const legacyDefaultSandbox = agent as (typeof agent & { perSession?: boolean }) | undefined;

  const scope = resolveSandboxScope({
    scope: agentSandbox?.scope ?? agent?.scope,
    perSession: legacyAgentSandbox?.perSession ?? legacyDefaultSandbox?.perSession,
  });

  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, agentId);

  return {
    mode: agentSandbox?.mode ?? agent?.mode ?? "off",
    backend: agentSandbox?.backend?.trim() || agent?.backend?.trim() || "docker",
    scope,
    workspaceAccess: agentSandbox?.workspaceAccess ?? agent?.workspaceAccess ?? "none",
    workspaceRoot:
      agentSandbox?.workspaceRoot ?? agent?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
    docker: resolveSandboxDockerConfig({
      scope,
      globalDocker: agent?.docker,
      agentDocker: agentSandbox?.docker,
    }),
    ssh: resolveSandboxSshConfig({
      scope,
      globalSsh: agent?.ssh,
      agentSsh: agentSandbox?.ssh,
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
