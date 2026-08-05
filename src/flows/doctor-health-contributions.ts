// Doctor health contributions preserve the ordered interactive doctor flow while
// exposing the same checks to structured lint and repair commands.
import fs from "node:fs";
import { hasActiveGatewayExecCredential } from "./doctor-gateway-exec-credential.js";
import {
  runCoreContributionHealth,
  runStructuredHealthRepairs,
} from "./doctor-health-contribution-core.js";
import type {
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { resolveDoctorMode } from "./doctor-health-contribution-utils.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import { resolveFinalDoctorHealthContributions } from "./doctor-health-contributions-final.js";
import { resolveInitialDoctorHealthContributions } from "./doctor-health-contributions-initial.js";
import { normalizeHealthCheck } from "./health-check-adapter.js";
import type { HealthCheck, HealthCheckContext, HealthFinding } from "./health-checks.js";

export type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const loadCommandFormatModule = async () => await import("../cli/command-format.js");
const loadDoctorCoreChecksModule = async () => await import("./doctor-core-checks.js");
const loadNoteModule = async () => await import("../../packages/terminal-core/src/note.js");
const loadOnboardHelpersModule = async () => await import("../commands/onboard-helpers.js");
const loadSecretTypesModule = async () => await import("../config/types.secrets.js");

async function runGatewayConfigHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { formatCliCommand } = await loadCommandFormatModule();
  const { hasAmbiguousGatewayAuthModeConfig } = await import("../gateway/auth-mode-policy.js");
  const { note } = await loadNoteModule();
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
  const { maybeMigrateAuthProfileJsonStoresToSqlite } =
    await import("../commands/doctor-auth-flat-profiles.js");
  const { maybeRepairLegacyOAuthProfileIds } =
    await import("../commands/doctor-auth-legacy-oauth.js");
  const { maybeRepairLegacyOAuthSidecarProfiles } =
    await import("../commands/doctor-auth-oauth-sidecar.js");
  const { maybeMigrateLegacyPluginModelCatalogs } =
    await import("../commands/doctor-plugin-model-catalog.js");
  const { noteAuthProfileHealth, noteLegacyCodexProviderOverride } =
    await import("../commands/doctor-auth.js");
  const { buildGatewayConnectionDetails } = await import("../gateway/call.js");
  const { note } = await loadNoteModule();
  await maybeRepairLegacyOAuthSidecarProfiles({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
  });
  await maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
    ...(ctx.env ? { env: ctx.env } : {}),
  });
  await maybeMigrateLegacyPluginModelCatalogs({
    cfg: ctx.cfg,
    ...(ctx.env ? { env: ctx.env } : {}),
    prompter: ctx.prompter,
    runtime: ctx.runtime,
  });
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
  const { resolveSecretInputRef } = await loadSecretTypesModule();
  const { buildGatewayTokenSecretRefFixHint, buildGatewayTokenSecretRefUnavailableMessage } =
    await loadDoctorCoreChecksModule();
  const { resolveGatewayAuth } = await import("../gateway/auth.js");
  const { resolveGatewayAuthToken } = await import("../gateway/auth-token-resolution.js");
  const { note } = await loadNoteModule();
  const { randomToken } = await loadOnboardHelpersModule();
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
  // Modes that don't need a token: password, none, trusted-proxy.
  // This aligns with hasExplicitGatewayInstallAuthMode() in auth-install-policy.ts.
  // Previously, only "password" and "token" (with a token present) were excluded,
  // causing doctor --fix to overwrite trusted-proxy/none configs with token mode.
  const hasInlineToken = typeof auth.token === "string" && auth.token.trim() !== "";
  const needsToken =
    auth.mode !== "password" &&
    auth.mode !== "none" &&
    auth.mode !== "trusted-proxy" &&
    (auth.mode !== "token" || !hasInlineToken || Boolean(gatewayTokenRef));
  if (!needsToken) {
    return;
  }
  let unresolvedRefReason: string | undefined;
  if (gatewayTokenRef && gatewayTokenRef.source === "exec") {
    const { getSkippedExecRefStaticError } = await import("../secrets/exec-resolution-policy.js");
    const staticError = getSkippedExecRefStaticError({ ref: gatewayTokenRef, config: ctx.cfg });
    if (staticError) {
      unresolvedRefReason = undefined;
    } else if (ctx.options.allowExec !== true) {
      return;
    } else {
      const resolvedToken = await resolveGatewayAuthToken({
        cfg: ctx.cfg,
        env: ctx.env ?? process.env,
        unresolvedReasonStyle: "detailed",
        envFallback: "never",
      });
      if (resolvedToken.source === "secretRef") {
        return;
      }
      unresolvedRefReason = resolvedToken.unresolvedRefReason;
    }
  } else {
    const resolvedToken = await resolveGatewayAuthToken({
      cfg: ctx.cfg,
      env: ctx.env ?? process.env,
      unresolvedReasonStyle: "detailed",
      envFallback: gatewayTokenRef ? "never" : "always",
    });
    if (gatewayTokenRef ? resolvedToken.source === "secretRef" : resolvedToken.token) {
      return;
    }
    unresolvedRefReason = resolvedToken.unresolvedRefReason;
  }
  if (gatewayTokenRef) {
    const reason = buildGatewayTokenSecretRefUnavailableMessage({
      cfg: ctx.cfg,
      ref: gatewayTokenRef,
      unresolvedRefReason,
    });
    note(
      [
        reason,
        "Doctor will not overwrite gateway.auth.token with a plaintext value.",
        buildGatewayTokenSecretRefFixHint(gatewayTokenRef),
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

async function runLegacyStateHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { detectLegacyStateMigrations, runLegacyStateMigrations } =
    await import("../commands/doctor-state-migrations.js");
  const { note } = await loadNoteModule();
  // Settle retired-plugin state cleanup (may replace ctx.cfg) before the
  // legacy-state detect/migrate pair reads the config.
  await runCoreContributionHealth(ctx, ["core/doctor/removed-workspaces-state"]);
  const doctorOnlyStateMigrations = ctx.options.repair === true || ctx.options.yes === true;
  const legacyState = await detectLegacyStateMigrations({
    cfg: ctx.cfg,
    ...(doctorOnlyStateMigrations ? { doctorOnlyStateMigrations: true } : {}),
  });
  if (legacyState.warnings.length > 0) {
    note(legacyState.warnings.join("\n"), "Doctor warnings");
  }
  if (legacyState.notices.length > 0) {
    note(legacyState.notices.join("\n"), "Doctor notices");
  }
  if (legacyState.preview.length === 0) {
    return;
  }
  note(legacyState.preview.join("\n"), "Legacy state detected");
  const migrate =
    ctx.options.nonInteractive === true
      ? true
      : await ctx.prompter.confirm({
          message: "Migrate detected legacy state now?",
          initialValue: true,
        });
  if (!migrate) {
    return;
  }
  const migrated = await runLegacyStateMigrations({
    detected: legacyState,
    config: ctx.cfg,
    ...(doctorOnlyStateMigrations ? { doctorOnlyStateMigrations: true } : {}),
    recoverCorruptTargetStore: ctx.options.repair === true || ctx.options.yes === true,
  });
  if (migrated.changes.length > 0) {
    note(migrated.changes.join("\n"), "Doctor changes");
  }
  const notices = migrated.notices ?? [];
  if (notices.length > 0) {
    note(notices.join("\n"), "Doctor notices");
  }
  if (migrated.warnings.length > 0) {
    note(migrated.warnings.join("\n"), "Doctor warnings");
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
  const { resolveGatewayService } = await import("../daemon/service.js");
  const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
  const { note } = await loadNoteModule();
  const service = resolveGatewayService();
  let loaded;
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

async function detectSystemdLingerFindings(
  ctx: HealthCheckContext,
): Promise<readonly HealthFinding[]> {
  if (process.platform !== "linux" || resolveDoctorMode(ctx.cfg) !== "local") {
    return [];
  }
  const { resolveGatewayService } = await import("../daemon/service.js");
  const service = resolveGatewayService();
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (!loaded) {
    return [];
  }
  const { isSystemdUserServiceAvailable, readSystemdUserLingerStatus } =
    await import("../daemon/systemd.js");
  if (!(await isSystemdUserServiceAvailable(process.env))) {
    return [];
  }
  const status = await readSystemdUserLingerStatus(process.env);
  if (!status || status.linger === "yes") {
    return [];
  }
  return [
    {
      checkId: "core/doctor/systemd-linger",
      severity: "warning",
      source: "doctor",
      message: `Systemd lingering is disabled for ${status.user}.`,
      target: `systemd.user.${status.user}`,
      requirement: "systemd user lingering enabled",
      fixHint: `Run: sudo loginctl enable-linger ${status.user}`,
    },
  ];
}

async function runShellCompletionHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { doctorShellCompletion } = await import("../commands/doctor-completion.js");
  await doctorShellCompletion(ctx.runtime, ctx.prompter, {
    nonInteractive: ctx.options.nonInteractive,
  });
}

async function runGatewayHealthChecks(ctx: DoctorHealthFlowContext): Promise<void> {
  const { note } = await loadNoteModule();
  if ((await hasActiveGatewayExecCredential(ctx)) && ctx.options.allowExec !== true) {
    note(
      "Gateway health probes skipped because gateway credentials use an exec SecretRef. Run `openclaw doctor --allow-exec` to verify Gateway health with exec SecretRefs.",
      "Gateway",
    );
    ctx.gatewayHealthSkipped = true;
    ctx.gatewayMemoryProbe = { checked: false, ready: false, skipped: true };
    return;
  }
  const { checkGatewayHealth, probeGatewayMemoryStatus } =
    await import("../commands/doctor-gateway-health.js");
  const { healthOk, authenticated, status } = await checkGatewayHealth({
    runtime: ctx.runtime,
    cfg: ctx.cfg,
    timeoutMs: ctx.options.nonInteractive === true ? 3000 : 10_000,
  });
  ctx.gatewayHealthSkipped = false;
  ctx.healthOk = healthOk;
  ctx.gatewayHealthAuthenticated = authenticated;
  ctx.gatewayStatus = status;
  ctx.gatewayMemoryProbe = authenticated
    ? await probeGatewayMemoryStatus({
        cfg: ctx.cfg,
        timeoutMs: ctx.options.nonInteractive === true ? 3000 : 10_000,
      })
    : { checked: false, ready: false, skipped: healthOk };
}

function resolveDoctorHealthContributions(): DoctorHealthContribution[] {
  return [
    ...resolveInitialDoctorHealthContributions({
      runStructuredHealthRepairs: (ctx) =>
        runStructuredHealthRepairs(ctx, resolveDoctorContributionHealthChecks),
      runGatewayConfigHealth,
      runAuthProfileHealth,
      runGatewayAuthHealth,
      runLegacyStateHealth,
    }),
    ...resolveFinalDoctorHealthContributions({
      runSystemdLingerHealth,
      detectSystemdLingerFindings,
      runShellCompletionHealth,
      runGatewayHealthChecks,
    }),
  ];
}

export async function resolveDoctorContributionHealthChecks(): Promise<readonly HealthCheck[]> {
  const { createCoreHealthChecks } = await import("./doctor-core-checks.js");
  const checksById = new Map(createCoreHealthChecks().map((check) => [check.id, check]));
  const checks: HealthCheck[] = [];
  for (const contribution of resolveDoctorHealthContributions()) {
    if (contribution.healthChecks.length > 0) {
      checks.push(...contribution.healthChecks.map(normalizeHealthCheck));
      continue;
    }
    for (const id of contribution.healthCheckIds) {
      const check = checksById.get(id);
      if (check === undefined) {
        throw new Error(
          `doctor contribution ${contribution.id} references unknown core health check ${id}`,
        );
      }
      checks.push(check);
    }
  }
  return checks;
}

export async function runDoctorHealthContributions(ctx: DoctorHealthFlowContext): Promise<void> {
  for (const contribution of resolveDoctorHealthContributions()) {
    await contribution.run(ctx);
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHealthContributionsTestApi")
  ] = { createDoctorHealthContribution, resolveDoctorHealthContributions };
}
