// Doctor core checks collect environment, config, and runtime readiness diagnostics.
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue,
  noteChromeMcpBrowserReadiness,
  type LegacyClawdBrowserProfileResidue,
} from "../commands/doctor-browser.js";
import { hasConfiguredCommandOwners } from "../commands/doctor-command-owner.js";
import {
  checkShellCompletionStatus,
  shellCompletionStatusToHealthFindings,
  shellCompletionStatusToRepairEffects,
} from "../commands/doctor-completion.js";
import {
  detectStaleSessionLocks,
  sessionLockToHealthFinding,
  sessionLockToRepairEffect,
} from "../commands/doctor-session-locks.js";
import {
  disableUnavailableSkillsInConfig,
  formatMissingSkillSummary,
} from "../commands/doctor-skills-core.js";
import {
  detectUiProtocolFreshnessIssues,
  uiProtocolFreshnessIssueToHealthFinding,
  uiProtocolFreshnessIssueToRepairEffects,
} from "../commands/doctor-ui.js";
import { collectDisabledCodexPluginRouteIssues } from "../commands/doctor/shared/codex-route-warnings.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef, type SecretRef } from "../config/types.secrets.js";
import { hasAmbiguousGatewayAuthModeConfig } from "../gateway/auth-mode-policy.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { getSkippedExecRefStaticError } from "../secrets/exec-resolution-policy.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import { detectSkillWorkshopToolPolicyDiagnostic } from "../skills/workshop/tool-policy-diagnostic.js";
import { registerHealthCheck } from "./health-check-registry.js";
import type { SplitHealthCheckInput } from "./health-check-runner-types.js";
import type {
  HealthCheck,
  HealthCheckContext,
  HealthFinding,
  HealthRepairContext,
} from "./health-checks.js";

const BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID = "core/doctor/browser-clawd-profile-residue";
const CODEX_SESSION_ROUTES_CHECK_ID = "core/doctor/codex-session-routes";
const FINAL_CONFIG_VALIDATION_CHECK_ID = "core/doctor/final-config-validation";
const GATEWAY_DAEMON_CHECK_ID = "core/doctor/gateway-daemon";
const GATEWAY_HEALTH_CHECK_ID = "core/doctor/gateway-health";
const GATEWAY_SERVICES_EXTRA_CHECK_ID = "core/doctor/gateway-services/extra";
const SESSION_LOCKS_CHECK_ID = "core/doctor/session-locks";
const SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID = "core/doctor/skill-workshop-tool-policy";

type CoreHealthCheckContext = HealthCheckContext & {
  readonly deep?: boolean;
};

type CoreHealthRepairContext = HealthRepairContext & {
  readonly deep?: boolean;
};

const loadDoctorCoreChecksRuntimeModule = async () =>
  await import("./doctor-core-checks.runtime.js");
const loadDoctorWorkspaceModule = async () => await import("../commands/doctor-workspace.js");

export type CoreHealthCheckDeps = {
  readonly detectUnavailableSkills: (cfg: OpenClawConfig) => Promise<readonly SkillStatusEntry[]>;
  readonly collectSecurityWarnings: (cfg: OpenClawConfig) => Promise<readonly string[]>;
  readonly collectWorkspaceSuggestionNotes: (workspaceDir: string) => Promise<readonly string[]>;
  readonly collectRuntimeToolSchemaFindings: (
    ctx: HealthCheckContext,
  ) => Promise<readonly HealthFinding[]>;
  readonly collectProviderCatalogProjectionFindings: (
    ctx: HealthCheckContext,
  ) => Promise<readonly HealthFinding[]>;
  readonly collectLocalAudioAccelerationFindings: () => Promise<readonly HealthFinding[]>;
  readonly collectGatewayHealthFindings: (
    ctx: HealthCheckContext,
  ) => Promise<readonly HealthFinding[]>;
  readonly collectGatewayDaemonFindings: (
    ctx: HealthCheckContext,
  ) => Promise<readonly HealthFinding[]>;
};

async function detectUnavailableSkillsWithRuntime(
  cfg: OpenClawConfig,
): Promise<readonly SkillStatusEntry[]> {
  const runtime = await loadDoctorCoreChecksRuntimeModule();
  return runtime.detectUnavailableSkills(cfg);
}

async function collectSecurityWarningsWithRuntime(cfg: OpenClawConfig): Promise<readonly string[]> {
  const { collectSecurityWarnings } = await import("../commands/doctor-security.js");
  return collectSecurityWarnings(cfg);
}

async function collectWorkspaceSuggestionNotesWithRuntime(
  workspaceDir: string,
): Promise<readonly string[]> {
  const { collectWorkspaceBackupTip } = await import("../commands/doctor-state-integrity.js");
  const { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } = await loadDoctorWorkspaceModule();
  const notes: string[] = [];
  const backupTip = collectWorkspaceBackupTip(workspaceDir);
  if (backupTip) {
    notes.push(backupTip);
  }
  if (await shouldSuggestMemorySystem(workspaceDir)) {
    notes.push(MEMORY_SYSTEM_PROMPT);
  }
  return notes;
}

async function collectRuntimeToolSchemaFindingsWithRuntime(
  ctx: HealthCheckContext,
): Promise<readonly HealthFinding[]> {
  const runtime = await loadDoctorCoreChecksRuntimeModule();
  return runtime.collectRuntimeToolSchemaFindings(ctx.cfg);
}

async function collectProviderCatalogProjectionFindingsWithRuntime(
  ctx: HealthCheckContext,
): Promise<readonly HealthFinding[]> {
  const runtime = await loadDoctorCoreChecksRuntimeModule();
  return runtime.collectProviderCatalogProjectionFindings(ctx.cfg);
}

async function collectLocalAudioAccelerationFindingsWithRuntime(): Promise<
  readonly HealthFinding[]
> {
  const runtime = await loadDoctorCoreChecksRuntimeModule();
  return runtime.collectLocalAudioAccelerationFindings();
}

async function collectGatewayHealthFindingsWithRuntime(
  ctx: HealthCheckContext,
): Promise<readonly HealthFinding[]> {
  const runtime = await loadDoctorCoreChecksRuntimeModule();
  return runtime.collectGatewayHealthFindings(ctx);
}

async function collectGatewayDaemonFindingsWithRuntime(
  ctx: HealthCheckContext,
): Promise<readonly HealthFinding[]> {
  const runtime = await loadDoctorCoreChecksRuntimeModule();
  return runtime.collectGatewayDaemonFindings(ctx);
}

const defaultCoreHealthCheckDeps: CoreHealthCheckDeps = {
  detectUnavailableSkills: detectUnavailableSkillsWithRuntime,
  collectSecurityWarnings: collectSecurityWarningsWithRuntime,
  collectWorkspaceSuggestionNotes: collectWorkspaceSuggestionNotesWithRuntime,
  collectRuntimeToolSchemaFindings: collectRuntimeToolSchemaFindingsWithRuntime,
  collectProviderCatalogProjectionFindings: collectProviderCatalogProjectionFindingsWithRuntime,
  collectLocalAudioAccelerationFindings: collectLocalAudioAccelerationFindingsWithRuntime,
  collectGatewayHealthFindings: collectGatewayHealthFindingsWithRuntime,
  collectGatewayDaemonFindings: collectGatewayDaemonFindingsWithRuntime,
};

export function configValidationIssuesToHealthFindings(
  issues: readonly ConfigValidationIssue[],
): readonly HealthFinding[] {
  return issues.map(
    (issue): HealthFinding => ({
      checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
      severity: "error",
      message: issue.message,
      path: issue.path || "<root>",
    }),
  );
}

const gatewayConfigCheck: HealthCheck = {
  id: "core/doctor/gateway-config",
  kind: "core",
  description: "openclaw.jsonc gateway block is set and unambiguous.",
  source: "doctor",
  async detect(ctx) {
    const findings: HealthFinding[] = [];
    if (!ctx.cfg.gateway?.mode) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        severity: "warning",
        message: "gateway.mode is unset; gateway start will be blocked.",
        path: "gateway.mode",
        fixHint:
          "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.",
      });
    }
    if (ctx.cfg.gateway?.mode !== "remote" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        severity: "warning",
        message:
          "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset; auth selection is ambiguous.",
        path: "gateway.auth.mode",
        fixHint:
          "Set an explicit mode: `openclaw config set gateway.auth.mode token` or `... password`.",
      });
    }
    return findings;
  },
};

const commandOwnerCheck: HealthCheck = {
  id: "core/doctor/command-owner",
  kind: "core",
  description: "An owner account is configured for owner-only commands.",
  source: "doctor",
  async detect(ctx) {
    if (hasConfiguredCommandOwners(ctx.cfg)) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/command-owner",
        severity: "info",
        message:
          "No command owner is configured. Owner-only commands (/diagnostics, /export-trajectory, /config, exec approvals) have no allowed sender.",
        path: "commands.ownerAllowFrom",
        fixHint:
          "Set commands.ownerAllowFrom to your channel user id, e.g. `openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'`.",
      },
    ];
  },
};

const skillWorkshopToolPolicyCheck: HealthCheck = {
  id: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
  kind: "core",
  description: "Autonomous Skill Workshop capture has a callable review tool.",
  source: "doctor",
  async detect(ctx) {
    const diagnostic = detectSkillWorkshopToolPolicyDiagnostic({
      config: ctx.cfg,
      workshopEnabled: resolveSkillWorkshopConfig(ctx.cfg).autonomous.enabled,
    });
    if (!diagnostic) {
      return [];
    }
    return [
      {
        checkId: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
        severity: "warning",
        message: diagnostic.detail,
        path: diagnostic.source,
        target: diagnostic.agentId,
        requirement: "Autonomous Skill Workshop review requires the skill_workshop tool.",
        fixHint: diagnostic.fix,
      },
    ];
  },
};

function resolveDoctorMode(cfg: OpenClawConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

export function buildGatewayTokenSecretRefUnavailableMessage(params: {
  cfg: OpenClawConfig;
  ref: SecretRef;
  unresolvedRefReason?: string;
}): string {
  if (params.unresolvedRefReason) {
    return `Gateway token SecretRef could not be resolved: ${params.unresolvedRefReason}`;
  }
  if (params.ref.source === "exec") {
    const staticError = getSkippedExecRefStaticError({ ref: params.ref, config: params.cfg });
    if (staticError) {
      return `Gateway token SecretRef could not be verified: ${staticError}`;
    }
    return "Gateway token SecretRef uses an exec provider and did not resolve.";
  }
  return "Gateway token is managed via SecretRef and is currently unavailable.";
}

export function buildGatewayTokenSecretRefFixHint(ref: SecretRef): string {
  if (ref.source === "exec") {
    return "Run `openclaw doctor --allow-exec` to verify exec SecretRefs during doctor, or `openclaw secrets audit --allow-exec` to audit all exec SecretRefs.";
  }
  return "Resolve or rotate the external secret source, then rerun doctor.";
}

const gatewayAuthCheck: HealthCheck = {
  id: "core/doctor/gateway-auth",
  kind: "core",
  description: "Local Gateway auth mode has a usable token or another explicit auth mode.",
  source: "doctor",
  async detect(ctx) {
    if (resolveDoctorMode(ctx.cfg) !== "local") {
      return [];
    }
    const gatewayTokenRef = resolveSecretInputRef({
      value: ctx.cfg.gateway?.auth?.token,
      defaults: ctx.cfg.secrets?.defaults,
    }).ref;
    const auth = resolveGatewayAuth({
      authConfig: ctx.cfg.gateway?.auth,
      tailscaleMode: ctx.cfg.gateway?.tailscale?.mode ?? "off",
    });
    const hasInlineToken = typeof auth.token === "string" && auth.token.trim() !== "";
    const needsToken =
      auth.mode !== "password" &&
      auth.mode !== "none" &&
      auth.mode !== "trusted-proxy" &&
      (auth.mode !== "token" || !hasInlineToken || Boolean(gatewayTokenRef));
    if (!needsToken) {
      return [];
    }
    let unresolvedRefReason: string | undefined;
    if (gatewayTokenRef && gatewayTokenRef.source === "exec") {
      const staticError = getSkippedExecRefStaticError({ ref: gatewayTokenRef, config: ctx.cfg });
      if (staticError) {
        unresolvedRefReason = undefined;
      } else if (ctx.allowExecSecretRefs !== true) {
        return [];
      } else {
        const resolvedToken = await resolveGatewayAuthToken({
          cfg: ctx.cfg,
          env: process.env,
          unresolvedReasonStyle: "detailed",
          envFallback: "never",
        });
        if (resolvedToken.source === "secretRef") {
          return [];
        }
        unresolvedRefReason = resolvedToken.unresolvedRefReason;
      }
    } else {
      const resolvedToken = await resolveGatewayAuthToken({
        cfg: ctx.cfg,
        env: process.env,
        unresolvedReasonStyle: "detailed",
        envFallback: gatewayTokenRef ? "never" : "always",
      });
      if (gatewayTokenRef ? resolvedToken.source === "secretRef" : resolvedToken.token) {
        return [];
      }
      unresolvedRefReason = resolvedToken.unresolvedRefReason;
    }
    if (gatewayTokenRef) {
      return [
        {
          checkId: "core/doctor/gateway-auth",
          severity: "warning",
          message: buildGatewayTokenSecretRefUnavailableMessage({
            cfg: ctx.cfg,
            ref: gatewayTokenRef,
            unresolvedRefReason,
          }),
          path: "gateway.auth.token",
          fixHint: buildGatewayTokenSecretRefFixHint(gatewayTokenRef),
        },
      ];
    }
    return [
      {
        checkId: "core/doctor/gateway-auth",
        severity: "warning",
        message: "Gateway auth is off or missing a token.",
        path: "gateway.auth",
        fixHint: "Run `openclaw doctor --fix --generate-gateway-token` to generate a token.",
      },
    ];
  },
};

const hooksModelCheck: HealthCheck = {
  id: "core/doctor/hooks-model",
  kind: "core",
  description: "hooks.gmail.model resolves to an allowed catalog model.",
  source: "doctor",
  async detect(ctx) {
    if (!ctx.cfg.hooks?.gmail?.model?.trim()) {
      return [];
    }
    const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("../agents/defaults.js");
    const { loadModelCatalog } = await import("../agents/model-catalog.js");
    const { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel } =
      await import("../agents/model-selection.js");
    const hooksModelRef = resolveHooksGmailModel({
      cfg: ctx.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (!hooksModelRef) {
      return [
        {
          checkId: "core/doctor/hooks-model",
          severity: "warning",
          message: `hooks.gmail.model "${ctx.cfg.hooks.gmail.model}" could not be resolved.`,
          path: "hooks.gmail.model",
        },
      ];
    }
    const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
      cfg: ctx.cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    const catalog = await loadModelCatalog({ config: ctx.cfg, readOnly: true });
    const status = getModelRefStatus({
      cfg: ctx.cfg,
      catalog,
      ref: hooksModelRef,
      defaultProvider,
      defaultModel,
    });
    const findings: HealthFinding[] = [];
    if (!status.allowed) {
      findings.push({
        checkId: "core/doctor/hooks-model",
        severity: "warning",
        message: `hooks.gmail.model "${status.key}" is not in agents.defaults.models allowlist.`,
        path: "hooks.gmail.model",
        fixHint: "Add the model to agents.defaults.models or remove hooks.gmail.model.",
      });
    }
    if (!status.inCatalog) {
      findings.push({
        checkId: "core/doctor/hooks-model",
        severity: "warning",
        message: `hooks.gmail.model "${status.key}" is not in the model catalog.`,
        path: "hooks.gmail.model",
        fixHint: "Choose a model from the configured provider catalog.",
      });
    }
    return findings;
  },
};

const legacyStateCheck: HealthCheck & { readonly defaultEnabled: false } = {
  id: "core/doctor/legacy-state",
  kind: "core",
  description: "Legacy sessions, agent state, and channel auth paths have been migrated.",
  source: "doctor",
  defaultEnabled: false,
  async detect(ctx) {
    const { detectLegacyStateMigrations } = await import("../commands/doctor-state-migrations.js");
    const detected = await detectLegacyStateMigrations({
      cfg: ctx.cfg,
      doctorOnlyStateMigrations: true,
    });
    return [
      ...detected.preview.map(
        (line): HealthFinding => ({
          checkId: "core/doctor/legacy-state",
          severity: "warning",
          message: line.replace(/^- /, ""),
          path: detected.stateDir,
          fixHint: "Run `openclaw doctor --fix` to migrate legacy state.",
        }),
      ),
      ...detected.warnings.map(
        (warning): HealthFinding => ({
          checkId: "core/doctor/legacy-state",
          severity: "warning",
          message: warning,
          path: detected.stateDir,
          fixHint: "Resolve the warning, then rerun `openclaw doctor --fix`.",
        }),
      ),
    ];
  },
};

const bootstrapSizeCheck: HealthCheck = {
  id: "core/doctor/bootstrap-size",
  kind: "core",
  description: "Workspace bootstrap files fit within configured injection limits.",
  source: "doctor",
  async detect(ctx) {
    const { buildBootstrapInjectionStats, analyzeBootstrapBudget } =
      await import("../agents/bootstrap-budget.js");
    const { resolveBootstrapContextForRun } = await import("../agents/bootstrap-files.js");
    const { resolveBootstrapMaxChars, resolveBootstrapTotalMaxChars } =
      await import("../agents/embedded-agent-helpers.js");
    const defaultAgentId = resolveDefaultAgentId(ctx.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, defaultAgentId);
    const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      config: ctx.cfg,
      agentId: defaultAgentId,
    });
    const analysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles,
        injectedFiles: contextFiles,
      }),
      bootstrapMaxChars: resolveBootstrapMaxChars(ctx.cfg, defaultAgentId),
      bootstrapTotalMaxChars: resolveBootstrapTotalMaxChars(ctx.cfg, defaultAgentId),
    });
    const findings: HealthFinding[] = [];
    for (const file of analysis.truncatedFiles) {
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: "warning",
        message: `${file.name} exceeds bootstrap limits and will be truncated.`,
        path: file.path,
        fixHint:
          "Reduce the file size or tune `agents.list[].bootstrapMaxChars` / `bootstrapTotalMaxChars` for this agent, or the corresponding `agents.defaults.*` fallback.",
      });
    }
    for (const file of analysis.nearLimitFiles) {
      if (file.truncated) {
        continue;
      }
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: "info",
        message: `${file.name} is near the configured bootstrap file limit.`,
        path: file.path,
        fixHint:
          "Reduce the file size or tune `agents.list[].bootstrapMaxChars` for this agent, or `agents.defaults.bootstrapMaxChars` as fallback, for per-file limits.",
      });
    }
    if (analysis.totalNearLimit) {
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: analysis.hasTruncation ? "warning" : "info",
        message: "Total bootstrap context is near the configured total limit.",
        path: workspaceDir,
        fixHint:
          "Reduce bootstrap file sizes or tune `agents.list[].bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback.",
      });
    }
    return findings;
  },
};

function createRuntimeToolSchemaCheck(deps: CoreHealthCheckDeps): HealthCheck {
  return {
    id: "core/doctor/runtime-tool-schemas",
    kind: "core",
    description: "Active agent tool schemas project into model/runtime-compatible tool inputs.",
    source: "doctor",
    async detect(ctx) {
      return deps.collectRuntimeToolSchemaFindings(ctx);
    },
  };
}

function createProviderCatalogProjectionCheck(deps: CoreHealthCheckDeps): HealthCheck {
  return {
    id: "core/doctor/provider-catalog-projection",
    kind: "core",
    description: "Provider catalog hooks project into unified text model catalog rows.",
    source: "doctor",
    async detect(ctx) {
      return deps.collectProviderCatalogProjectionFindings(ctx);
    },
  };
}

function normalizeDoctorNoteLine(line: string): string {
  return line.replace(/^- /, "").trim();
}

function noteTextToFinding(params: {
  checkId: string;
  severity: HealthFinding["severity"];
  text: string;
}): HealthFinding {
  const lines = params.text.split("\n");
  const first = normalizeDoctorNoteLine(lines[0] ?? params.text);
  const rest = lines.slice(1).join("\n");
  return {
    checkId: params.checkId,
    severity: params.severity,
    message: first,
    ...(rest ? { fixHint: rest } : {}),
  };
}

function inferCapturedNoteSeverity(text: string): HealthFinding["severity"] {
  if (text.includes("CRITICAL")) {
    return "error";
  }
  if (
    text.includes("- Fix:") ||
    text.includes("unavailable") ||
    text.includes("not found") ||
    text.includes("missing") ||
    text.includes("not readable") ||
    text.includes("not writable") ||
    text.includes("readonly")
  ) {
    return "warning";
  }
  return "info";
}

function createNoteCollector(checkId: string): {
  readonly findings: readonly HealthFinding[];
  readonly noteFn: (message: unknown) => void;
} {
  const findings: HealthFinding[] = [];
  const noteFn = (message: unknown): void => {
    const text = noteMessageToText(message);
    if (!text.trim()) {
      return;
    }
    const severity = inferCapturedNoteSeverity(text);
    if (severity === "info") {
      return;
    }
    findings.push(
      noteTextToFinding({
        checkId,
        severity,
        text,
      }),
    );
  };
  return {
    findings,
    noteFn,
  };
}

function noteMessageToText(message: unknown): string {
  if (message instanceof Error) {
    return message.message;
  }
  if (message == null) {
    return "";
  }
  if (typeof message === "string") {
    return message;
  }
  if (typeof message === "number" || typeof message === "boolean" || typeof message === "bigint") {
    return String(message);
  }
  try {
    return JSON.stringify(message) ?? "";
  } catch {
    return "";
  }
}

const claudeCliCheck: HealthCheck = {
  id: "core/doctor/claude-cli",
  kind: "core",
  description: "Claude CLI readiness is captured as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { noteClaudeCliHealth } = await import("../commands/doctor-claude-cli.js");
    const collector = createNoteCollector("core/doctor/claude-cli");
    noteClaudeCliHealth(ctx.cfg, {
      noteFn: collector.noteFn,
      ...(ctx.cwd ? { workspaceDir: ctx.cwd } : {}),
    });
    return collector.findings;
  },
};

function createSecurityCheck(deps: CoreHealthCheckDeps): HealthCheck {
  return {
    id: "core/doctor/security",
    kind: "core",
    description: "Security posture checks produce structured findings.",
    source: "doctor",
    async detect(ctx) {
      const warnings = await deps.collectSecurityWarnings(ctx.cfg);
      return warnings.map((warning) =>
        noteTextToFinding({
          checkId: "core/doctor/security",
          severity: warning.includes("CRITICAL") ? "error" : "warning",
          text: warning,
        }),
      );
    },
  };
}

const openAIOAuthTlsCheck: HealthCheck = {
  id: "core/doctor/oauth-tls",
  kind: "core",
  description: "OpenAI OAuth TLS prerequisites are satisfied before browser auth.",
  source: "doctor",
  async detect(ctx) {
    const {
      formatOpenAIOAuthTlsPreflightFix,
      runOpenAIOAuthTlsPreflight,
      shouldRunOpenAIOAuthTlsPrerequisites,
    } = await import("../plugins/provider-openai-chatgpt-oauth-tls.js");
    if (!shouldRunOpenAIOAuthTlsPrerequisites({ cfg: ctx.cfg, deep: ctx.mode === "doctor" })) {
      return [];
    }
    const result = await runOpenAIOAuthTlsPreflight({ timeoutMs: 4000 });
    if (result.ok || result.kind !== "tls-cert") {
      return [];
    }
    const fix = formatOpenAIOAuthTlsPreflightFix(result);
    return [
      noteTextToFinding({
        checkId: "core/doctor/oauth-tls",
        severity: "warning",
        text: fix,
      }),
    ];
  },
};

const legacyWhatsAppCrontabCheck: HealthCheck & { readonly defaultEnabled: false } = {
  id: "core/doctor/legacy-whatsapp-crontab",
  kind: "core",
  description: "Legacy WhatsApp crontab health entries are detected as structured findings.",
  source: "doctor",
  defaultEnabled: false,
  async detect() {
    const { collectLegacyWhatsAppCrontabHealthWarning } =
      await import("../commands/doctor/cron/index.js");
    const warning = await collectLegacyWhatsAppCrontabHealthWarning();
    if (!warning) {
      return [];
    }
    return [
      noteTextToFinding({
        checkId: "core/doctor/legacy-whatsapp-crontab",
        severity: "warning",
        text: warning,
      }),
    ];
  },
};

const legacyCronStoreCheck: SplitHealthCheckInput = {
  id: "core/doctor/legacy-cron-store",
  kind: "core",
  description: "Legacy cron store, run-log, and payload state is normalized.",
  source: "doctor",
  defaultEnabled: false,
  async detect(ctx) {
    const { collectLegacyCronStoreHealthFindings } =
      await import("../commands/doctor/cron/index.js");
    return collectLegacyCronStoreHealthFindings({ cfg: ctx.cfg });
  },
};

const codexSessionRoutesCheck: HealthCheck = {
  id: CODEX_SESSION_ROUTES_CHECK_ID,
  kind: "core",
  description: "Codex runtime routes have a registered Codex plugin harness before sessions run.",
  source: "doctor",
  async detect(ctx) {
    return collectDisabledCodexPluginRouteIssues(ctx.cfg).map(
      (issue): HealthFinding => ({
        checkId: CODEX_SESSION_ROUTES_CHECK_ID,
        severity: "warning",
        message: [
          `${issue.path} routes ${issue.modelRef} to ${issue.canonicalModel}`,
          "with Codex runtime, but the Codex plugin is disabled by config.",
        ].join(" "),
        path: issue.path,
        target: issue.canonicalModel,
        requirement: "Codex plugin enabled for routes that use the Codex runtime.",
        fixHint: issue.blockedOutsideEntry
          ? [
              "Enable plugin loading and remove codex from plugins.deny,",
              "or set the affected OpenAI models to an OpenClaw runtime policy.",
            ].join(" ")
          : [
              "Run `openclaw doctor --fix`: it enables plugins.entries.codex,",
              "or set the affected OpenAI models to an OpenClaw runtime policy.",
            ].join(" "),
      }),
    );
  },
};

const gatewayServicesExtraCheck: HealthCheck = {
  id: GATEWAY_SERVICES_EXTRA_CHECK_ID,
  kind: "core",
  description: "Extra gateway-like services are represented as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const coreCtx = ctx as CoreHealthCheckContext;
    const { detectExtraGatewayServiceIssues, extraGatewayServiceToHealthFinding } =
      await import("../commands/doctor-gateway-services.js");
    return (await detectExtraGatewayServiceIssues({ deep: coreCtx.deep === true })).map(
      extraGatewayServiceToHealthFinding,
    );
  },
  async repair(ctx) {
    const coreCtx = ctx as CoreHealthRepairContext;
    const { detectExtraGatewayServiceIssues, extraGatewayServiceToRepairEffects } =
      await import("../commands/doctor-gateway-services.js");
    const effects = (
      await detectExtraGatewayServiceIssues({ deep: coreCtx.deep === true })
    ).flatMap(extraGatewayServiceToRepairEffects);
    if (ctx.dryRun === true) {
      return { status: "repaired", changes: [], effects };
    }
    return {
      status: "skipped",
      reason: "legacy doctor gateway service contribution owns cleanup",
      changes: [],
      effects,
    };
  },
};

const gatewayPlatformNotesCheck: HealthCheck = {
  id: "core/doctor/gateway-services/platform-notes",
  kind: "core",
  description: "Gateway platform notes are captured as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { collectMacGatewayPlatformWarnings } =
      await import("../commands/doctor-platform-notes.js");
    const warnings = await collectMacGatewayPlatformWarnings(ctx.cfg);
    return warnings.map((warning) =>
      noteTextToFinding({
        checkId: "core/doctor/gateway-services/platform-notes",
        severity: "warning",
        text: warning,
      }),
    );
  },
};

function createGatewayHealthCheck(deps: CoreHealthCheckDeps): SplitHealthCheckInput {
  return {
    id: GATEWAY_HEALTH_CHECK_ID,
    kind: "core",
    description: "Gateway reachability is represented as structured findings.",
    source: "doctor",
    defaultEnabled: false,
    async detect(ctx) {
      return deps.collectGatewayHealthFindings(ctx);
    },
  };
}

function createGatewayDaemonCheck(deps: CoreHealthCheckDeps): SplitHealthCheckInput {
  return {
    id: GATEWAY_DAEMON_CHECK_ID,
    kind: "core",
    description: "Local Gateway daemon service state is represented as structured findings.",
    source: "doctor",
    defaultEnabled: false,
    async detect(ctx) {
      return deps.collectGatewayDaemonFindings(ctx);
    },
  };
}

const sessionLocksCheck: SplitHealthCheckInput = {
  id: SESSION_LOCKS_CHECK_ID,
  kind: "core",
  description: "Stale session lock files are represented as structured findings.",
  source: "doctor",
  defaultEnabled: false,
  async detect(ctx) {
    return (await detectStaleSessionLocks({ config: ctx.cfg, env: process.env })).map(
      sessionLockToHealthFinding,
    );
  },
  async repair(ctx) {
    const effects = (await detectStaleSessionLocks({ config: ctx.cfg, env: process.env })).map(
      sessionLockToRepairEffect,
    );
    if (ctx.dryRun === true) {
      return { status: "repaired", changes: [], effects };
    }
    return {
      status: "skipped",
      reason: "legacy doctor session lock contribution owns cleanup",
      changes: [],
      effects,
    };
  },
};

const browserCheck: HealthCheck = {
  id: "core/doctor/browser",
  kind: "core",
  description: "Browser readiness is captured as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const collector = createNoteCollector("core/doctor/browser");
    await noteChromeMcpBrowserReadiness(ctx.cfg, { noteFn: collector.noteFn });
    return collector.findings;
  },
};

function createSkillsReadinessCheck(
  deps: CoreHealthCheckDeps,
): HealthCheck & { readonly defaultEnabled: false } {
  return {
    id: "core/doctor/skills-readiness",
    kind: "core",
    description: "Allowed skills are usable in the current runtime environment.",
    source: "doctor",
    defaultEnabled: false,
    async detect(ctx, scope) {
      const unavailable = filterUnavailableSkillsForScope(
        await deps.detectUnavailableSkills(ctx.cfg),
        scope?.paths,
      );
      return unavailable.map(unavailableSkillToFinding);
    },
    async repair(ctx, findings) {
      const unavailable = filterUnavailableSkillsForScope(
        await deps.detectUnavailableSkills(ctx.cfg),
        findings.map((finding) => finding.path),
      );
      if (unavailable.length === 0) {
        return { changes: [] };
      }
      const nextConfig = disableUnavailableSkillsInConfig(ctx.cfg, unavailable);
      return {
        config: nextConfig,
        changes: unavailable.map((skill) => `Disabled unavailable skill ${skill.name}.`),
        effects: unavailable.map((skill) => ({
          kind: "config" as const,
          action: ctx.dryRun === true ? "would-disable-skill" : "disable-skill",
          target: skillReadinessPath(skill),
          dryRunSafe: true,
        })),
      };
    },
  };
}

function unavailableSkillToFinding(skill: SkillStatusEntry): HealthFinding {
  return {
    checkId: "core/doctor/skills-readiness",
    severity: "warning",
    message: `${skill.name} is allowed but unavailable: ${formatMissingSkillSummary(skill)}.`,
    path: skillReadinessPath(skill),
    fixHint:
      "Install/configure the missing requirement, or run `openclaw doctor --fix` to disable unused unavailable skills.",
  };
}

function filterUnavailableSkillsForScope(
  unavailable: readonly SkillStatusEntry[],
  paths: readonly (string | undefined)[] | undefined,
): SkillStatusEntry[] {
  const scopedPaths = new Set(
    paths?.filter((pathLocal): pathLocal is string => pathLocal !== undefined) ?? [],
  );
  if (scopedPaths.size === 0) {
    return [...unavailable];
  }
  return unavailable.filter((skill) => scopedPaths.has(skillReadinessPath(skill)));
}

function skillReadinessPath(skill: SkillStatusEntry): string {
  return `skills.entries.${skill.skillKey}.enabled`;
}

function browserResidueDeps(ctx: { configPath?: string }) {
  return ctx.configPath ? { configDir: path.dirname(ctx.configPath) } : {};
}

function browserResidueFinding(residue: LegacyClawdBrowserProfileResidue): HealthFinding {
  return {
    checkId: BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID,
    severity: "warning",
    message: `Legacy managed browser profile residue was found at ${residue.legacyProfileDir}.`,
    path: residue.legacyProfileDir,
    ocPath: "oc://state/browser/clawd",
    fixHint:
      "Run `openclaw doctor --fix` to archive the stale clawd profile safely instead of deleting it in place.",
  };
}

function formatWouldArchiveBrowserResidue(residue: LegacyClawdBrowserProfileResidue): string {
  return [
    "Would archive legacy clawd managed browser profile residue.",
    `- legacy profile: ${residue.legacyProfileDir}`,
    `- canonical profile: ${residue.canonicalUserDataDir}`,
  ].join("\n");
}

const browserClawdProfileResidueCheck: HealthCheck = {
  id: BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID,
  kind: "core",
  description:
    "Legacy clawd managed browser profile residue has been archived after the OpenClaw rename.",
  source: "doctor",
  async detect(ctx, scope) {
    const residue = await detectLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
    if (!residue) {
      return [];
    }
    const scopedPaths = new Set(scope?.paths ?? []);
    if (scopedPaths.size > 0 && !scopedPaths.has(residue.legacyProfileDir)) {
      return [];
    }
    return [browserResidueFinding(residue)];
  },
  async repair(ctx) {
    const residue = await detectLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
    if (!residue) {
      return {
        status: "skipped",
        reason: "legacy clawd browser profile residue no longer exists",
        changes: [],
      };
    }
    const effect = {
      kind: "state" as const,
      action:
        ctx.dryRun === true
          ? "would-archive-legacy-browser-profile-residue"
          : "archive-legacy-browser-profile-residue",
      target: residue.legacyProfileDir,
      dryRunSafe: false,
    };
    if (ctx.dryRun === true) {
      return {
        changes: [formatWouldArchiveBrowserResidue(residue)],
        effects: [effect],
      };
    }
    const result = await maybeArchiveLegacyClawdBrowserProfileResidue(
      ctx.cfg,
      browserResidueDeps(ctx),
    );
    if (result.changes.length === 0 && result.warnings.length > 0) {
      return {
        status: "failed",
        reason: result.warnings.join("; "),
        changes: [],
        warnings: result.warnings,
        effects: [],
      };
    }
    return {
      changes: result.changes,
      warnings: result.warnings,
      effects: result.changes.length > 0 ? [effect] : [],
    };
  },
};

const finalConfigValidationCheck: HealthCheck = {
  id: FINAL_CONFIG_VALIDATION_CHECK_ID,
  kind: "core",
  description: "Active openclaw.jsonc parses and conforms to the config schema.",
  source: "doctor",
  async detect() {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const snap = await readConfigFileSnapshot({ observe: false });
    if (!snap.exists || snap.valid) {
      return [];
    }
    return configValidationIssuesToHealthFindings(snap.issues);
  },
};

const shellCompletionCheck: HealthCheck = {
  id: "core/doctor/shell-completion",
  kind: "core",
  description: "Shell completion uses the cached completion path when configured.",
  source: "doctor",
  async detect() {
    return shellCompletionStatusToHealthFindings(await checkShellCompletionStatus());
  },
  async repair(ctx) {
    const status = await checkShellCompletionStatus();
    const effects = shellCompletionStatusToRepairEffects(status);
    if (ctx.dryRun === true) {
      return { status: "repaired", changes: [], effects };
    }
    return {
      status: "skipped",
      reason: "legacy doctor shell-completion repair owns real mutations",
      changes: [],
      effects,
    };
  },
};

const uiProtocolFreshnessCheck: HealthCheck = {
  id: "core/doctor/ui-protocol-freshness",
  kind: "core",
  description: "Control UI assets are present and current with the Gateway protocol schema.",
  source: "doctor",
  async detect() {
    return (await detectUiProtocolFreshnessIssues()).map(uiProtocolFreshnessIssueToHealthFinding);
  },
  async repair(ctx) {
    const effects = (await detectUiProtocolFreshnessIssues()).flatMap(
      uiProtocolFreshnessIssueToRepairEffects,
    );
    if (ctx.dryRun === true) {
      return { status: "repaired", changes: [], effects };
    }
    return {
      status: "skipped",
      reason: "legacy doctor UI freshness repair owns real mutations",
      changes: [],
      effects,
    };
  },
};

function createWorkspaceSuggestionsCheck(
  deps: CoreHealthCheckDeps,
): HealthCheck & { readonly defaultEnabled: false } {
  return {
    id: "core/doctor/workspace-suggestions",
    kind: "core",
    description:
      "Workspace backup and memory-system suggestions are captured as structured findings.",
    defaultEnabled: false,
    source: "doctor",
    async detect(ctx) {
      const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
      const notes = await deps.collectWorkspaceSuggestionNotes(workspaceDir);
      return notes.map((text) =>
        noteTextToFinding({
          checkId: "core/doctor/workspace-suggestions",
          severity: "info",
          text,
        }),
      );
    },
  };
}

function createConvertedWorkflowChecks(
  deps: CoreHealthCheckDeps,
): readonly SplitHealthCheckInput[] {
  return [
    claudeCliCheck,
    gatewayAuthCheck,
    legacyStateCheck,
    legacyWhatsAppCrontabCheck,
    legacyCronStoreCheck,
    codexSessionRoutesCheck,
    sessionLocksCheck,
    shellCompletionCheck,
    uiProtocolFreshnessCheck,
    gatewayServicesExtraCheck,
    gatewayPlatformNotesCheck,
    createGatewayHealthCheck(deps),
    createGatewayDaemonCheck(deps),
    createSecurityCheck(deps),
    browserCheck,
    openAIOAuthTlsCheck,
    hooksModelCheck,
    bootstrapSizeCheck,
    createProviderCatalogProjectionCheck(deps),
    {
      id: "core/doctor/local-audio-acceleration",
      kind: "core",
      description: "Local STT auto-selection and acceleration evidence are visible.",
      source: "doctor",
      async detect() {
        return await deps.collectLocalAudioAccelerationFindings();
      },
    },
    createRuntimeToolSchemaCheck(deps),
    createWorkspaceSuggestionsCheck(deps),
    skillWorkshopToolPolicyCheck,
  ];
}

let registered = false;

/** @deprecated Core doctor flows use ordered doctor contributions; keep this only for SDK compatibility. */
export function registerCoreHealthChecks(): void {
  if (registered) {
    return;
  }
  for (const check of CORE_HEALTH_CHECKS) {
    registerHealthCheck(check);
  }
  registered = true;
}

export function resetCoreHealthChecksForTest(): void {
  registered = false;
}

export function createCoreHealthChecks(
  deps: CoreHealthCheckDeps = defaultCoreHealthCheckDeps,
): readonly SplitHealthCheckInput[] {
  return [
    gatewayConfigCheck,
    ...createConvertedWorkflowChecks(deps),
    commandOwnerCheck,
    createSkillsReadinessCheck(deps),
    browserClawdProfileResidueCheck,
    finalConfigValidationCheck,
  ];
}

export const CORE_HEALTH_CHECKS: readonly SplitHealthCheckInput[] = createCoreHealthChecks();
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
