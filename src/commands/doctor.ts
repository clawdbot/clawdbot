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
import { resolveGatewayLogPaths } from "../daemon/launchd.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, sleep } from "../utils.js";
import { maybeRepairAnthropicOAuthProfileId } from "./doctor-auth.js";
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

function formatRuntimeSummary(
  runtime: GatewayServiceRuntime | undefined,
): string | null {
  if (!runtime) return null;
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) details.push(`pid ${runtime.pid}`);
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  if (runtime.subState) details.push(`sub ${runtime.subState}`);
  if (runtime.lastExitStatus !== undefined) {
    details.push(`last exit ${runtime.lastExitStatus}`);
  }
  if (runtime.lastExitReason) {
    details.push(`reason ${runtime.lastExitReason}`);
  }
  if (runtime.lastRunResult) {
    details.push(`last run ${runtime.lastRunResult}`);
  }
  if (runtime.lastRunTime) {
    details.push(`last run time ${runtime.lastRunTime}`);
  }
  if (runtime.detail) details.push(runtime.detail);
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
}

function buildGatewayRuntimeHints(
  runtime: GatewayServiceRuntime | undefined,
): string[] {
  const hints: string[] = [];
  if (!runtime) return hints;
  if (runtime.cachedLabel && process.platform === "darwin") {
    hints.push(
      `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${GATEWAY_LAUNCH_AGENT_LABEL}`,
    );
  }
  if (runtime.status === "stopped") {
    hints.push(
      "Service is loaded but not running (likely exited immediately).",
    );
    if (process.platform === "darwin") {
      const logs = resolveGatewayLogPaths(process.env);
      hints.push(`Logs: ${logs.stdoutPath}`);
      hints.push(`Errors: ${logs.stderrPath}`);
    } else if (process.platform === "linux") {
      hints.push(
        "Logs: journalctl --user -u clawdbot-gateway.service -n 200 --no-pager",
      );
    } else if (process.platform === "win32") {
      hints.push('Logs: schtasks /Query /TN "Clawdbot Gateway" /V /FO LIST');
    }
  }
  return hints;
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
    } else {
      runtime.error(`Health check failed: ${message}`);
    }
  }

  if (!healthOk) {
    if (resolveMode(cfg) === "local") {
      const port = resolveGatewayPort(cfg, process.env);
      const diagnostics = await inspectPortUsage(port);
      if (diagnostics.status === "busy") {
        note(formatPortDiagnostics(diagnostics).join("\n"), "Gateway port");
      }
    }
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (!loaded) {
      note("Gateway daemon not installed.", "Gateway");
    } else {
      const serviceRuntime = await service
        .readRuntime(process.env)
        .catch(() => undefined);
      const summary = formatRuntimeSummary(serviceRuntime);
      const hints = buildGatewayRuntimeHints(serviceRuntime);
      if (summary || hints.length > 0) {
        const lines = [];
        if (summary) lines.push(`Runtime: ${summary}`);
        lines.push(...hints);
        note(lines.join("\n"), "Gateway");
      }
      if (process.platform === "darwin") {
        note(
          `LaunchAgent loaded; stopping requires "clawdbot gateway stop" or launchctl bootout gui/$UID/${GATEWAY_LAUNCH_AGENT_LABEL}.`,
          "Gateway",
        );
      }
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
          } else {
            runtime.error(`Health check failed: ${message}`);
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
