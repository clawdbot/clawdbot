import path from "node:path";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import { withProgress } from "../cli/progress.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { confirm, select } from "./configure.shared.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { guardCancel } from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

export async function maybeInstallDaemon(params: {
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
  daemonRuntime?: GatewayDaemonRuntime;
}) {
  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
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
        { label: "Gateway daemon", indeterminate: true, delayMs: 0 },
        async (progress) => {
          progress.setLabel("Restarting Gateway daemon…");
          await service.restart({
            env: process.env,
            stdout: process.stdout,
          });
          progress.setLabel("Gateway daemon restarted.");
        },
      );
      shouldCheckLinger = true;
      shouldInstall = false;
    }
    if (action === "skip") return;
    if (action === "reinstall") {
      await withProgress(
        { label: "Gateway daemon", indeterminate: true, delayMs: 0 },
        async (progress) => {
          progress.setLabel("Uninstalling Gateway daemon…");
          await service.uninstall({ env: process.env, stdout: process.stdout });
          progress.setLabel("Gateway daemon uninstalled.");
        },
      );
    }
  }

  if (shouldInstall) {
    await withProgress(
      { label: "Gateway daemon", indeterminate: true, delayMs: 0 },
      async (progress) => {
        if (!params.daemonRuntime) {
          daemonRuntime = guardCancel(
            await select({
              message: "Gateway daemon runtime",
              options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
              initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
            }),
            params.runtime,
          ) as GatewayDaemonRuntime;
        }

        progress.setLabel("Preparing Gateway daemon…");

        const devMode =
          process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
          process.argv[1]?.endsWith(".ts");
        const nodePath = await resolvePreferredNodePath({
          env: process.env,
          runtime: daemonRuntime,
        });
        const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
          port: params.port,
          dev: devMode,
          runtime: daemonRuntime,
          nodePath,
        });
        if (daemonRuntime === "node") {
          const systemNode = await resolveSystemNodeInfo({ env: process.env });
          const warning = renderSystemNodeWarning(systemNode, programArguments[0]);
          if (warning) note(warning, "Gateway runtime");
        }
        const environment = buildServiceEnvironment({
          env: process.env,
          port: params.port,
          token: params.gatewayToken,
          launchdLabel:
            process.platform === "darwin"
              ? resolveGatewayLaunchAgentLabel(process.env.CLAWDBOT_PROFILE)
              : undefined,
        });

        progress.setLabel("Installing Gateway daemon…");
        await service.install({
          env: process.env,
          stdout: process.stdout,
          programArguments,
          workingDirectory,
          environment,
        });
        progress.setLabel("Gateway daemon installed.");
      },
    );
    shouldCheckLinger = true;
  }

  if (shouldCheckLinger) {
    await ensureSystemdUserLingerInteractive({
      runtime: params.runtime,
      prompter: {
        confirm: async (p) => guardCancel(await confirm(p), params.runtime) === true,
        note,
      },
      reason:
        "Linux installs use a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
      requireConfirm: true,
    });
  }
}
