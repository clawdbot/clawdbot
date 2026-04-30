import crypto from "node:crypto";
import { deriveDefaultBrowserCdpPortRange } from "../../config/port-defaults.js";
import { isSameSsrFPolicy, type SsrFPolicy } from "../../infra/net/ssrf.js";
import {
  startBrowserBridgeServer,
  stopBrowserBridgeServer,
} from "../../plugin-sdk/browser-bridge.js";
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
  resolveProfile,
  type ResolvedBrowserConfig,
} from "../../plugin-sdk/browser-profiles.js";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { computeSandboxBrowserConfigHash } from "./config-hash.js";
import { resolveSandboxBrowserDockerCreateConfig } from "./config.js";
import { DEFAULT_SANDBOX_BROWSER_IMAGE, SANDBOX_BROWSER_SECURITY_HASH_EPOCH } from "./constants.js";
import {
  buildSandboxCreateArgs,
  dockerContainerState,
  execDocker,
  formatDockerDaemonUnavailableError,
  isDockerDaemonUnavailable,
  readDockerContainerEnvVar,
  readDockerContainerLabel,
  readDockerNetworkDriver,
  readDockerNetworkGateway,
  readDockerPort,
} from "./docker.js";
import {
  buildNoVncObserverTokenUrl,
  consumeNoVncObserverToken,
  generateNoVncPassword,
  isNoVncEnabled,
  NOVNC_PASSWORD_ENV_KEY,
  issueNoVncObserverToken,
} from "./novnc-auth.js";
import { readBrowserRegistry, updateBrowserRegistry } from "./registry.js";
import { resolveSandboxAgentId, slugifySessionKey } from "./shared.js";
import { isToolAllowed } from "./tool-policy.js";
import type { SandboxBrowserContext, SandboxConfig } from "./types.js";
import { validateNetworkMode } from "./validate-sandbox-security.js";
import { appendWorkspaceMountArgs, SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

const HOT_BROWSER_WINDOW_MS = 5 * 60 * 1000;
const CDP_SOURCE_RANGE_ENV_KEY = "OPENCLAW_BROWSER_CDP_SOURCE_RANGE";

async function waitForSandboxCdp(params: { cdpPort: number; timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, params.timeoutMs);
  const url = `http://127.0.0.1:${params.cdpPort}/json/version`;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(ctrl.abort.bind(ctrl), 1000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.ok) {
          return true;
        }
      } finally {
        clearTimeout(t);
      }
    } catch {
      // ignore
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await new Promise((r) => setTimeout(r, Math.min(150, remainingMs)));
  }
  return false;
}

function buildSandboxBrowserResolvedConfig(params: {
  controlPort: number;
  cdpPort: number;
  headless: boolean;
  evaluateEnabled: boolean;
  ssrfPolicy?: SsrFPolicy;
}): ResolvedBrowserConfig {
  const cdpHost = "127.0.0.1";
  const cdpPortRange = deriveDefaultBrowserCdpPortRange(params.controlPort);
  return {
    enabled: true,
    evaluateEnabled: params.evaluateEnabled,
    controlPort: params.controlPort,
    cdpProtocol: "http",
    cdpHost,
    cdpIsLoopback: true,
    cdpPortRangeStart: cdpPortRange.start,
    cdpPortRangeEnd: cdpPortRange.end,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    localLaunchTimeoutMs: 15_000,
    localCdpReadyTimeoutMs: 8_000,
    actionTimeoutMs: DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    color: DEFAULT_OPENCLAW_BROWSER_COLOR,
    executablePath: undefined,
    headless: params.headless,
    noSandbox: false,
    attachOnly: true,
    defaultProfile: DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
    extraArgs: [],
    tabCleanup: {
      enabled: true,
      idleMinutes: 120,
      maxTabsPerSession: 8,
      sweepMinutes: 5,
    },
    profiles: {
      [DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]: {
        cdpPort: params.cdpPort,
        color: DEFAULT_OPENCLAW_BROWSER_COLOR,
      },
    },
    ssrfPolicy: params.ssrfPolicy,
  };
}

async function ensureSandboxBrowserImage(image: string) {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return;
  }
  const stderr = result.stderr.trim();
  if (isDockerDaemonUnavailable(stderr)) {
    throw new Error(formatDockerDaemonUnavailableError(stderr));
  }
  throw new Error(
    `Sandbox browser image not found: ${image}. Build it with scripts/sandbox-browser-setup.sh.`,
  );
}

async function ensureDockerNetwork(
  network: string,
  opts?: { allowContainerNamespaceJoin?: boolean },
) {
  validateNetworkMode(network, {
    allowContainerNamespaceJoin: opts?.allowContainerNamespaceJoin === true,
  });
  const normalized = normalizeOptionalLowercaseString(network) ?? "";
  if (!normalized || normalized === "bridge" || normalized === "none") {
    return;
  }
  const inspect = await execDocker(["network", "inspect", network], { allowFailure: true });
  if (inspect.code === 0) {
    return;
  }
  await execDocker(["network", "create", "--driver", "bridge", network]);
}

export async function ensureSandboxBrowser(params: {
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
  evaluateEnabled?: boolean;
  bridgeAuth?: { token?: string; password?: string };
  ssrfPolicy?: SsrFPolicy;
}): Promise<SandboxBrowserContext | null> {
  if (!params.cfg.browser.enabled) {
    return null;
  }
  if (!isToolAllowed(params.cfg.tools, "browser")) {
    return null;
  }

  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
  const name = `${params.cfg.browser.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const state = await dockerContainerState(containerName);
  const browserImage = params.cfg.browser.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE;
  const cdpSourceRange = normalizeOptionalString(params.cfg.browser.cdpSourceRange);
  const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig({
    docker: params.cfg.docker,
    browser: { ...params.cfg.browser, image: browserImage },
  });
  const expectedHash = computeSandboxBrowserConfigHash({
    docker: browserDockerCfg,
    browser: {
      cdpPort: params.cfg.browser.cdpPort,
      vncPort: params.cfg.browser.vncPort,
      noVncPort: params.cfg.browser.noVncPort,
      headless: params.cfg.browser.headless,
      enableNoVnc: params.cfg.browser.enableNoVnc,
      autoStartTimeoutMs: params.cfg.browser.autoStartTimeoutMs,
      cdpSourceRange,
    },
    securityEpoch: SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
  });

  const now = Date.now();
  let hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  const noVncEnabled = isNoVncEnabled(params.cfg.browser);
  let noVncPassword: string | undefined;

  if (hasContainer) {
    if (noVncEnabled) {
      noVncPassword =
        (await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY)) ?? undefined;
    }
    const registry = await readBrowserRegistry();
    const registryEntry = registry.entries.find((entry) => entry.containerName === containerName);
    currentHash = await readDockerContainerLabel(containerName, "openclaw.configHash");
    hashMismatch = !currentHash || currentHash !== expectedHash;
    if (!currentHash) {
      currentHash = registryEntry?.configHash ?? null;
      hashMismatch = !currentHash || currentHash !== expectedHash;
    }
    if (hashMismatch) {
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_BROWSER_WINDOW_MS);
      if (isHot) {
        const hint = (() => {
          if (params.cfg.scope === "session") {
            return `openclaw sandbox recreate --browser --session ${params.scopeKey}`;
          }
          if (params.cfg.scope === "agent") {
            const agentId = resolveSandboxAgentId(params.scopeKey) ?? "main";
            return `openclaw sandbox recreate --browser --agent ${agentId}`;
          }
          return "openclaw sandbox recreate --browser --all";
        })();
        defaultRuntime.log(
          `Sandbox browser config changed for ${containerName} (recently used). Recreate to apply: ${hint}`,
        );
      } else {
        await execDocker(["rm", "-f", containerName], { allowFailure: true });
        hasContainer = false;
        running = false;
      }
    }
  }

  if (!hasContainer) {
    if (noVncEnabled) {
      noVncPassword = generateNoVncPassword();
    }
    await ensureDockerNetwork(browserDockerCfg.network, {
      allowContainerNamespaceJoin: browserDockerCfg.dangerouslyAllowContainerNamespaceJoin === true,
    });
    await ensureSandboxBrowserImage(browserImage);
    // Derive effective CDP source range: explicit config > Docker network gateway > fail-closed.
    // Only IPv4 gateways are usable for auto-derivation because the CDP relay
    // binds on 0.0.0.0 (IPv4); an IPv6 CIDR would cause an address-family mismatch.
    let effectiveCdpSourceRange = cdpSourceRange;
    if (!effectiveCdpSourceRange) {
      // Only auto-derive from gateway for bridge-style networks where inbound
      // CDP traffic reliably comes from the Docker gateway IP. Non-bridge drivers
      // (macvlan, ipvlan, overlay, etc.) may route traffic from other source IPs,
      // so they require explicit cdpSourceRange config.
      const driver = await readDockerNetworkDriver(browserDockerCfg.network);
      const isBridgeLike = !driver || driver === "bridge";
      if (isBridgeLike) {
        const gateway = await readDockerNetworkGateway(browserDockerCfg.network);
        if (gateway && !gateway.includes(":")) {
          effectiveCdpSourceRange = `${gateway}/32`;
        }
      }
    }
    // network="none" has no IPAM gateway by design and no peer container risk;
    // use loopback range so the socat CDP relay still starts.
    if (!effectiveCdpSourceRange && browserDockerCfg.network.trim().toLowerCase() === "none") {
      effectiveCdpSourceRange = "127.0.0.1/32";
    }
    if (!effectiveCdpSourceRange) {
      throw new Error(
        `Cannot derive CDP source range for sandbox browser on network "${browserDockerCfg.network}". ` +
          `Set agents.defaults.sandbox.browser.cdpSourceRange explicitly.`,
      );
    }
    const args = buildSandboxCreateArgs({
      name: containerName,
      cfg: browserDockerCfg,
      scopeKey: params.scopeKey,
      labels: {
        "openclaw.sandboxBrowser": "1",
        "openclaw.browserConfigEpoch": SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
      },
      configHash: expectedHash,
      includeBinds: false,
      bindSourceRoots: [params.workspaceDir, params.agentWorkspaceDir],
    });
    appendWorkspaceMountArgs({
      args,
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir,
      workdir: params.cfg.docker.workdir,
      workspaceAccess: params.cfg.workspaceAccess,
    });
    if (browserDockerCfg.binds?.length) {
      for (const bind of browserDockerCfg.binds) {
        args.push("-v", bind);
      }
    }
    args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
    if (noVncEnabled) {
      args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
    }
    args.push("-e", `OPENCLAW_BROWSER_HEADLESS=${params.cfg.browser.headless ? "1" : "0"}`);
    args.push("-e", `OPENCLAW_BROWSER_ENABLE_NOVNC=${params.cfg.browser.enableNoVnc ? "1" : "0"}`);
    args.push("-e", `OPENCLAW_BROWSER_CDP_PORT=${params.cfg.browser.cdpPort}`);
    args.push(
      "-e",
      `OPENCLAW_BROWSER_AUTO_START_TIMEOUT_MS=${params.cfg.browser.autoStartTimeoutMs}`,
    );
    if (effectiveCdpSourceRange) {
      args.push("-e", `${CDP_SOURCE_RANGE_ENV_KEY}=${effectiveCdpSourceRange}`);
    }
    args.push("-e", `OPENCLAW_BROWSER_VNC_PORT=${params.cfg.browser.vncPort}`);
    args.push("-e", `OPENCLAW_BROWSER_NOVNC_PORT=${params.cfg.browser.noVncPort}`);
    args.push("-e", "OPENCLAW_BROWSER_NO_SANDBOX=1");
    if (noVncEnabled && noVncPassword) {
      args.push("-e", `${NOVNC_PASSWORD_ENV_KEY}=${noVncPassword}`);
    }
    args.push(browserImage);
    await execDocker(args);
    await execDocker(["start", containerName]);
  } else if (!running) {
    await execDocker(["start", containerName]);
  }

  const mappedCdp = await readDockerPort(containerName, params.cfg.browser.cdpPort);
  if (!mappedCdp) {
    throw new Error(`Failed to resolve CDP port mapping for ${containerName}.`);
  }

  const mappedNoVnc = noVncEnabled
    ? await readDockerPort(containerName, params.cfg.browser.noVncPort)
    : null;
  if (noVncEnabled && !noVncPassword) {
    noVncPassword =
      (await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY)) ?? undefined;
  }

  const existing = BROWSER_BRIDGES.get(params.scopeKey);
  const existingProfile = existing
    ? resolveProfile(existing.bridge.state.resolved, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME)
    : null;

  let desiredAuthToken = normalizeOptionalString(params.bridgeAuth?.token);
  let desiredAuthPassword = normalizeOptionalString(params.bridgeAuth?.password);
  if (!desiredAuthToken && !desiredAuthPassword) {
    desiredAuthToken = existing?.authToken;
    desiredAuthPassword = existing?.authPassword;
    if (!desiredAuthToken && !desiredAuthPassword) {
      desiredAuthToken = crypto.randomBytes(24).toString("hex");
    }
  }

  const shouldReuse =
    existing && existing.containerName === containerName && existingProfile?.cdpPort === mappedCdp;
  const policyMatches =
    !existing || isSameSsrFPolicy(existing.bridge.state.resolved.ssrfPolicy, params.ssrfPolicy);
  const authMatches =
    !existing ||
    (existing.authToken === desiredAuthToken && existing.authPassword === desiredAuthPassword);
  if (existing && !shouldReuse) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(() => undefined);
    BROWSER_BRIDGES.delete(params.scopeKey);
  }
  if (existing && shouldReuse && (!policyMatches || !authMatches)) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(() => undefined);
    BROWSER_BRIDGES.delete(params.scopeKey);
  }

  const bridge = (() => {
    if (shouldReuse && policyMatches && authMatches && existing) {
      return existing.bridge;
    }
    return null;
  })();

  const ensureBridge = async () => {
    if (bridge) {
      return bridge;
    }

    const onEnsureAttachTarget = params.cfg.browser.autoStart
      ? async () => {
          const currentState = await dockerContainerState(containerName);
          if (currentState.exists && !currentState.running) {
            await execDocker(["start", containerName]);
          }
          const ok = await waitForSandboxCdp({
            cdpPort: mappedCdp,
            timeoutMs: params.cfg.browser.autoStartTimeoutMs,
          });
          if (!ok) {
            await execDocker(["rm", "-f", containerName], { allowFailure: true });
            throw new Error(
              `Sandbox browser CDP did not become reachable on 127.0.0.1:${mappedCdp} within ${params.cfg.browser.autoStartTimeoutMs}ms. The hung container has been forcefully removed.`,
            );
          }
        }
      : undefined;

    return await startBrowserBridgeServer({
      resolved: buildSandboxBrowserResolvedConfig({
        controlPort: 0,
        cdpPort: mappedCdp,
        headless: params.cfg.browser.headless,
        evaluateEnabled: params.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED,
        ssrfPolicy: params.ssrfPolicy,
      }),
      authToken: desiredAuthToken,
      authPassword: desiredAuthPassword,
      onEnsureAttachTarget,
      resolveSandboxNoVncToken: consumeNoVncObserverToken,
    });
  };

  const resolvedBridge = await ensureBridge();
  if (!shouldReuse || !policyMatches || !authMatches) {
    BROWSER_BRIDGES.set(params.scopeKey, {
      bridge: resolvedBridge,
      containerName,
      authToken: desiredAuthToken,
      authPassword: desiredAuthPassword,
    });
  }

  await updateBrowserRegistry({
    containerName,
    sessionKey: params.scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: browserImage,
    configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
    cdpPort: mappedCdp,
    noVncPort: mappedNoVnc ?? undefined,
  });

  const noVncUrl =
    mappedNoVnc && noVncEnabled
      ? (() => {
          const token = issueNoVncObserverToken({
            noVncPort: mappedNoVnc,
            password: noVncPassword,
          });
          return buildNoVncObserverTokenUrl(resolvedBridge.baseUrl, token);
        })()
      : undefined;

  return {
    bridgeUrl: resolvedBridge.baseUrl,
    noVncUrl,
    containerName,
  };
}
