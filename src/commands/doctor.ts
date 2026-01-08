import path from "node:path";
import { intro, note, outro } from "@clack/prompts";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, sleep } from "../utils.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { maybeRepairAnthropicOAuthProfileId } from "./doctor-auth.js";
import {
  buildGatewayRuntimeHints,
  formatGatewayRuntimeSummary,
} from "./doctor-format.js";
import {
  maybeMigrateLegacyGatewayService,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";
import {
  maybeMigrateLegacyConfigFile,
  normalizeLegacyConfigValues,
} from "./doctor-legacy-config.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";
import {
  maybeRepairSandboxImages,
  noteSandboxScopeWarnings,
} from "./doctor-sandbox.js";
import { noteSecurityWarnings } from "./doctor-security.js";
import {
  noteStateIntegrity,
  noteWorkspaceBackupTip,
} from "./doctor-state-integrity.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";
import {
  detectLegacyWorkspaceDirs,
  formatLegacyWorkspaceWarning,
  MEMORY_SYSTEM_PROMPT,
  shouldSuggestMemorySystem,
} from "./doctor-workspace.js";
import { healthCommand } from "./health.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  printWizardHeader,
} from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

function resolveMode(cfg: ClawdbotConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  const prompter = createDoctorPrompter({ runtime, options });
  printWizardHeader(runtime);
  intro("Clawdbot doctor");

  await maybeMigrateLegacyConfigFile(runtime);

  const snapshot = await readConfigFileSnapshot();
  let cfg: ClawdbotConfig = snapshot.valid ? snapshot.config : {};
  if (
    snapshot.exists &&
    !snapshot.valid &&
    snapshot.legacyIssues.length === 0
  ) {
    note("Config invalid; doctor will run with defaults.", "Config");
  }

  if (snapshot.legacyIssues.length > 0) {
    note(
      snapshot.legacyIssues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n"),
      "Legacy config keys detected",
    );
    const migrate = await prompter.confirm({
      message: "Migrate legacy config entries now?",
      initialValue: true,
    });
    if (migrate) {
      // Legacy migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into whatsapp.allowFrom.
      const { config: migrated, changes } = migrateLegacyConfig(
        snapshot.parsed,
      );
      if (changes.length > 0) {
        note(changes.join("\n"), "Doctor changes");
      }
      if (migrated) {
        cfg = migrated;
      }
    }
  }

  const normalized = normalizeLegacyConfigValues(cfg);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    cfg = normalized.config;
  }

  cfg = await maybeRepairAnthropicOAuthProfileId(cfg, prompter);
  const gatewayDetails = buildGatewayConnectionDetails({ config: cfg });
  if (gatewayDetails.remoteFallbackNote) {
    note(gatewayDetails.remoteFallbackNote, "Gateway");
  }

  const legacyState = await detectLegacyStateMigrations({ cfg });
  if (legacyState.preview.length > 0) {
    note(legacyState.preview.join("\n"), "Legacy state detected");
    const migrate = await prompter.confirm({
      message: "Migrate legacy state (sessions/agent/WhatsApp auth) now?",
      initialValue: true,
    });
    if (migrate) {
      const migrated = await runLegacyStateMigrations({
        detected: legacyState,
      });
      if (migrated.changes.length > 0) {
        note(migrated.changes.join("\n"), "Doctor changes");
      }
      if (migrated.warnings.length > 0) {
        note(migrated.warnings.join("\n"), "Doctor warnings");
      }
    }
  }

  await noteStateIntegrity(cfg, prompter);

  cfg = await maybeRepairSandboxImages(cfg, runtime, prompter);
  noteSandboxScopeWarnings(cfg);

  await maybeMigrateLegacyGatewayService(
    cfg,
    resolveMode(cfg),
    runtime,
    prompter,
  );
  await maybeScanExtraGatewayServices(options);

  await noteSecurityWarnings(cfg);

  if (
    options.nonInteractive !== true &&
    process.platform === "linux" &&
    resolveMode(cfg) === "local"
  ) {
    const service = resolveGatewayService();
    let loaded = false;
    try {
      loaded = await service.isLoaded({ env: process.env });
    } catch {
      loaded = false;
    }
    if (loaded) {
      await ensureSystemdUserLingerInteractive({
        runtime,
        prompter: {
          confirm: async (p) => prompter.confirm(p),
          note,
        },
        reason:
          "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
        requireConfirm: true,
      });
    }
  }

  const workspaceDir = resolveUserPath(
    cfg.agent?.workspace ?? DEFAULT_WORKSPACE,
  );
  const legacyWorkspace = detectLegacyWorkspaceDirs({ workspaceDir });
  if (legacyWorkspace.legacyDirs.length > 0) {
    note(formatLegacyWorkspaceWarning(legacyWorkspace), "Legacy workspace");
  }
  const skillsReport = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  note(
    [
      `Eligible: ${skillsReport.skills.filter((s) => s.eligible).length}`,
      `Missing requirements: ${
        skillsReport.skills.filter(
          (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
        ).length
      }`,
      `Blocked by allowlist: ${
        skillsReport.skills.filter((s) => s.blockedByAllowlist).length
      }`,
    ].join("\n"),
    "Skills status",
  );

  let healthOk = false;
  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    healthOk = true;
  } catch (err) {
    const message = String(err);
    if (message.includes("gateway closed")) {
      note("Gateway not running.", "Gateway");
      note(gatewayDetails.message, "Gateway connection");
    } else {
      runtime.error(`Health check failed: ${message}`);
    }
  }

  if (!healthOk) {
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    let serviceRuntime:
      | Awaited<ReturnType<typeof service.readRuntime>>
      | undefined;
    if (loaded) {
      serviceRuntime = await service
        .readRuntime(process.env)
        .catch(() => undefined);
    }
    if (resolveMode(cfg) === "local") {
      const port = resolveGatewayPort(cfg, process.env);
      const diagnostics = await inspectPortUsage(port);
      if (diagnostics.status === "busy") {
        note(formatPortDiagnostics(diagnostics).join("\n"), "Gateway port");
      } else if (loaded && serviceRuntime?.status === "running") {
        const lastError = await readLastGatewayErrorLine(process.env);
        if (lastError) {
          note(`Last gateway error: ${lastError}`, "Gateway");
        }
      }
    }
    if (!loaded) {
      note("Gateway daemon not installed.", "Gateway");
      if (resolveMode(cfg) === "local") {
        const install = await prompter.confirmSkipInNonInteractive({
          message: "Install gateway daemon now?",
          initialValue: true,
        });
        if (install) {
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
            CLAWDBOT_PROFILE: process.env.CLAWDBOT_PROFILE,
            CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR,
            CLAWDBOT_CONFIG_PATH: process.env.CLAWDBOT_CONFIG_PATH,
            CLAWDBOT_GATEWAY_PORT: String(port),
            CLAWDBOT_GATEWAY_TOKEN:
              cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
            CLAWDBOT_LAUNCHD_LABEL:
              process.platform === "darwin"
                ? GATEWAY_LAUNCH_AGENT_LABEL
                : undefined,
          };
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
          });
        }
      }
    } else {
      const summary = formatGatewayRuntimeSummary(serviceRuntime);
      const hints = buildGatewayRuntimeHints(serviceRuntime, {
        platform: process.platform,
        env: process.env,
      });
      if (summary || hints.length > 0) {
        const lines = [];
        if (summary) lines.push(`Runtime: ${summary}`);
        lines.push(...hints);
        note(lines.join("\n"), "Gateway");
      }
      if (serviceRuntime?.status !== "running") {
        const start = await prompter.confirmSkipInNonInteractive({
          message: "Start gateway daemon now?",
          initialValue: true,
        });
        if (start) {
          await service.restart({ stdout: process.stdout });
          await sleep(1500);
        }
      }
      if (process.platform === "darwin") {
        note(
          `LaunchAgent loaded; stopping requires "clawdbot daemon stop" or launchctl bootout gui/$UID/${GATEWAY_LAUNCH_AGENT_LABEL}.`,
          "Gateway",
        );
      }
      if (serviceRuntime?.status === "running") {
        const restart = await prompter.confirmSkipInNonInteractive({
          message: "Restart gateway daemon now?",
          initialValue: true,
        });
        if (restart) {
          await service.restart({ stdout: process.stdout });
          await sleep(1500);
          try {
            await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
          } catch (err) {
            const message = String(err);
            if (message.includes("gateway closed")) {
              note("Gateway not running.", "Gateway");
              note(gatewayDetails.message, "Gateway connection");
            } else {
              runtime.error(`Health check failed: ${message}`);
            }
          }
        }
      }
    }
  }

  cfg = applyWizardMetadata(cfg, { command: "doctor", mode: resolveMode(cfg) });
  await writeConfigFile(cfg);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

  if (options.workspaceSuggestions !== false) {
    const workspaceDir = resolveUserPath(
      cfg.agent?.workspace ?? DEFAULT_WORKSPACE,
    );
    noteWorkspaceBackupTip(workspaceDir);
    if (await shouldSuggestMemorySystem(workspaceDir)) {
      note(MEMORY_SYSTEM_PROMPT, "Workspace");
    }
  }

  outro("Doctor complete.");
}
