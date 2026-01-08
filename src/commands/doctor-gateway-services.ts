import path from "node:path";

import { note } from "@clack/prompts";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import {
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
} from "../daemon/inspect.js";
import {
  findLegacyGatewayServices,
  uninstallLegacyGatewayServices,
} from "../daemon/legacy.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

export async function maybeMigrateLegacyGatewayService(
  cfg: ClawdbotConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const legacyServices = await findLegacyGatewayServices(process.env);
  if (legacyServices.length === 0) return;

  note(
    legacyServices
      .map((svc) => `- ${svc.label} (${svc.platform}, ${svc.detail})`)
      .join("\n"),
    "Legacy Clawdis services detected",
  );

  const migrate = await prompter.confirmSkipInNonInteractive({
    message: "Migrate legacy Clawdis services to Clawdbot now?",
    initialValue: true,
  });
  if (!migrate) return;

  try {
    await uninstallLegacyGatewayServices({
      env: process.env,
      stdout: process.stdout,
    });
  } catch (err) {
    runtime.error(`Legacy service cleanup failed: ${String(err)}`);
    return;
  }

  if (resolveIsNixMode(process.env)) {
    note("Nix mode detected; skip installing services.", "Gateway");
    return;
  }

  if (mode === "remote") {
    note("Gateway mode is remote; skipped local service install.", "Gateway");
    return;
  }

  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  if (loaded) {
    note(`Clawdbot ${service.label} already ${service.loadedText}.`, "Gateway");
    return;
  }

  const install = await prompter.confirmSkipInNonInteractive({
    message: "Install Clawdbot gateway service now?",
    initialValue: true,
  });
  if (!install) return;

  const daemonRuntime = await prompter.select<GatewayDaemonRuntime>(
    {
      message: "Gateway daemon runtime",
      options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
      initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
    },
    DEFAULT_GATEWAY_DAEMON_RUNTIME,
  );
  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const port = resolveGatewayPort(cfg, process.env);
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port,
      dev: devMode,
      runtime: daemonRuntime,
    });
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    CLAWDBOT_GATEWAY_TOKEN:
      cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
    CLAWDBOT_LAUNCHD_LABEL:
      process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
  };
  await service.install({
    env: process.env,
    stdout: process.stdout,
    programArguments,
    workingDirectory,
    environment,
  });
}

export async function maybeScanExtraGatewayServices(options: DoctorOptions) {
  const extraServices = await findExtraGatewayServices(process.env, {
    deep: options.deep,
  });
  if (extraServices.length === 0) return;

  note(
    extraServices
      .map((svc) => `- ${svc.label} (${svc.scope}, ${svc.detail})`)
      .join("\n"),
    "Other gateway-like services detected",
  );

  const cleanupHints = renderGatewayServiceCleanupHints();
  if (cleanupHints.length > 0) {
    note(cleanupHints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
  }

  note(
    [
      "Recommendation: run a single gateway per machine.",
      "One gateway supports multiple agents.",
      "If you need multiple gateways, isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
    ].join("\n"),
    "Gateway recommendation",
  );
}
