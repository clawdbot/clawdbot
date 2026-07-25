// Browser-first guided onboarding handoff: open or print the dashboard, then
// wait for the Control UI client to prove it connected to the Gateway.
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAuth } from "../gateway/auth-resolve.js";
import { callGateway } from "../gateway/call.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { sleep } from "../utils.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  buildOnboardingControlUiUrl,
  formatControlUiSshHint,
  openUrl,
  resolveAdvertisedControlUiLinks,
  resolveLocalControlUiProbeLinks,
} from "./onboard-helpers.js";

const GUI_HANDOFF_TIMEOUT_MS = 60_000;
const HEADLESS_HANDOFF_TIMEOUT_MS = 300_000;
const HANDOFF_POLL_INTERVAL_MS = 1_000;
const HANDOFF_PROBE_TIMEOUT_MS = 5_000;

type BrowserHatchTarget = {
  config: OpenClawConfig;
  dashboardUrl: string;
  sshHint?: string;
  wsUrl: string;
  token?: string;
  password?: string;
};

type DashboardPresenceProbeResult =
  | { reachable: true; clientKeys: string[] }
  | { reachable: false; reason?: string };

type DashboardWaitResult =
  | { connected: true }
  | { connected: false; reason: "gateway-unreachable" | "timeout" };

export type BrowserHatchHandoffResult =
  | { handedOff: true }
  | {
      handedOff: false;
      reason: "gateway-unreachable" | "target-unavailable" | "timeout";
    };

type BrowserHatchHandoffDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  openBrowser?: (url: string) => Promise<boolean>;
  resolveTarget?: (
    config: OpenClawConfig,
    env: NodeJS.ProcessEnv,
    suppressTokenOutput: boolean,
  ) => Promise<BrowserHatchTarget>;
  probePresence?: (
    target: BrowserHatchTarget,
    timeoutMs: number,
  ) => Promise<DashboardPresenceProbeResult>;
  pollForClient?: (params: {
    target: BrowserHatchTarget;
    baselineClientKeys: ReadonlySet<string>;
    timeoutMs: number;
    probe: (target: BrowserHatchTarget, timeoutMs: number) => Promise<DashboardPresenceProbeResult>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) => Promise<DashboardWaitResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function hasSshSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY);
}

/** Pure graphical-session detection used before attempting a browser launch. */
export function detectGraphicalSession(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (hasSshSession(env)) {
    return false;
  }
  if (platform === "darwin" || platform === "win32") {
    return true;
  }
  if (platform === "linux") {
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  }
  return false;
}

async function resolveBrowserHatchTarget(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  suppressTokenOutput: boolean,
): Promise<BrowserHatchTarget> {
  const port = resolveGatewayPort(config, env);
  const bind = config.gateway?.bind ?? "loopback";
  const customBindHost = config.gateway?.customBindHost;
  const basePath = config.gateway?.controlUi?.basePath;
  const tlsEnabled = config.gateway?.tls?.enabled === true;
  const credentials = await resolveGatewayCredentialsWithSecretInputs({
    config,
    env,
    modeOverride: "local",
    localTokenPrecedence: "config-first",
    localPasswordPrecedence: "config-first",
  });
  const auth = resolveGatewayAuth({
    authConfig: {
      ...config.gateway?.auth,
      ...(credentials.token ? { token: credentials.token } : {}),
      ...(credentials.password ? { password: credentials.password } : {}),
    },
    env: {},
    ...(config.gateway?.tailscale?.mode ? { tailscaleMode: config.gateway.tailscale.mode } : {}),
  });
  const [displayLinks, probeLinks] = await Promise.all([
    resolveAdvertisedControlUiLinks({
      bind,
      port,
      customBindHost,
      basePath,
      tlsEnabled,
    }),
    Promise.resolve(
      resolveLocalControlUiProbeLinks({
        bind,
        port,
        customBindHost,
        basePath,
        tlsEnabled,
      }),
    ),
  ]);
  const token = auth.mode === "token" ? auth.token : undefined;
  const setupAuthValue = auth.mode === "password" ? auth.password : undefined;
  const target: BrowserHatchTarget = {
    config,
    dashboardUrl: buildOnboardingControlUiUrl({
      httpUrl: displayLinks.httpUrl,
      authMode: auth.mode,
      token,
      suppressTokenOutput,
    }),
    ...(bind === "loopback"
      ? {
          sshHint: formatControlUiSshHint({
            port,
            ...(basePath ? { basePath } : {}),
            ...(token && !suppressTokenOutput ? { token } : {}),
          }),
        }
      : {}),
    wsUrl: probeLinks.wsUrl,
    ...(token ? { token } : {}),
  };
  if (setupAuthValue) {
    target["password"] = setupAuthValue;
  }
  return target;
}

function isConnectedControlUi(entry: SystemPresence): boolean {
  return (
    entry.host === GATEWAY_CLIENT_IDS.CONTROL_UI &&
    entry.mode === GATEWAY_CLIENT_MODES.WEBCHAT &&
    entry.reason !== "disconnect"
  );
}

function dashboardPresenceKey(entry: SystemPresence): string {
  return [entry.deviceId, entry.instanceId, entry.host, entry.mode, entry.ts].join("\0");
}

async function probeDashboardPresence(
  target: BrowserHatchTarget,
  timeoutMs: number,
): Promise<DashboardPresenceProbeResult> {
  try {
    // Read presence over the same trusted local CLI path every `openclaw`
    // command uses. A raw shared-auth call with a (possibly SecretRef-managed)
    // token is rejected as an unpaired Control UI client with "device identity
    // required"; the CLI-mode loopback client is granted operator.read instead.
    const presence = await callGateway<SystemPresence[]>({
      config: target.config,
      method: "system-presence",
      timeoutMs,
      // Connect as a CLI-mode loopback client (what every `openclaw` command
      // does) so the gateway grants operator.read via trusted local auth.
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      // Present the shared secret when one is configured (token-auth gateways
      // reject a token-less local connect); SecretRef/none gateways fall back to
      // trusted-loopback auth with no token.
      ...(target.token ? { token: target.token } : {}),
      ...(target.password ? { password: target.password } : {}),
      expectFinal: false,
      ignoreEnvUrlOverride: true,
    });
    return {
      reachable: true,
      clientKeys: (presence ?? []).filter(isConnectedControlUi).map(dashboardPresenceKey),
    };
  } catch (error) {
    return {
      reachable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForDashboardClient(params: {
  target: BrowserHatchTarget;
  baselineClientKeys: ReadonlySet<string>;
  timeoutMs: number;
  probe: (target: BrowserHatchTarget, timeoutMs: number) => Promise<DashboardPresenceProbeResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DashboardWaitResult> {
  const now = params.now ?? Date.now;
  const sleepFor = params.sleep ?? sleep;
  const deadline = now() + params.timeoutMs;
  while (true) {
    const beforeProbeMs = deadline - now();
    if (beforeProbeMs <= 0) {
      return { connected: false, reason: "timeout" };
    }
    const result = await params.probe(
      params.target,
      Math.min(HANDOFF_PROBE_TIMEOUT_MS, beforeProbeMs),
    );
    if (!result.reachable) {
      return { connected: false, reason: "gateway-unreachable" };
    }
    if (result.clientKeys.some((key) => !params.baselineClientKeys.has(key))) {
      return { connected: true };
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return { connected: false, reason: "timeout" };
    }
    await sleepFor(Math.min(HANDOFF_POLL_INTERVAL_MS, remainingMs));
  }
}

/** Lightweight reachability gate used before guided onboarding announces a handoff. */
export async function probeBrowserHatchGateway(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; detail?: string }> {
  // A disabled Control UI still answers the WS/presence RPC, so without this
  // guard the handoff would open a dead dashboard URL and block for the full
  // timeout before falling back. Skip straight to the terminal hatch instead.
  if (params.config.gateway?.controlUi?.enabled === false) {
    return { ok: false, detail: "control ui disabled" };
  }
  // Reachability is proven by the same presence read (and same resolved target,
  // so the same shared secret) the handoff waits on — the gate and the wait
  // never disagree on auth.
  try {
    const target = await resolveBrowserHatchTarget(params.config, params.env ?? process.env, false);
    const presence = await probeDashboardPresence(target, HANDOFF_PROBE_TIMEOUT_MS);
    return presence.reachable
      ? { ok: true }
      : { ok: false, ...(presence.reason ? { detail: presence.reason } : {}) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Opens or prints the dashboard and waits for its Control UI client connection. */
export async function runBrowserHatchHandoff(
  params: {
    config: OpenClawConfig;
    prompter: WizardPrompter;
    suppressTokenOutput?: boolean;
  },
  deps: BrowserHatchHandoffDeps = {},
): Promise<BrowserHatchHandoffResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const graphical = detectGraphicalSession(env, platform);
  let target: BrowserHatchTarget;
  try {
    target = await (deps.resolveTarget ?? resolveBrowserHatchTarget)(
      params.config,
      env,
      params.suppressTokenOutput === true,
    );
  } catch {
    return { handedOff: false, reason: "target-unavailable" };
  }

  const probePresence = deps.probePresence ?? probeDashboardPresence;
  const baseline = await probePresence(target, HANDOFF_PROBE_TIMEOUT_MS);
  if (!baseline.reachable) {
    return { handedOff: false, reason: "gateway-unreachable" };
  }

  let opened = false;
  if (graphical) {
    opened = await (deps.openBrowser ?? openUrl)(target.dashboardUrl);
  }
  if (opened) {
    await params.prompter.note(
      t("wizard.guided.browserHandoffOpening"),
      t("wizard.guided.browserHandoffTitle"),
    );
  } else {
    const sshHint = target.sshHint ? `\n\n${target.sshHint}` : "";
    await params.prompter.note(
      `${t("wizard.guided.browserHandoffCopy", { url: target.dashboardUrl })}${sshHint}`,
      t("wizard.guided.browserHandoffTitle"),
    );
  }

  const wait = await (deps.pollForClient ?? waitForDashboardClient)({
    target,
    baselineClientKeys: new Set(baseline.clientKeys),
    timeoutMs: graphical ? GUI_HANDOFF_TIMEOUT_MS : HEADLESS_HANDOFF_TIMEOUT_MS,
    probe: probePresence,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  if (!wait.connected) {
    return { handedOff: false, reason: wait.reason };
  }
  await params.prompter.note(
    t("wizard.guided.browserHandoffContinuing"),
    t("wizard.guided.browserHandoffTitle"),
  );
  return { handedOff: true };
}
