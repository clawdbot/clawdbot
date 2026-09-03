/**
 * Local non-interactive onboarding orchestration.
 *
 * This entrypoint applies config changes, optionally installs the gateway
 * daemon, verifies health, and emits machine-readable setup output.
 */
import { listAgentEntries } from "../../agents/agent-scope-config.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { resolveGatewayPort } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayAuthToken } from "../../gateway/auth-token-resolution.js";
import { resolveConfiguredSecretInputWithFallback } from "../../gateway/resolve-configured-secret-input-string.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { resolveGatewayStartupTiming } from "../gateway-startup-timing.js";
import {
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
  resolveOnboardingSetupTarget,
} from "../onboard-agent-target.js";
import {
  applyLocalSetupWorkspaceConfig,
  applySkipBootstrapConfig,
  resolveOnboardingWorkspaceConflict,
} from "../onboard-config.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  resolveLocalControlUiProbeLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import { enableDefaultOnboardingInternalHooks } from "../onboard-hooks.js";
import { rejectOnboardingOption } from "../onboard-options.js";
import type { OnboardOptions } from "../onboard-types.js";
import { commitNonInteractiveOnboardConfig } from "./config-write.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import {
  classifyGatewayHealthFailure,
  type GatewayHealthFailureDiagnostics,
  logNonInteractiveOnboardingFailure,
  logNonInteractiveOnboardingJson,
} from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

async function collectGatewayHealthFailureDiagnostics(): Promise<
  GatewayHealthFailureDiagnostics | undefined
> {
  const diagnostics: GatewayHealthFailureDiagnostics = {};

  try {
    // Load daemon diagnostics only on failure; successful setup should not pay
    // the service/log inspection cost or import daemon-specific modules.
    const { readGatewayServiceState, resolveGatewayService } =
      await import("../../daemon/service.js");
    const service = resolveGatewayService();
    const env = process.env as Record<string, string | undefined>;
    const state = await readGatewayServiceState(service, { env });
    const runtime = state.runtime;
    const loaded =
      state.loadState.status === "unknown" ? null : state.loadState.status === "loaded";
    diagnostics.service = {
      label: service.label,
      loaded,
      loadState: state.loadState,
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

/** Resolves the auth material used by the post-setup gateway health probe. */
async function resolveGatewayHealthProbeToken(
  nextConfig: OpenClawConfig,
): Promise<{ token?: string; password?: string; unresolvedRefReason?: string }> {
  if (nextConfig.gateway?.auth?.mode === "password") {
    // Password mode uses the configured password directly; token fallback must
    // stay disabled or the probe can validate the wrong auth mode.
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: nextConfig,
      env: process.env,
      value: nextConfig.gateway.auth.password,
      path: "gateway.auth.password",
      unresolvedReasonStyle: "detailed",
      readFallback: () => process.env.OPENCLAW_GATEWAY_PASSWORD,
    });
    return {
      password: resolved.value,
      unresolvedRefReason: resolved.unresolvedRefReason,
    };
  }

  const resolved = await resolveGatewayAuthToken({
    cfg: nextConfig,
    env: process.env,
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

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.onboardNonInteractiveLocalTestApi")
  ] = {
    resolveGatewayHealthProbeToken,
  };
}

function formatGatewayHealthFailureDetail(params: {
  probeDetail?: string;
  unresolvedRefReason?: string;
}): string | undefined {
  const detail = [params.probeDetail, params.unresolvedRefReason].filter(Boolean).join("\n");
  return detail || undefined;
}

/** Runs local non-interactive setup from config mutation through health verification. */
export async function runNonInteractiveLocalSetup(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  sourceConfigBeforeMigrations: OpenClawConfig;
  baseHash?: string;
}) {
  const { opts, runtime, baseConfig, sourceConfigBeforeMigrations, baseHash } = params;
  const mode = "local" as const;

  const requestedWorkspaceDir = resolveNonInteractiveWorkspaceDir({
    opts,
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });
  // Injected main is not authored membership; legacy workspace state still owns its guard.
  const hasAuthoredRoster = listAgentEntries(sourceConfigBeforeMigrations).length > 0;
  const workspaceConflict = resolveOnboardingWorkspaceConflict(
    sourceConfigBeforeMigrations,
    requestedWorkspaceDir,
  );
  const workspaceDir = workspaceConflict?.currentWorkspaceDir ?? requestedWorkspaceDir;
  if (workspaceConflict) {
    runtime.error(
      [
        "Warning: existing agents keep their current workspace during non-interactive onboarding.",
        `Current workspace: ${workspaceConflict.currentWorkspaceDir}`,
        `Requested workspace: ${workspaceConflict.requestedWorkspaceDir}`,
        `Run \`${formatCliCommand("openclaw onboard --classic")}\` to confirm moving the existing agent fleet.`,
      ].join("\n"),
    );
  }

  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(
    baseConfig,
    requestedWorkspaceDir,
    { allowWorkspaceChange: !hasAuthoredRoster && !workspaceConflict },
  );
  if (opts.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }
  // Workspace defaults are already staged above; provider discovery must use
  // that requested owner before first-agent creation is allowed to write.
  const authTarget = resolveOnboardingSetupTarget(
    nextConfig,
    opts.agentName && !hasAuthoredRoster ? { name: opts.agentName, workspaceDir } : undefined,
  );

  const inferredAuthChoice = opts.authChoice
    ? undefined
    : (await import("./local/auth-choice-inference.js")).inferAuthChoiceFromFlags(opts, {
        config: nextConfig,
        workspaceDir: authTarget.workspaceDir,
        env: process.env,
      });
  if (!opts.authChoice && inferredAuthChoice && inferredAuthChoice.matches.length > 1) {
    // Multiple provider flags make implicit auth selection ambiguous; require a
    // single explicit --auth-choice rather than choosing by flag order.
    const message = [
      "Multiple API key flags were provided for non-interactive setup.",
      "Use a single provider flag or pass --auth-choice explicitly.",
      `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
    ].join("\n");
    rejectOnboardingOption(opts, runtime, message);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice?.choice ?? "skip";

  // Validate the complete Gateway proposal before provider methods or first-
  // agent creation can write credentials, config, or workspace state.
  const gatewayResult = applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime,
    defaultPort: resolveGatewayPort(baseConfig),
  });
  if (!gatewayResult) {
    return;
  }
  nextConfig = gatewayResult.nextConfig;
  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });

  if (authChoice !== "skip") {
    // Auth-choice handling is loaded only when needed so skip-only onboarding
    // avoids provider plugin discovery and credential helper imports.
    const { applyNonInteractiveAuthChoice } = await import("./local/auth-choice.js");
    const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice,
      opts,
      runtime,
      baseConfig,
      target: authTarget,
    });
    if (!nextConfigAfterAuth) {
      return;
    }
    nextConfig = nextConfigAfterAuth;
  }

  if (!opts.skipHooks) {
    nextConfig = enableDefaultOnboardingInternalHooks(nextConfig);
  }

  const { ensureOnboardingAgent } = await import("../onboard-agent.js");
  const created = await ensureOnboardingAgent({
    config: nextConfig,
    workspace: workspaceDir,
    baseConfig,
    firstAgent: { name: opts.agentName ?? "main" },
    expectedConfigHash: baseHash ?? null,
  });
  for (const warning of created.sessionMigrationWarnings ?? []) {
    runtime.log(`Warning: ${warning}`);
  }
  nextConfig = applyLocalSetupWorkspaceConfig(created.config, requestedWorkspaceDir);
  // First-agent creation is the first permitted config mutation. Preserve its
  // resulting hash so the canonical wizard write still rejects foreign edits.
  const effectiveBaseHash = created.configHash ?? baseHash;
  if (opts.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }

  const finalTarget = resolveOnboardingAgentTarget(nextConfig, created.agentId);
  await ensureOnboardingAgentWorkspace(finalTarget, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
    skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
  });

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  nextConfig = await commitNonInteractiveOnboardConfig({
    nextConfig,
    baseHash: effectiveBaseHash,
    reset: opts.reset,
  });
  logConfigUpdated(runtime);

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  let daemonInstallStatus:
    | {
        requested: boolean;
        installed: boolean;
        skippedReason?: "systemd-user-unavailable";
      }
    | undefined;
  let gatewayNotRunning = false;
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
    if (!daemonInstall.installed) {
      // Skipping the health probe must not turn a requested install failure
      // into successful onboarding.
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
    const { healthCommandNonExiting } = await import("../health.js");
    const links = resolveLocalControlUiProbeLinks({
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      port: gatewayResult.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    });
    const startupTiming = opts.installDaemon
      ? resolveGatewayStartupTiming()
      : { deadlineMs: 15_000 };
    const probeAuth = await resolveGatewayHealthProbeToken(nextConfig);
    const probe = await waitForGatewayReachable({
      url: links.wsUrl,
      token: probeAuth.token,
      password: probeAuth.password,
      ...startupTiming,
    });
    if (!probe.ok) {
      // Non-daemon setup attaches to an existing gateway, so collect expensive
      // daemon diagnostics only when this run was responsible for installing it.
      const detail = formatGatewayHealthFailureDetail({
        probeDetail: probe.detail,
        unresolvedRefReason: probeAuth.unresolvedRefReason,
      });
      const diagnostics = opts.installDaemon
        ? await collectGatewayHealthFailureDiagnostics()
        : undefined;
      const explicitlySkippedAbsentGateway =
        opts.installDaemon === false &&
        classifyGatewayHealthFailure({ detail, diagnostics }) === "not-listening";
      if (explicitlySkippedAbsentGateway && !opts.json) {
        runtime.log(
          "Setup complete; gateway was not installed or started because daemon installation was explicitly skipped.",
        );
      }
      if (!explicitlySkippedAbsentGateway || !opts.json) {
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
                "Non-interactive local setup only waits for an already-running gateway unless you pass `--install-daemon` to `openclaw onboard`.",
                `Fix: start \`${formatCliCommand("openclaw gateway run")}\`, re-run \`${formatCliCommand("openclaw onboard --install-daemon")}\`, or use \`${formatCliCommand("openclaw onboard --skip-health")}\`.`,
                process.platform === "win32"
                  ? "Native Windows managed gateway install tries Scheduled Tasks first and falls back to a per-user Startup-folder login item when task creation is denied."
                  : undefined,
              ].filter((value): value is string => Boolean(value))
            : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
          informational: explicitlySkippedAbsentGateway,
        });
      }
      if (!explicitlySkippedAbsentGateway) {
        runtime.exit(1);
        return;
      }
      gatewayNotRunning = true;
    } else {
      // In --json mode healthCommand's human text must stay off stdout; capture
      // it so a failure still surfaces the printed diagnostic in the payload.
      const capturedHealthLines: string[] = [];
      const healthRuntime: RuntimeEnv = opts.json
        ? {
            ...runtime,
            log: (...args: unknown[]) => {
              capturedHealthLines.push(args.map(String).join(" "));
            },
          }
        : runtime;
      try {
        await healthCommandNonExiting(
          {
            json: false,
            timeoutMs: opts.installDaemon && process.platform === "win32" ? 90_000 : 10_000,
            config: nextConfig,
            token: probeAuth.token,
            password: probeAuth.password,
          },
          healthRuntime,
        );
      } catch (err) {
        // Route health failures through the flow's failure owner so the JSON
        // contract emits a structured payload instead of dying mid-command.
        const detail =
          err instanceof ExitError
            ? capturedHealthLines.join("\n") || undefined
            : formatErrorMessage(err);
        logNonInteractiveOnboardingFailure({
          opts,
          runtime,
          mode,
          phase: "gateway-health",
          message: `Gateway is reachable at ${links.wsUrl}, but the health check failed.`,
          detail,
          gateway: {
            wsUrl: links.wsUrl,
            httpUrl: links.httpUrl,
          },
          installDaemon: Boolean(opts.installDaemon),
          daemonInstall: daemonInstallStatus,
          daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
          hints: [`Run \`${formatCliCommand("openclaw health")}\` for full diagnostics.`],
        });
        runtime.exit(1);
        return;
      }
    }
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir: finalTarget.workspaceDir,
    authChoice,
    gateway: {
      port: gatewayResult.port,
      bind: gatewayResult.bind,
      authMode: gatewayResult.authMode,
      tailscaleMode: gatewayResult.tailscaleMode,
      ...(gatewayNotRunning ? { reachable: false } : {}),
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
