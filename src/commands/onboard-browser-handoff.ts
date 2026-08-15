// Browser-first guided onboarding handoff: open or print the dashboard, then
// wait for the Control UI client to prove it connected to the Gateway.
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { sleep } from "../utils.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  hasVerifiedControlUiLoopbackAlias,
  issueControlUiBrowserHandoff,
  resolveControlUiHandoffTarget,
  waitForControlUiDocument,
  type ControlUiHandoffTarget,
} from "./control-ui-handoff.js";
import {
  formatControlUiSshHint,
  openUrl,
  resolveAdvertisedControlUiLinks,
} from "./onboard-helpers.js";

const GUI_HANDOFF_TIMEOUT_MS = 60_000;
const HEADLESS_HANDOFF_TIMEOUT_MS = 300_000;
const HANDOFF_POLL_INTERVAL_MS = 1_000;
const HANDOFF_PROBE_TIMEOUT_MS = 5_000;

type BrowserHatchTarget = {
  config: OpenClawConfig;
  dashboardUrl: string;
  documentUrl: string;
  sshHint?: string;
  port: number;
  loopbackAliasHost?: string;
  tlsConfig?: ControlUiHandoffTarget["tlsConfig"];
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
  resolveTarget?: (config: OpenClawConfig, env: NodeJS.ProcessEnv) => Promise<BrowserHatchTarget>;
  probePresence?: (
    target: BrowserHatchTarget,
    timeoutMs: number,
  ) => Promise<DashboardPresenceProbeResult>;
  waitForDocument?: typeof waitForControlUiDocument;
  issueBrowserHandoff?: typeof issueControlUiBrowserHandoff;
  verifyLoopbackAlias?: typeof hasVerifiedControlUiLoopbackAlias;
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
): Promise<BrowserHatchTarget> {
  const shared = await resolveControlUiHandoffTarget({ config, env });
  const credentials = await resolveGatewayCredentialsWithSecretInputs({
    config,
    env,
    modeOverride: "local",
  });
  const authMode =
    !config.gateway?.auth?.mode && credentials.password ? "password" : shared.authMode;
  const token = authMode === "token" ? credentials.token : undefined;
  const setupAuthValue = authMode === "password" ? credentials.password : undefined;
  const target: BrowserHatchTarget = {
    config,
    dashboardUrl: shared.links.httpUrl,
    documentUrl: shared.documentUrl,
    port: shared.port,
    ...(shared.loopbackAliasHost ? { loopbackAliasHost: shared.loopbackAliasHost } : {}),
    ...(shared.tlsConfig ? { tlsConfig: shared.tlsConfig } : {}),
    ...(shared.bind === "loopback" || shared.tlsConfig?.enabled !== true
      ? {
          sshHint: formatControlUiSshHint({
            port: shared.port,
            ...(shared.basePath ? { basePath: shared.basePath } : {}),
          }),
        }
      : {}),
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

export function resolveConnectedControlUiPresenceKeys(
  entries: readonly SystemPresence[],
): string[] {
  return entries
    .filter(isConnectedControlUi)
    .map((entry) => [entry.deviceId, entry.instanceId, entry.host, entry.mode].join("\0"));
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
      clientKeys: resolveConnectedControlUiPresenceKeys(presence ?? []),
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
  if (params.suppressTokenOutput === true || params.config.gateway?.controlUi?.enabled === false) {
    return { handedOff: false, reason: "target-unavailable" };
  }
  let target: BrowserHatchTarget;
  try {
    target = await (deps.resolveTarget ?? resolveBrowserHatchTarget)(params.config, env);
  } catch {
    return { handedOff: false, reason: "target-unavailable" };
  }

  if (!(await (deps.verifyLoopbackAlias ?? hasVerifiedControlUiLoopbackAlias)(target))) {
    return { handedOff: false, reason: "target-unavailable" };
  }

  let progress: ReturnType<WizardPrompter["progress"]> | undefined;
  try {
    const document = await (deps.waitForDocument ?? waitForControlUiDocument)({
      url: target.documentUrl,
      tlsConfig: target.tlsConfig,
      onPending: () => {
        progress = params.prompter.progress(t("wizard.guided.controlUiPreparing"));
      },
    });
    if (!document.ready) {
      return { handedOff: false, reason: "target-unavailable" };
    }
  } catch {
    return { handedOff: false, reason: "target-unavailable" };
  } finally {
    progress?.stop();
  }

  const probePresence = deps.probePresence ?? probeDashboardPresence;
  const baseline = await probePresence(target, HANDOFF_PROBE_TIMEOUT_MS);
  if (!baseline.reachable) {
    return { handedOff: false, reason: "gateway-unreachable" };
  }

  let opened = false;
  if (graphical) {
    try {
      const browserHandoff = await (deps.issueBrowserHandoff ?? issueControlUiBrowserHandoff)(
        target.dashboardUrl,
      );
      opened = await (deps.openBrowser ?? openUrl)(browserHandoff.browserUrl);
    } catch {
      return { handedOff: false, reason: "target-unavailable" };
    }
  }
  if (opened) {
    await params.prompter.note(
      t("wizard.guided.browserHandoffOpening"),
      t("wizard.guided.browserHandoffTitle"),
    );
  } else {
    const bind = target.config.gateway?.bind;
    const remoteBind = bind === "lan" || bind === "tailnet" || bind === "custom";
    // Plain HTTP on a remote host cannot create the device identity required by
    // the Control UI. Keep those browsers on a tunneled localhost secure context.
    const directRemoteDisplay = !graphical && remoteBind && target.tlsConfig?.enabled === true;
    const tunnelHint =
      !graphical && !directRemoteDisplay
        ? (target.sshHint ??
          (remoteBind
            ? formatControlUiSshHint({
                port: target.port,
                ...(target.config.gateway?.controlUi?.basePath
                  ? { basePath: target.config.gateway.controlUi.basePath }
                  : {}),
              })
            : undefined))
        : undefined;
    const sshHint = tunnelHint ? `\n\n${tunnelHint}` : "";
    const visibleUrl = directRemoteDisplay
      ? (
          await resolveAdvertisedControlUiLinks({
            bind,
            port: target.port,
            customBindHost: target.config.gateway?.customBindHost,
            basePath: target.config.gateway?.controlUi?.basePath,
            tlsEnabled: target.tlsConfig?.enabled === true,
          })
        ).httpUrl
      : target.dashboardUrl;
    const authHint =
      target.token || target.password
        ? "\n\nIf prompted, enter your Gateway token or password from its configured secret source."
        : "";
    const pairingHint = directRemoteDisplay
      ? "\n\nIf device approval is required, run `openclaw devices list`, then `openclaw devices approve <requestId>`."
      : "";
    await params.prompter.note(
      `${t("wizard.guided.browserHandoffCopy", { url: visibleUrl })}${sshHint}${authHint}${pairingHint}`,
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
