import { withProgress } from "../cli/progress.js";
import { getRuntimeConfig } from "../config/config.js";
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { isNonFatalSystemdInstallProbeError } from "../daemon/systemd.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { confirm, select } from "./configure.shared.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";
import { guardCancel } from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

export async function maybeInstallDaemon(params: {
  runtime: RuntimeEnv;
  port: number;
  daemonRuntime?: GatewayDaemonRuntime;
}) {
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (error) {
    if (!isNonFatalSystemdInstallProbeError(error)) {
      throw error;
    }
    loaded = false;
  }
  let shouldCheckLinger = false;
  let shouldInstall = true;
  let daemonRuntime = params.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (loaded) {
    const action = guardCancel(
      await select({
        message: "Gateway service already installed",
        options: [
          { value: "restart", label: "Restart" },
          { value: "reinstall", label: "Reinstall" },
          { value: "skip", label: "Skip" },
        ],
      }),
      params.runtime,
    );
    if (action === "restart") {
      await withProgress(
        { label: "Gateway service", indeterminate: true, delayMs: 0 },
        async (progress) => {
          progress.setLabel("Restarting Gateway service…");
          const restartResult = await service.restart({
            env: process.env,
            stdout: process.stdout,
          });
          progress.setLabel(
            describeGatewayServiceRestart("Gateway", restartResult).progressMessage,
          );
        },
      );
      shouldCheckLinger = true;
      shouldInstall = false;
    }
    if (action === "skip") {
      return;
    }
    if (action === "reinstall") {
      await withProgress(
        { label: "Gateway service", indeterminate: true, delayMs: 0 },
        async (progress) => {
          progress.setLabel("Uninstalling Gateway service…");
          await service.uninstall({ env: process.env, stdout: process.stdout });
          progress.setLabel("Gateway service uninstalled.");
        },
      );
    }
  }

  if (shouldInstall) {
    let installError: string | null = null;
    if (!params.daemonRuntime) {
      if (GATEWAY_DAEMON_RUNTIME_OPTIONS.length === 1) {
        daemonRuntime = GATEWAY_DAEMON_RUNTIME_OPTIONS[0]?.value ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
      } else {
        daemonRuntime = guardCancel(
          await select({
            message: "Gateway service runtime",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
          }),
          params.runtime,
        ) as GatewayDaemonRuntime;
      }
    }
    await withProgress(
      { label: "Gateway service", indeterminate: true, delayMs: 0 },
      async (progress) => {
        progress.setLabel("Preparing Gateway service…");

        const cfg = getRuntimeConfig();
        const tokenResolution = await resolveGatewayInstallToken({
          config: cfg,
          env: process.env,
        });
        for (const warning of tokenResolution.warnings) {
          note(warning, "Gateway");
        }
        if (tokenResolution.unavailableReason) {
          installError = [
            "Gateway install blocked:",
            tokenResolution.unavailableReason,
            "Fix gateway auth config/token input and rerun configure.",
          ].join(" ");
          progress.setLabel("Gateway service install blocked.");
          return;
        }
        const { programArguments, workingDirectory, environment, environmentValueSources } =
          await buildGatewayInstallPlan({
            env: process.env,
            port: params.port,
            runtime: daemonRuntime,
            warn: (message, title) => note(message, title),
            config: cfg,
          });

        progress.setLabel("Installing Gateway service…");
        try {
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
            environmentValueSources,
          });
          progress.setLabel("Gateway service installed.");
        } catch (err) {
          installError = formatErrorMessage(err);
          progress.setLabel("Gateway service install failed.");
        }
      },
    );
    if (installError) {
      note("Gateway service install failed: " + installError, "Gateway");
      note(gatewayInstallErrorHint(), "Gateway");
      return;
    }
    shouldCheckLinger = true;
  }

  if (shouldCheckLinger) {
    await ensureSystemdUserLingerInteractive({
      runtime: params.runtime,
      prompter: {
        confirm: async (p) => guardCancel(await confirm(p), params.runtime),
        note,
      },
      reason:
        "Linux installs use a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
      requireConfirm: true,
    });
  }
}
