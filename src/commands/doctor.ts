import fs from "node:fs";

import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { ClawdbotConfig } from "../config/config.js";
import { CONFIG_PATH_CLAWDBOT, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveGatewayService } from "../daemon/service.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveClawdbotPackageRoot } from "../infra/clawdbot-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { shortenHomePath } from "../utils.js";
import { maybeRepairAnthropicOAuthProfileId, noteAuthProfileHealth } from "./doctor-auth.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { maybeRepairGatewayDaemon } from "./doctor-gateway-daemon-flow.js";
import { checkGatewayHealth } from "./doctor-gateway-health.js";
import {
  maybeMigrateLegacyGatewayService,
  maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";
import { noteSourceInstallIssues } from "./doctor-install.js";
import {
  noteMacLaunchAgentOverrides,
  noteMacLaunchctlGatewayEnvOverrides,
} from "./doctor-platform-notes.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";
import { maybeRepairSandboxImages, noteSandboxScopeWarnings } from "./doctor-sandbox.js";
import { noteSecurityWarnings } from "./doctor-security.js";
import { noteStateIntegrity, noteWorkspaceBackupTip } from "./doctor-state-integrity.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./doctor-state-migrations.js";
import { maybeRepairUiProtocolFreshness } from "./doctor-ui.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";
import { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } from "./doctor-workspace.js";
import { noteWorkspaceStatus } from "./doctor-workspace-status.js";
import { applyWizardMetadata, printWizardHeader, randomToken } from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

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

  const root = await resolveClawdbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime,
    options,
    root,
    confirm: (p) => prompter.confirm(p),
    outro,
  });
  if (updateResult.handled) return;

  await maybeRepairUiProtocolFreshness(runtime, prompter);
  noteSourceInstallIssues(root);

  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: (p) => prompter.confirm(p),
  });
  let cfg: ClawdbotConfig = configResult.cfg;

  const configPath = configResult.path ?? CONFIG_PATH_CLAWDBOT;
  if (!cfg.gateway?.mode) {
    const lines = [
      "gateway.mode is unset; gateway start will be blocked.",
      `Fix: run ${formatCliCommand("clawdbot configure")} and set Gateway mode (local/remote).`,
      `Or set directly: ${formatCliCommand("clawdbot config set gateway.mode local")}`,
    ];
    if (!fs.existsSync(configPath)) {
      lines.push(`Missing config: run ${formatCliCommand("clawdbot setup")} first.`);
    }
    note(lines.join("\n"), "Gateway");
  }

  cfg = await maybeRepairAnthropicOAuthProfileId(cfg, prompter);
  await noteAuthProfileHealth({
    cfg,
    prompter,
    allowKeychainPrompt: options.nonInteractive !== true && Boolean(process.stdin.isTTY),
  });
  const gatewayDetails = buildGatewayConnectionDetails({ config: cfg });
  if (gatewayDetails.remoteFallbackNote) {
    note(gatewayDetails.remoteFallbackNote, "Gateway");
  }
  if (resolveMode(cfg) === "local") {
    const auth = resolveGatewayAuth({
      authConfig: cfg.gateway?.auth,
      tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
    });
    const needsToken = auth.mode !== "password" && (auth.mode !== "token" || !auth.token);
    if (needsToken) {
      note(
        "Gateway auth is off or missing a token. Token auth is now the recommended default (including loopback).",
        "Gateway auth",
      );
      const shouldSetToken =
        options.generateGatewayToken === true
          ? true
          : options.nonInteractive === true
            ? false
            : await prompter.confirmRepair({
                message: "Generate and configure a gateway token now?",
                initialValue: true,
              });
      if (shouldSetToken) {
        const nextToken = randomToken();
        cfg = {
          ...cfg,
          gateway: {
            ...cfg.gateway,
            auth: {
              ...cfg.gateway?.auth,
              mode: "token",
              token: nextToken,
            },
          },
        };
        note("Gateway token configured.", "Gateway auth");
      }
    }
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

  await noteStateIntegrity(cfg, prompter, configResult.path ?? CONFIG_PATH_CLAWDBOT);

  cfg = await maybeRepairSandboxImages(cfg, runtime, prompter);
  noteSandboxScopeWarnings(cfg);

  await maybeMigrateLegacyGatewayService(cfg, resolveMode(cfg), runtime, prompter);
  await maybeScanExtraGatewayServices(options);
  await maybeRepairGatewayServiceConfig(cfg, resolveMode(cfg), runtime, prompter);
  await noteMacLaunchAgentOverrides();
  await noteMacLaunchctlGatewayEnvOverrides(cfg);

  await noteSecurityWarnings(cfg);

  if (cfg.hooks?.gmail?.model?.trim()) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (!hooksModelRef) {
      note(`- hooks.gmail.model "${cfg.hooks.gmail.model}" could not be resolved`, "Hooks");
    } else {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
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

  noteWorkspaceStatus(cfg);

  const { healthOk } = await checkGatewayHealth({
    runtime,
    cfg,
    timeoutMs: options.nonInteractive === true ? 3000 : 10_000,
  });
  await maybeRepairGatewayDaemon({
    cfg,
    runtime,
    prompter,
    options,
    gatewayDetailsMessage: gatewayDetails.message,
    healthOk,
  });

  const shouldWriteConfig = prompter.shouldRepair || configResult.shouldWriteConfig;
  if (shouldWriteConfig) {
    cfg = applyWizardMetadata(cfg, { command: "doctor", mode: resolveMode(cfg) });
    await writeConfigFile(cfg);
    logConfigUpdated(runtime);
    const backupPath = `${CONFIG_PATH_CLAWDBOT}.bak`;
    if (fs.existsSync(backupPath)) {
      runtime.log(`Backup: ${shortenHomePath(backupPath)}`);
    }
  } else {
    runtime.log(`Run "${formatCliCommand("clawdbot doctor --fix")}" to apply changes.`);
  }

  if (options.workspaceSuggestions !== false) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    noteWorkspaceBackupTip(workspaceDir);
    if (await shouldSuggestMemorySystem(workspaceDir)) {
      note(MEMORY_SYSTEM_PROMPT, "Workspace");
    }
  }

  const finalSnapshot = await readConfigFileSnapshot();
  if (finalSnapshot.exists && !finalSnapshot.valid) {
    runtime.error("Invalid config:");
    for (const issue of finalSnapshot.issues) {
      const path = issue.path || "<root>";
      runtime.error(`- ${path}: ${issue.message}`);
    }
  }

  outro("Doctor complete.");
}
