// Implements `openclaw dashboard` URL resolution, readiness check, clipboard, and browser launch.
import { readConfigFileSnapshot } from "../config/config.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { isRemoteEnvironment } from "../infra/remote-env.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  hasVerifiedControlUiLoopbackAlias,
  issueControlUiBrowserHandoff,
  resolveControlUiHandoffTarget,
  waitForControlUiDocument,
} from "./control-ui-handoff.js";
import { ensureGatewayReadyForOperation } from "./gateway-readiness.js";
import { detectBrowserOpenSupport, formatControlUiSshHint, openUrl } from "./onboard-helpers.js";

type DashboardOptions = {
  json?: boolean;
  noOpen?: boolean;
  yes?: boolean;
};

const quietRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: () => {},
};

const gatewayPasswordJsonKey = ["gateway", "Password"].join("");

async function resolveDashboardTarget() {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(
      `OpenClaw config is invalid: ${snapshot.path}. Run \`openclaw doctor --fix\` or \`openclaw config validate\`.`,
    );
  }
  return await resolveControlUiHandoffTarget({
    config: snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {},
    env: process.env,
  });
}

async function ensureDashboardTargetReady(params: {
  target: Awaited<ReturnType<typeof resolveDashboardTarget>>;
  runtime: RuntimeEnv;
  yes?: boolean;
  allowRecovery?: boolean;
}) {
  return ensureGatewayReadyForOperation({
    runtime: params.runtime,
    operation: "open the dashboard",
    yes: params.yes,
    probeUrl: params.target.probeUrl,
    // First-time CLI probes intentionally lack paired operator scope. Gateway
    // handshake evidence plus the same-PID alias check below proves the target.
    readyWhenReachable: true,
    ...(params.allowRecovery === false ? { allowInstall: false, interactive: false } : {}),
  });
}

function dashboardJsonFailure(runtime: RuntimeEnv, reason: string): void {
  writeRuntimeJson(runtime, { ok: false, reason }, 0);
  runtime.exit(1);
}

async function dashboardJsonCommand(runtime: RuntimeEnv): Promise<void> {
  try {
    const target = await resolveDashboardTarget();
    const readiness = await ensureDashboardTargetReady({
      target,
      runtime: quietRuntime,
      allowRecovery: false,
    });
    if (!readiness.ready) {
      dashboardJsonFailure(runtime, readiness.reason);
      return;
    }
    if (!(await hasVerifiedControlUiLoopbackAlias(target))) {
      dashboardJsonFailure(
        runtime,
        "Dashboard loopback listener could not be verified as the configured Gateway.",
      );
      return;
    }

    const document = await waitForControlUiDocument({
      url: target.documentUrl,
      tlsConfig: target.tlsConfig,
      waitForPending: false,
    });
    if (!document.ready) {
      dashboardJsonFailure(runtime, document.reason);
      return;
    }
    const browserHandoff = await issueControlUiBrowserHandoff(target.links.httpUrl);

    writeRuntimeJson(
      runtime,
      {
        ok: true,
        url: target.dashboardUrl,
        httpUrl: target.links.httpUrl,
        wsUrl: target.links.wsUrl,
        port: target.port,
        tokenIncluded: target.includeTokenInUrl,
        browserUrl: browserHandoff.browserUrl,
        browserBootstrapExpiresAtMs: browserHandoff.expiresAtMs,
        ...(target.gatewayAuthHandoff
          ? { [gatewayPasswordJsonKey]: target.gatewayAuthHandoff }
          : {}),
        ...(document.tlsFingerprint ? { tlsFingerprint: document.tlsFingerprint } : {}),
      },
      0,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    dashboardJsonFailure(runtime, reason || "Dashboard target resolution failed.");
  }
}

/** Open or print the Control UI dashboard URL after ensuring the Gateway is reachable. */
export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  if (options.json) {
    await dashboardJsonCommand(runtime);
    return;
  }

  let initialTarget: Awaited<ReturnType<typeof resolveDashboardTarget>>;
  try {
    initialTarget = await resolveDashboardTarget();
  } catch (error) {
    runtime.error(error instanceof Error ? error.message : String(error));
    runtime.exit(1);
    return;
  }
  const readiness = await ensureDashboardTargetReady({
    target: initialTarget,
    runtime,
    yes: options.yes,
  });
  if (!readiness.ready) {
    return;
  }

  const target = readiness.recovered ? await resolveDashboardTarget() : initialTarget;
  const recoveryChangedProbe = target.probeUrl !== initialTarget.probeUrl;
  if (readiness.recovered && recoveryChangedProbe) {
    // Recovery may install or start against a changed config. Prove the final
    // endpoint without triggering a second lifecycle action before URL delivery.
    const finalReadiness = await ensureDashboardTargetReady({
      target,
      runtime,
      allowRecovery: false,
    });
    if (!finalReadiness.ready) {
      return;
    }
  }
  if (!(await hasVerifiedControlUiLoopbackAlias(target))) {
    runtime.error(
      "Dashboard loopback listener could not be verified as the configured Gateway; refusing to copy or open an authenticated URL.",
    );
    runtime.log("Restart the Gateway, then run `openclaw gateway status --deep` for details.");
    return;
  }
  const document = await waitForControlUiDocument({
    url: target.documentUrl,
    tlsConfig: target.tlsConfig,
    onPending: () => runtime.log("Control UI assets are preparing; waiting for the dashboard…"),
  });
  if (!document.ready) {
    runtime.error(document.reason);
    runtime.log("Run `openclaw gateway status --deep` for details.");
    runtime.exit(1);
    return;
  }
  let browserUrl: string;
  try {
    browserUrl = (await issueControlUiBrowserHandoff(target.links.httpUrl)).browserUrl;
  } catch (error) {
    runtime.error(
      `Could not create a one-time browser pairing link: ${error instanceof Error ? error.message : String(error)}`,
    );
    runtime.log("Run `openclaw doctor`, then retry `openclaw dashboard`.");
    return;
  }
  const { port, basePath, links, includeTokenInUrl, tlsConfig } = target;

  runtime.log(`Dashboard URL: ${links.httpUrl}`);
  runtime.log("One-time browser pairing included in browser/clipboard URL.");

  const copied = await copyToClipboard(browserUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(browserUrl);
      if (!opened && !copied && isRemoteEnvironment()) {
        hint = formatControlUiSshHint({
          port,
          basePath,
          tlsEnabled: tlsConfig?.enabled === true,
        });
      } else {
        hint = opened
          ? undefined
          : copied
            ? "Browser launch failed. Open the one-time pairing URL copied to clipboard."
            : "Browser launch failed. Open the Dashboard URL above manually.";
      }
    } else {
      hint = formatControlUiSshHint({
        port,
        basePath,
        tlsEnabled: tlsConfig?.enabled === true,
      });
    }
  } else {
    hint = copied
      ? "Browser launch disabled (--no-open). One-time browser pairing URL copied to clipboard."
      : "Browser launch disabled (--no-open). Use the URL above.";
  }

  const handoffDeliveryFailed = !copied && !opened;
  const fallbackToManualAuth = handoffDeliveryFailed && includeTokenInUrl;
  const fallbackToJsonHandoff = handoffDeliveryFailed && !includeTokenInUrl;
  const suppressNoOpenHint =
    options.noOpen === true && (fallbackToManualAuth || fallbackToJsonHandoff);

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control OpenClaw.");
  } else if (hint && !suppressNoOpenHint) {
    runtime.log(hint);
  }

  if (fallbackToManualAuth) {
    runtime.log(
      "Token auto-auth not delivered. Append your gateway token (from OPENCLAW_GATEWAY_TOKEN or gateway.auth.token) as a URL fragment with key `token` to authenticate.",
    );
  } else if (fallbackToJsonHandoff) {
    runtime.log(
      "One-time pairing URL not delivered. Run `openclaw dashboard --json` and open its `browserUrl` within ten minutes.",
    );
  }
}
