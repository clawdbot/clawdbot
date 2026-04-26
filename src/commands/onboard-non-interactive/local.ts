import { formatCliCommand } from "../../cli/command-format.js";
import { replaceConfigFile, resolveGatewayPort } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayAuthToken } from "../../gateway/auth-token-resolution.js";
import type { RuntimeEnv } from "../../runtime.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig } from "../onboard-config.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import type { OnboardOptions } from "../onboard-types.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import {
  type GatewayHealthFailureDiagnostics,
  logNonInteractiveOnboardingFailure,
  logNonInteractiveOnboardingJson,
} from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

const INSTALL_DAEMON_HEALTH_DEADLINE_MS = 45_000;
const ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS = 15_000;
const INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_DEADLINE_MS = 90_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS = 15_000;
const INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS = 90_000;

export function resolveInstallDaemonGatewayHealthTiming(
  platform: NodeJS.Platform = process.platform,
): {
  deadlineMs: number;
  probeTimeoutMs: number;
  healthCommandTimeoutMs: number;
} {
  if (platform === "win32") {
    return {
      deadlineMs: WINDOWS_INSTALL_DAEMON_HEALTH_DEADLINE_MS,
      probeTimeoutMs: WINDOWS_INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS,
      healthCommandTimeoutMs: WINDOWS_INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS,
    };
  }
  return {
    deadlineMs: INSTALL_DAEMON_HEALTH_DEADLINE_MS,
    probeTimeoutMs: INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS,
    healthCommandTimeoutMs: INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS,
  };
}

async function collectGatewayHealthFailureDiagnostics(): Promise<
  GatewayHealthFailureDiagnostics | undefined
> {
  const diagnostics: GatewayHealthFailureDiagnostics = {};

  try {
    const { resolveGatewayService } = await import("../../daemon/service.js");
    const service = resolveGatewayService();
    const env = process.env as Record<string, string | undefined>;
    const [loaded, runtime] = await Promise.all([
      service.isLoaded({ env }).catch(() => false),
      service.readRuntime(env).catch(() => undefined),
    ]);
    diagnostics.service = {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      runtimeStatus: runtime?.status,
      state: runtime?.state,
      pid: runtime?.pid,
      lastExitStatus: runtime?.lastExitStatus,
      lastExitReason: runtime?.lastExitReason,
    };
  } catch (err) {
    diagnostics.inspectError = `service diagnostics failed: ${String(err)}`;
  }

  try {
    const { readLastGatewayErrorLine } = await import("../../daemon/diagnostics.js");
    diagnostics.lastGatewayError = (await readLastGatewayErrorLine(process.env)) ?? undefined;
  } catch (err) {
    diagnostics.inspectError = diagnostics.inspectError
      ? `${diagnostics.inspectError}; log diagnostics failed: ${String(err)}`
      : `log diagnostics failed: ${String(err)}`;
  }

  return diagnostics.service || diagnostics.lastGatewayError || diagnostics.inspectError
    ? diagnostics
    : undefined;
}

export async function resolveGatewayHealthProbeToken(
  nextConfig: OpenClawConfig,
): Promise<{ token?: string; unresolvedRefReason?: string }> {
  const resolved = await resolveGatewayAuthToken({
    cfg: nextConfig,
    env: process.env,
    envFallback: "no-secret-ref",
    unresolvedReasonStyle: "detailed",
  });
  const probeAuth: { token?: string; unresolvedRefReason?: string } = {};
  if (resolved.token) {
    probeAuth.token = resolved.token;
  }
  if (resolved.unresolvedRefReason) {
    probeAuth.unresolvedRefReason = resolved.unresolvedRefReason;
  }
  return probeAuth;
}

function formatGatewayHealthFailureDetail(params: {
  probeDetail?: string;
  unresolvedRefReason?: string;
}): string | undefined {
  const detail = [params.probeDetail, params.unresolvedRefReason].filter(Boolean).join("\n");
  return detail || undefined;
}

export async function runNonInteractiveLocalSetup(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  baseHash?: string;
}) {
  const { opts, runtime, baseConfig, baseHash } = params;
  const mode = "local" as const;

  const workspaceDir = resolveNonInteractiveWorkspaceDir({
    opts,
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });

  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);
  if (opts.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }

  const inferredAuthChoice = opts.authChoice
    ? undefined
    : (await import("./local/auth-choice-inference.js")).inferAuthChoiceFromFlags(opts, {
        config: nextConfig,
        workspaceDir,
        env: process.env,
      });
  if (!opts.authChoice && inferredAuthChoice && inferredAuthChoice.matches.length > 1) {
    runtime.error(
      [
        "Multiple API key flags were provided for non-interactive setup.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice?.choice ?? "skip";
  if (authChoice !== "skip") {
    const { applyNonInteractiveAuthChoice } = await import("./local/auth-choice.js");
    const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice,
      opts,
      runtime,
      baseConfig,
    });
    if (!nextConfigAfterAuth) {
      return;
    }
    nextConfig = nextConfigAfterAuth;
  }

  const gatewayBasePort = resolveGatewayPort(baseConfig);
  const gatewayResult = applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime,
    defaultPort: gatewayBasePort,
  });
  if (!gatewayResult) {
    return;
  }
  nextConfig = gatewayResult.nextConfig;

  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await replaceConfigFile({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  logConfigUpdated(runtime);

  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  let daemonInstallStatus:
    | {
        requested: boolean;
        installed: boolean;
        skippedReason?: "systemd-user-unavailable";
      }
    | undefined;
  if (opts.installDaemon) {
    const { installGatewayDaemonNonInteractive } = await import("./local/daemon-install.js");
    const daemonInstall = await installGatewayDaemonNonInteractive({
      nextConfig,
      opts,
      runtime,
      port: gatewayResult.port,
    });
    daemonInstallStatus = daemonInstall.installed
      ? {
          requested: true,
          installed: true,
        }
      : {
          requested: true,
          installed: false,
          skippedReason: daemonInstall.skippedReason,
        };
    if (!daemonInstall.installed && !opts.skipHealth) {
      logNonInteractiveOnboardingFailure({
        opts,
        runtime,
        mode,
        phase: "daemon-install",
        message:
          daemonInstall.skippedReason === "systemd-user-unavailable"
            ? "Gateway service install is unavailable because systemd user services are not reachable in this Linux session."
            : "Gateway service install did not complete successfully.",
        installDaemon: true,
        daemonInstall: {
          requested: true,
          installed: false,
          skippedReason: daemonInstall.skippedReason,
        },
        daemonRuntime: daemonRuntimeRaw,
        hints:
          daemonInstall.skippedReason === "systemd-user-unavailable"
            ? [
                "Fix: rerun without `--install-daemon` for one-shot setup, or enable a working user-systemd session and retry.",
                "If your auth profile uses env-backed refs, keep those env vars set in the shell that runs `openclaw gateway run` or `openclaw agent --local`.",
              ]
            : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
      });
      runtime.exit(1);
      return;
    }
  }

  if (!opts.skipHealth) {
    const { healthCommand } = await import("../health.js");
    const links = resolveControlUiLinks({
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      port: gatewayResult.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    });
    const installDaemonGatewayHealthTiming = resolveInstallDaemonGatewayHealthTiming();
    const probeAuth = await resolveGatewayHealthProbeToken(nextConfig);
    const probe = await waitForGatewayReachable({
      url: links.wsUrl,
      token: probeAuth.token,
      deadlineMs: opts.installDaemon
        ? installDaemonGatewayHealthTiming.deadlineMs
        : ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS,
      probeTimeoutMs: opts.installDaemon
        ? installDaemonGatewayHealthTiming.probeTimeoutMs
        : undefined,
    });
    if (!probe.ok) {
      const detail = formatGatewayHealthFailureDetail({
        probeDetail: probe.detail,
        unresolvedRefReason: probeAuth.unresolvedRefReason,
      });
      const diagnostics = opts.installDaemon
        ? await collectGatewayHealthFailureDiagnostics()
        : undefined;
      logNonInteractiveOnboardingFailure({
        opts,
        runtime,
        mode,
        phase: "gateway-health",
        message: `Gateway did not become reachable at ${links.wsUrl}.`,
        detail,
        gateway: {
          wsUrl: links.wsUrl,
          httpUrl: links.httpUrl,
        },
        installDaemon: Boolean(opts.installDaemon),
        daemonInstall: daemonInstallStatus,
        daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
        diagnostics,
        hints: !opts.installDaemon
          ? [
              "Non-interactive local setup only waits for an already-running gateway unless you pass --install-daemon.",
              `Fix: start \`${formatCliCommand("openclaw gateway run")}\`, re-run with \`--install-daemon\`, or use \`--skip-health\`.`,
              process.platform === "win32"
                ? "Native Windows managed gateway install tries Scheduled Tasks first and falls back to a per-user Startup-folder login item when task creation is denied."
                : undefined,
            ].filter((value): value is string => Boolean(value))
          : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
      });
      runtime.exit(1);
      return;
    }
    await healthCommand(
      {
        json: false,
        timeoutMs: opts.installDaemon
          ? installDaemonGatewayHealthTiming.healthCommandTimeoutMs
          : 10_000,
      },
      runtime,
    );
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir,
    authChoice,
    gateway: {
      port: gatewayResult.port,
      bind: gatewayResult.bind,
      authMode: gatewayResult.authMode,
      tailscaleMode: gatewayResult.tailscaleMode,
    },
    installDaemon: Boolean(opts.installDaemon),
    daemonInstall: daemonInstallStatus,
    daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
    skipSkills: Boolean(opts.skipSkills),
    skipHealth: Boolean(opts.skipHealth),
  });

  if (!opts.json) {
    runtime.log(
      `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
}
