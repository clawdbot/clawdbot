import fs from "node:fs";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import { maybeRepairLegacyOAuthProfileIds } from "../commands/doctor-auth-legacy-oauth.js";
import { noteAuthProfileHealth, noteLegacyCodexProviderOverride } from "../commands/doctor-auth.js";
import { noteBootstrapFileSize } from "../commands/doctor-bootstrap-size.js";
import { noteChromeMcpBrowserReadiness } from "../commands/doctor-browser.js";
import { maybeRepairBundledPluginRuntimeDeps } from "../commands/doctor-bundled-plugin-runtime-deps.js";
import { noteClaudeCliHealth } from "../commands/doctor-claude-cli.js";
import { doctorShellCompletion } from "../commands/doctor-completion.js";
import { maybeRepairLegacyCronStore } from "../commands/doctor-cron.js";
import { noteDevicePairingHealth } from "../commands/doctor-device-pairing.js";
import { maybeRepairGatewayDaemon } from "../commands/doctor-gateway-daemon-flow.js";
import { checkGatewayHealth, probeGatewayMemoryStatus } from "../commands/doctor-gateway-health.js";
import {
  maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices,
} from "../commands/doctor-gateway-services.js";
import {
  maybeRepairMemoryRecallHealth,
  noteMemoryRecallHealth,
  noteMemorySearchHealth,
} from "../commands/doctor-memory-search.js";
import {
  noteMacLaunchAgentOverrides,
  noteMacLaunchctlGatewayEnvOverrides,
} from "../commands/doctor-platform-notes.js";
import { maybeRepairLegacyPluginManifestContracts } from "../commands/doctor-plugin-manifests.js";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import { maybeRepairSandboxImages, noteSandboxScopeWarnings } from "../commands/doctor-sandbox.js";
import { noteSecurityWarnings } from "../commands/doctor-security.js";
import { noteSessionLockHealth } from "../commands/doctor-session-locks.js";
import { noteStateIntegrity, noteWorkspaceBackupTip } from "../commands/doctor-state-integrity.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "../commands/doctor-state-migrations.js";
import { noteWorkspaceStatus } from "../commands/doctor-workspace-status.js";
import { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } from "../commands/doctor-workspace.js";
import { noteOpenAIOAuthTlsPrerequisites } from "../commands/oauth-tls-preflight.js";
import { applyWizardMetadata, randomToken } from "../commands/onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "../commands/systemd-linger.js";
import { CONFIG_PATH, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayService } from "../daemon/service.js";
import { hasAmbiguousGatewayAuthModeConfig } from "../gateway/auth-mode-policy.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { maybeRunDoctorStartupChannelMaintenance } from "./doctor-startup-channel-maintenance.js";
import type { FlowContribution } from "./types.js";

export type DoctorFlowMode = "local" | "remote";

export type DoctorConfigResult = {
  cfg: OpenClawConfig;
  path?: string;
  shouldWriteConfig?: boolean;
  sourceConfigValid?: boolean;
};

export type DoctorHealthFlowContext = {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  prompter: DoctorPrompter;
  configResult: DoctorConfigResult;
  cfg: OpenClawConfig;
  cfgForPersistence: OpenClawConfig;
  sourceConfigValid: boolean;
  configPath: string;
  gatewayDetails?: ReturnType<typeof buildGatewayConnectionDetails>;
  healthOk?: boolean;
  gatewayMemoryProbe?: Awaited<ReturnType<typeof probeGatewayMemoryStatus>>;
};

export type DoctorHealthContribution = FlowContribution & {
  kind: "core";
  surface: "health";
  run: (ctx: DoctorHealthFlowContext) => Promise<void>;
};

export function resolveDoctorMode(cfg: OpenClawConfig): DoctorFlowMode {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

function createDoctorHealthContribution(params: {
  id: string;
  label: string;
  hint?: string;
  run: (ctx: DoctorHealthFlowContext) => Promise<void>;
}): DoctorHealthContribution {
  return {
    id: params.id,
    kind: "core",
    surface: "health",
    option: {
      value: params.id,
      label: params.label,
      ...(params.hint ? { hint: params.hint } : {}),
    },
    source: "doctor",
    run: params.run,
  };
}

async function runGatewayConfigHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (!ctx.cfg.gateway?.mode) {
    const lines = [
      "gateway.mode is unset; gateway start will be blocked.",
      `Fix: run ${formatCliCommand("openclaw configure")} and set Gateway mode (local/remote).`,
      `Or set directly: ${formatCliCommand("openclaw config set gateway.mode local")}`,
    ];
    if (!fs.existsSync(ctx.configPath)) {
      lines.push(`Missing config: run ${formatCliCommand("openclaw setup")} first.`);
    }
    note(lines.join("\n"), "Gateway");
  }
  if (resolveDoctorMode(ctx.cfg) === "local" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) {
    note(
      [
        "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset.",
        "Set an explicit mode to avoid ambiguous auth selection and startup/runtime failures.",
        `Set token mode: ${formatCliCommand("openclaw config set gateway.auth.mode token")}`,
        `Set password mode: ${formatCliCommand("openclaw config set gateway.auth.mode password")}`,
      ].join("\n"),
      "Gateway auth",
    );
  }
}

async function runAuthProfileHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  ctx.cfg = await maybeRepairLegacyOAuthProfileIds(ctx.cfg, ctx.prompter);
  await noteAuthProfileHealth({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
    allowKeychainPrompt: ctx.options.nonInteractive !== true && process.stdin.isTTY,
  });
  noteLegacyCodexProviderOverride(ctx.cfg);
  ctx.gatewayDetails = buildGatewayConnectionDetails({ config: ctx.cfg });
  if (ctx.gatewayDetails.remoteFallbackNote) {
    note(ctx.gatewayDetails.remoteFallbackNote, "Gateway");
  }
}

async function runGatewayAuthHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (resolveDoctorMode(ctx.cfg) !== "local" || !ctx.sourceConfigValid) {
    return;
  }
  const gatewayTokenRef = resolveSecretInputRef({
    value: ctx.cfg.gateway?.auth?.token,
    defaults: ctx.cfg.secrets?.defaults,
  }).ref;
  const auth = resolveGatewayAuth({
    authConfig: ctx.cfg.gateway?.auth,
    tailscaleMode: ctx.cfg.gateway?.tailscale?.mode ?? "off",
  });
  const needsToken = auth.mode !== "password" && (auth.mode !== "token" || !auth.token);
  if (!needsToken) {
    return;
  }
  if (gatewayTokenRef) {
    note(
      [
        "Gateway token is managed via SecretRef and is currently unavailable.",
        "Doctor will not overwrite gateway.auth.token with a plaintext value.",
        "Resolve/rotate the external secret source, then rerun doctor.",
      ].join("\n"),
      "Gateway auth",
    );
    return;
  }

  note(
    "Gateway auth is off or missing a token. Token auth is now the recommended default (including loopback).",
    "Gateway auth",
  );
  const shouldSetToken =
    ctx.options.generateGatewayToken === true
      ? true
      : ctx.options.nonInteractive === true
        ? false
        : await ctx.prompter.confirmAutoFix({
            message: "Generate and configure a gateway token now?",
            initialValue: true,
          });
  if (!shouldSetToken) {
    return;
  }
  const nextToken = randomToken();
  ctx.cfg = {
    ...ctx.cfg,
    gateway: {
      ...ctx.cfg.gateway,
      auth: {
        ...ctx.cfg.gateway?.auth,
        mode: "token",
        token: nextToken,
      },
    },
  };
  note("Gateway token configured.", "Gateway auth");
}

async function runClaudeCliHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  noteClaudeCliHealth(ctx.cfg);
}

async function runLegacyStateHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const legacyState = await detectLegacyStateMigrations({ cfg: ctx.cfg });
  if (legacyState.preview.length === 0) {
    return;
  }
  note(legacyState.preview.join("\n"), "Legacy state detected");
  const migrate =
    ctx.options.nonInteractive === true
      ? true
      : await ctx.prompter.confirm({
          message: "Migrate legacy state (sessions/agent/WhatsApp auth) now?",
          initialValue: true,
        });
  if (!migrate) {
    return;
  }
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

async function runLegacyPluginManifestHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await maybeRepairLegacyPluginManifestContracts({
    env: process.env,
    runtime: ctx.runtime,
    prompter: ctx.prompter,
  });
}

async function runBundledPluginRuntimeDepsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await maybeRepairBundledPluginRuntimeDeps({
    runtime: ctx.runtime,
    prompter: ctx.prompter,
    config: ctx.cfg,
  });
}

async function runStateIntegrityHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await noteStateIntegrity(ctx.cfg, ctx.prompter, ctx.configPath);
}

async function runSessionLocksHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await noteSessionLockHealth({ shouldRepair: ctx.prompter.shouldRepair });
}

async function runLegacyCronHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await maybeRepairLegacyCronStore({
    cfg: ctx.cfg,
    options: ctx.options,
    prompter: ctx.prompter,
  });
}

async function runSandboxHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  ctx.cfg = await maybeRepairSandboxImages(ctx.cfg, ctx.runtime, ctx.prompter);
  noteSandboxScopeWarnings(ctx.cfg);
}

async function runGatewayServicesHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await maybeScanExtraGatewayServices(ctx.options, ctx.runtime, ctx.prompter);
  await maybeRepairGatewayServiceConfig(
    ctx.cfg,
    resolveDoctorMode(ctx.cfg),
    ctx.runtime,
    ctx.prompter,
  );
  await noteMacLaunchAgentOverrides();
  await noteMacLaunchctlGatewayEnvOverrides(ctx.cfg);
}

async function runStartupChannelMaintenanceHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await maybeRunDoctorStartupChannelMaintenance({
    cfg: ctx.cfg,
    env: process.env,
    runtime: ctx.runtime,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

async function runSecurityHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await noteSecurityWarnings(ctx.cfg);
}

async function runBrowserHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await noteChromeMcpBrowserReadiness(ctx.cfg);
}

async function runOpenAIOAuthTlsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await noteOpenAIOAuthTlsPrerequisites({
    cfg: ctx.cfg,
    deep: ctx.options.deep === true,
  });
}

async function runHooksModelHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (!ctx.cfg.hooks?.gmail?.model?.trim()) {
    return;
  }
  const hooksModelRef = resolveHooksGmailModel({
    cfg: ctx.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  if (!hooksModelRef) {
    note(`- hooks.gmail.model "${ctx.cfg.hooks.gmail.model}" could not be resolved`, "Hooks");
    return;
  }
  const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
    cfg: ctx.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const catalog = await loadModelCatalog({ config: ctx.cfg });
  const status = getModelRefStatus({
    cfg: ctx.cfg,
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

async function runSystemdLingerHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (
    ctx.options.nonInteractive === true ||
    process.platform !== "linux" ||
    resolveDoctorMode(ctx.cfg) !== "local"
  ) {
    return;
  }
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (!loaded) {
    return;
  }
  await ensureSystemdUserLingerInteractive({
    runtime: ctx.runtime,
    prompter: {
      confirm: async (p) => ctx.prompter.confirm(p),
      note,
    },
    reason:
      "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
    requireConfirm: true,
  });
}

async function runWorkspaceStatusHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  noteWorkspaceStatus(ctx.cfg);
}

async function runBootstrapSizeHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await noteBootstrapFileSize(ctx.cfg);
}

async function runShellCompletionHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await doctorShellCompletion(ctx.runtime, ctx.prompter, {
    nonInteractive: ctx.options.nonInteractive,
  });
}

async function runGatewayHealthChecks(ctx: DoctorHealthFlowContext): Promise<void> {
  const { healthOk } = await checkGatewayHealth({
    runtime: ctx.runtime,
    cfg: ctx.cfg,
    timeoutMs: ctx.options.nonInteractive === true ? 3000 : 10_000,
  });
  ctx.healthOk = healthOk;
  ctx.gatewayMemoryProbe = healthOk
    ? await probeGatewayMemoryStatus({
        cfg: ctx.cfg,
        timeoutMs: ctx.options.nonInteractive === true ? 3000 : 10_000,
      })
    : { checked: false, ready: false };
}

async function runMemorySearchHealthContribution(ctx: DoctorHealthFlowContext): Promise<void> {
  await maybeRepairMemoryRecallHealth({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
  });
  await noteMemorySearchHealth(ctx.cfg, {
    gatewayMemoryProbe: ctx.gatewayMemoryProbe ?? { checked: false, ready: false },
  });
  await noteMemoryRecallHealth(ctx.cfg);
}

async function runDevicePairingHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await noteDevicePairingHealth({
    cfg: ctx.cfg,
    healthOk: ctx.healthOk ?? false,
  });
}

async function runGatewayDaemonHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  await maybeRepairGatewayDaemon({
    cfg: ctx.cfg,
    runtime: ctx.runtime,
    prompter: ctx.prompter,
    options: ctx.options,
    gatewayDetailsMessage: ctx.gatewayDetails?.message ?? "",
    healthOk: ctx.healthOk ?? false,
  });
}

async function runWriteConfigHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const shouldWriteConfig =
    ctx.configResult.shouldWriteConfig ||
    JSON.stringify(ctx.cfg) !== JSON.stringify(ctx.cfgForPersistence);
  if (shouldWriteConfig) {
    ctx.cfg = applyWizardMetadata(ctx.cfg, {
      command: "doctor",
      mode: resolveDoctorMode(ctx.cfg),
    });
    await writeConfigFile(ctx.cfg);
    logConfigUpdated(ctx.runtime);
    const backupPath = `${CONFIG_PATH}.bak`;
    if (fs.existsSync(backupPath)) {
      ctx.runtime.log(`Backup: ${shortenHomePath(backupPath)}`);
    }
    return;
  }
  if (!ctx.prompter.shouldRepair) {
    ctx.runtime.log(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply changes.`);
  }
}

async function runWorkspaceSuggestionsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (ctx.options.workspaceSuggestions === false) {
    return;
  }
  const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
  noteWorkspaceBackupTip(workspaceDir);
  if (await shouldSuggestMemorySystem(workspaceDir)) {
    note(MEMORY_SYSTEM_PROMPT, "Workspace");
  }
}

async function runFinalConfigValidationHealth(_ctx: DoctorHealthFlowContext): Promise<void> {
  const finalSnapshot = await readConfigFileSnapshot();
  if (finalSnapshot.exists && !finalSnapshot.valid) {
    _ctx.runtime.error("Invalid config:");
    for (const issue of finalSnapshot.issues) {
      const path = issue.path || "<root>";
      _ctx.runtime.error(`- ${path}: ${issue.message}`);
    }
  }
}

export function resolveDoctorHealthContributions(): DoctorHealthContribution[] {
  return [
    createDoctorHealthContribution({
      id: "doctor:gateway-config",
      label: "Gateway config",
      run: runGatewayConfigHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:auth-profiles",
      label: "Auth profiles",
      run: runAuthProfileHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:claude-cli",
      label: "Claude CLI",
      run: runClaudeCliHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-auth",
      label: "Gateway auth",
      run: runGatewayAuthHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-state",
      label: "Legacy state",
      run: runLegacyStateHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-plugin-manifests",
      label: "Legacy plugin manifests",
      run: runLegacyPluginManifestHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:bundled-plugin-runtime-deps",
      label: "Bundled plugin runtime deps",
      run: runBundledPluginRuntimeDepsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:state-integrity",
      label: "State integrity",
      run: runStateIntegrityHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:session-locks",
      label: "Session locks",
      run: runSessionLocksHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-cron",
      label: "Legacy cron",
      run: runLegacyCronHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:sandbox",
      label: "Sandbox",
      run: runSandboxHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-services",
      label: "Gateway services",
      run: runGatewayServicesHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:startup-channel-maintenance",
      label: "Startup channel maintenance",
      run: runStartupChannelMaintenanceHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:security",
      label: "Security",
      run: runSecurityHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:browser",
      label: "Browser",
      run: runBrowserHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:oauth-tls",
      label: "OAuth TLS",
      run: runOpenAIOAuthTlsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:hooks-model",
      label: "Hooks model",
      run: runHooksModelHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:systemd-linger",
      label: "systemd linger",
      run: runSystemdLingerHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:workspace-status",
      label: "Workspace status",
      run: runWorkspaceStatusHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:bootstrap-size",
      label: "Bootstrap size",
      run: runBootstrapSizeHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:shell-completion",
      label: "Shell completion",
      run: runShellCompletionHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-health",
      label: "Gateway health",
      run: runGatewayHealthChecks,
    }),
    createDoctorHealthContribution({
      id: "doctor:memory-search",
      label: "Memory search",
      run: runMemorySearchHealthContribution,
    }),
    createDoctorHealthContribution({
      id: "doctor:device-pairing",
      label: "Device pairing",
      run: runDevicePairingHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-daemon",
      label: "Gateway daemon",
      run: runGatewayDaemonHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:write-config",
      label: "Write config",
      run: runWriteConfigHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:workspace-suggestions",
      label: "Workspace suggestions",
      run: runWorkspaceSuggestionsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:final-config-validation",
      label: "Final config validation",
      run: runFinalConfigValidationHealth,
    }),
  ];
}

export async function runDoctorHealthContributions(ctx: DoctorHealthFlowContext): Promise<void> {
  for (const contribution of resolveDoctorHealthContributions()) {
    await contribution.run(ctx);
  }
}
