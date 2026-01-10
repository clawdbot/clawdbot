import path from "node:path";
import {
  intro as clackIntro,
  note as clackNote,
  outro as clackOutro,
} from "@clack/prompts";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
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
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { resolveClawdbotPackageRoot } from "../infra/clawdbot-root.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { collectProvidersStatusIssues } from "../infra/providers-status-issues.js";
import { runGatewayUpdate } from "../infra/update-runner.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { sleep } from "../utils.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import {
  maybeRepairAnthropicOAuthProfileId,
  noteAuthProfileHealth,
} from "./doctor-auth.js";
import {
  buildGatewayRuntimeHints,
  formatGatewayRuntimeSummary,
} from "./doctor-format.js";
import {
  maybeMigrateLegacyGatewayService,
  maybeRepairGatewayServiceConfig,
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
import { formatHealthCheckFailure } from "./health-format.js";
import { applyWizardMetadata, printWizardHeader } from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

const intro = (message: string) =>
  clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) =>
  clackOutro(stylePromptTitle(message) ?? message);
const note = (message: string, title?: string) =>
  clackNote(message, stylePromptTitle(title));

function resolveMode(cfg: ClawdbotConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function noteOpencodeProviderOverrides(cfg: ClawdbotConfig) {
  const providers = cfg.models?.providers;
  if (!providers) return;

  // 2026-01-10: warn when OpenCode Zen overrides mask built-in routing/costs (8a194b4abc360c6098f157956bb9322576b44d51, 2d105d16f8a099276114173836d46b46cdfbdbae).
  const overrides: string[] = [];
  if (providers.opencode) overrides.push("opencode");
  if (providers["opencode-zen"]) overrides.push("opencode-zen");
  if (overrides.length === 0) return;

  const lines = overrides.flatMap((id) => {
    const providerEntry = providers[id];
    const api =
      isRecord(providerEntry) && typeof providerEntry.api === "string"
        ? providerEntry.api
        : undefined;
    return [
      `- models.providers.${id} is set; this overrides the built-in OpenCode Zen catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run onboarding if needed).",
  );

  note(lines.join("\n"), "OpenCode Zen");
}

async function detectClawdbotGitCheckout(
  root: string,
): Promise<"git" | "not-git" | "unknown"> {
  const res = await runCommandWithTimeout(
    ["git", "-C", root, "rev-parse", "--show-toplevel"],
    { timeoutMs: 5000 },
  ).catch(() => null);
  if (!res) return "unknown";
  if (res.code !== 0) {
    // Avoid noisy "Update via package manager" notes when git is missing/broken,
    // but do show it when this is clearly not a git checkout.
    if (res.stderr.toLowerCase().includes("not a git repository")) {
      return "not-git";
    }
    return "unknown";
  }
  return res.stdout.trim() === root ? "git" : "not-git";
}

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  const prompter = createDoctorPrompter({ runtime, options });
  printWizardHeader(runtime);
  intro("Clawdbot doctor");

  const updateInProgress = process.env.CLAWDBOT_UPDATE_IN_PROGRESS === "1";
  const canOfferUpdate =
    !updateInProgress &&
    options.nonInteractive !== true &&
    options.yes !== true &&
    options.repair !== true &&
    Boolean(process.stdin.isTTY);
  if (canOfferUpdate) {
    const root = await resolveClawdbotPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
    if (root) {
      const git = await detectClawdbotGitCheckout(root);
      if (git === "git") {
        const shouldUpdate = await prompter.confirm({
          message: "Update Clawdbot from git before running doctor?",
          initialValue: true,
        });
        if (shouldUpdate) {
          note(
            "Running update (fetch/rebase/build/ui:build/doctor)…",
            "Update",
          );
          const result = await runGatewayUpdate({
            cwd: root,
            argv1: process.argv[1],
          });
          note(
            [
              `Status: ${result.status}`,
              `Mode: ${result.mode}`,
              result.root ? `Root: ${result.root}` : null,
              result.reason ? `Reason: ${result.reason}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
            "Update result",
          );
          if (result.status === "ok") {
            outro(
              "Update completed (doctor already ran as part of the update).",
            );
            return;
          }
        }
      } else if (git === "not-git") {
        note(
          [
            "This install is not a git checkout.",
            "Update via your package manager, then rerun doctor:",
            "- npm i -g clawdbot@latest",
            "- pnpm add -g clawdbot@latest",
            "- bun add -g clawdbot@latest",
          ].join("\n"),
          "Update",
        );
      }
    }
  }

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
    const migrate =
      options.nonInteractive === true
        ? true
        : await prompter.confirm({
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

  noteOpencodeProviderOverrides(cfg);

  cfg = await maybeRepairAnthropicOAuthProfileId(cfg, prompter);
  await noteAuthProfileHealth({
    cfg,
    prompter,
    allowKeychainPrompt:
      options.nonInteractive !== true && Boolean(process.stdin.isTTY),
  });
  const gatewayDetails = buildGatewayConnectionDetails({ config: cfg });
  if (gatewayDetails.remoteFallbackNote) {
    note(gatewayDetails.remoteFallbackNote, "Gateway");
  }

  const legacyState = await detectLegacyStateMigrations({ cfg });
  if (legacyState.preview.length > 0) {
    note(legacyState.preview.join("\n"), "Legacy state detected");
    const migrate =
      options.nonInteractive === true
        ? true
        : await prompter.confirm({
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

  await noteStateIntegrity(
    cfg,
    prompter,
    snapshot.path ?? CONFIG_PATH_CLAWDBOT,
  );

  cfg = await maybeRepairSandboxImages(cfg, runtime, prompter);
  noteSandboxScopeWarnings(cfg);

  await maybeMigrateLegacyGatewayService(
    cfg,
    resolveMode(cfg),
    runtime,
    prompter,
  );
  await maybeScanExtraGatewayServices(options);
  await maybeRepairGatewayServiceConfig(
    cfg,
    resolveMode(cfg),
    runtime,
    prompter,
  );

  await noteSecurityWarnings(cfg);

  if (cfg.hooks?.gmail?.model?.trim()) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (!hooksModelRef) {
      note(
        `- hooks.gmail.model "${cfg.hooks.gmail.model}" could not be resolved`,
        "Hooks",
      );
    } else {
      const { provider: defaultProvider, model: defaultModel } =
        resolveConfiguredModelRef({
          cfg,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        });
      const catalog = await loadModelCatalog({ config: cfg });
      const status = getModelRefStatus({
        cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      const warnings: string[] = [];
      if (!status.allowed) {
        warnings.push(
          `- hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        warnings.push(
          `- hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
      if (warnings.length > 0) {
        note(warnings.join("\n"), "Hooks");
      }
    }
  }

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

  const workspaceDir = resolveAgentWorkspaceDir(
    cfg,
    resolveDefaultAgentId(cfg),
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
      runtime.error(formatHealthCheckFailure(err));
    }
  }

  if (healthOk) {
    try {
      const status = await callGateway<Record<string, unknown>>({
        method: "providers.status",
        params: { probe: true, timeoutMs: 5000 },
        timeoutMs: 6000,
      });
      const issues = collectProvidersStatusIssues(status);
      if (issues.length > 0) {
        note(
          issues
            .map(
              (issue) =>
                `- ${issue.provider} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`,
            )
            .join("\n"),
          "Provider warnings",
        );
      }
    } catch {
      // ignore: doctor already reported gateway health
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
            token:
              cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
            launchdLabel:
              process.platform === "darwin"
                ? GATEWAY_LAUNCH_AGENT_LABEL
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
              runtime.error(formatHealthCheckFailure(err));
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
    const workspaceDir = resolveAgentWorkspaceDir(
      cfg,
      resolveDefaultAgentId(cfg),
    );
    noteWorkspaceBackupTip(workspaceDir);
    if (await shouldSuggestMemorySystem(workspaceDir)) {
      note(MEMORY_SYSTEM_PROMPT, "Workspace");
    }
  }

  outro("Doctor complete.");
}
