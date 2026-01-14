import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import {
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
} from "../daemon/inspect.js";
import {
  findLegacyGatewayServices,
  uninstallLegacyGatewayServices,
} from "../daemon/legacy.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import {
  auditGatewayServiceConfig,
  needsNodeRuntimeMigration,
  SERVICE_AUDIT_CODES,
} from "../daemon/service-audit.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

function detectGatewayRuntime(
  programArguments: string[] | undefined,
): GatewayDaemonRuntime {
  const first = programArguments?.[0];
  if (first) {
    const base = path.basename(first).toLowerCase();
    if (base === "bun" || base === "bun.exe") return "bun";
    if (base === "node" || base === "node.exe") return "node";
  }
  return DEFAULT_GATEWAY_DAEMON_RUNTIME;
}

function findGatewayEntrypoint(programArguments?: string[]): string | null {
  if (!programArguments || programArguments.length === 0) return null;
  const gatewayIndex = programArguments.indexOf("gateway");
  if (gatewayIndex <= 0) return null;
  return programArguments[gatewayIndex - 1] ?? null;
}

function normalizeExecutablePath(value: string): string {
  return path.resolve(value);
}

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
  const loaded = await service.isLoaded({
    env: process.env,
    profile: process.env.CLAWDBOT_PROFILE,
  });
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
  const nodePath = await resolvePreferredNodePath({
    env: process.env,
    runtime: daemonRuntime,
  });
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port,
      dev: devMode,
      runtime: daemonRuntime,
      nodePath,
    });
  const environment = buildServiceEnvironment({
    env: process.env,
    port,
    token: cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(process.env.CLAWDBOT_PROFILE)
        : undefined,
  });
  await service.install({
    env: process.env,
    stdout: process.stdout,
    programArguments,
    workingDirectory,
    environment,
  });
}

export async function maybeRepairGatewayServiceConfig(
  cfg: ClawdbotConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  if (resolveIsNixMode(process.env)) {
    note("Nix mode detected; skip service updates.", "Gateway");
    return;
  }

  if (mode === "remote") {
    note("Gateway mode is remote; skipped local service audit.", "Gateway");
    return;
  }

  const service = resolveGatewayService();
  let command: Awaited<ReturnType<typeof service.readCommand>> | null = null;
  try {
    command = await service.readCommand(process.env);
  } catch {
    command = null;
  }
  if (!command) return;

  const audit = await auditGatewayServiceConfig({
    env: process.env,
    command,
  });
  const needsNodeRuntime = needsNodeRuntimeMigration(audit.issues);
  const systemNodeInfo = needsNodeRuntime
    ? await resolveSystemNodeInfo({ env: process.env })
    : null;
  const systemNodePath = systemNodeInfo?.supported ? systemNodeInfo.path : null;
  if (needsNodeRuntime && !systemNodePath) {
    const warning = renderSystemNodeWarning(systemNodeInfo);
    if (warning) note(warning, "Gateway runtime");
    note(
      "System Node 22+ not found. Install via Homebrew/apt/choco and rerun doctor to migrate off Bun/version managers.",
      "Gateway runtime",
    );
  }

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const port = resolveGatewayPort(cfg, process.env);
  const runtimeChoice = detectGatewayRuntime(command.programArguments);
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port,
      dev: devMode,
      runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
      nodePath: systemNodePath ?? undefined,
    });
  const expectedEntrypoint = findGatewayEntrypoint(programArguments);
  const currentEntrypoint = findGatewayEntrypoint(command.programArguments);
  if (
    expectedEntrypoint &&
    currentEntrypoint &&
    normalizeExecutablePath(expectedEntrypoint) !==
      normalizeExecutablePath(currentEntrypoint)
  ) {
    audit.issues.push({
      code: SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
      message: "Gateway service entrypoint does not match the current install.",
      detail: `${currentEntrypoint} -> ${expectedEntrypoint}`,
      level: "recommended",
    });
  }

  if (audit.issues.length === 0) return;

  note(
    audit.issues
      .map((issue) =>
        issue.detail
          ? `- ${issue.message} (${issue.detail})`
          : `- ${issue.message}`,
      )
      .join("\n"),
    "Gateway service config",
  );

  const aggressiveIssues = audit.issues.filter(
    (issue) => issue.level === "aggressive",
  );
  const needsAggressive = aggressiveIssues.length > 0;

  if (needsAggressive && !prompter.shouldForce) {
    note(
      "Custom or unexpected service edits detected. Rerun with --force to overwrite.",
      "Gateway service config",
    );
  }

  const repair = needsAggressive
    ? await prompter.confirmAggressive({
        message: "Overwrite gateway service config with current defaults now?",
        initialValue: Boolean(prompter.shouldForce),
      })
    : await prompter.confirmRepair({
        message:
          "Update gateway service config to the recommended defaults now?",
        initialValue: true,
      });
  if (!repair) return;
  const environment = buildServiceEnvironment({
    env: process.env,
    port,
    token: cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(process.env.CLAWDBOT_PROFILE)
        : undefined,
  });

  try {
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    runtime.error(`Gateway service update failed: ${String(err)}`);
  }
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
