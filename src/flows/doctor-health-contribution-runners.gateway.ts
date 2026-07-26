import fs from "node:fs";
import { hasActiveGatewayExecCredential } from "./doctor-gateway-exec-credential.js";
import { runCoreContributionHealth } from "./doctor-health-contribution-core.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  isUpdateDoctorRun,
  resolveDoctorMode,
  resolveLegacyParentVersionOverride,
} from "./doctor-health-contribution-utils.js";

export async function runGatewayConfigHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { formatCliCommand } = await import("../cli/command-format.js");
  const { hasAmbiguousGatewayAuthModeConfig } = await import("../gateway/auth-mode-policy.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
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

export async function runAuthProfileHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyFlatAuthProfileStores, maybeRepairCanonicalApiKeyFieldAlias } =
    await import("../commands/doctor-auth-flat-profiles.js");
  const { maybeRepairLegacyOAuthProfileIds } =
    await import("../commands/doctor-auth-legacy-oauth.js");
  const { maybeRepairLegacyOAuthSidecarProfiles } =
    await import("../commands/doctor-auth-oauth-sidecar.js");
  const { noteAuthProfileHealth, noteLegacyCodexProviderOverride } =
    await import("../commands/doctor-auth.js");
  const { buildGatewayConnectionDetails } = await import("../gateway/call.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  await maybeRepairLegacyFlatAuthProfileStores({ cfg: ctx.cfg, prompter: ctx.prompter });
  await maybeRepairCanonicalApiKeyFieldAlias({ cfg: ctx.cfg, prompter: ctx.prompter });
  await maybeRepairLegacyOAuthSidecarProfiles({ cfg: ctx.cfg, prompter: ctx.prompter });
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

export async function runGatewayAuthHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { resolveSecretInputRef } = await import("../config/types.secrets.js");
  const { buildGatewayTokenSecretRefFixHint, buildGatewayTokenSecretRefUnavailableMessage } =
    await import("./doctor-core-checks.js");
  const { resolveGatewayAuth } = await import("../gateway/auth.js");
  const { resolveGatewayAuthToken } = await import("../gateway/auth-token-resolution.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  const { randomToken } = await import("../commands/onboard-helpers.js");
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
  if (gatewayTokenRef?.source === "exec") {
    const { getSkippedExecRefStaticError } = await import("../secrets/exec-resolution-policy.js");
    const staticError = getSkippedExecRefStaticError({ ref: gatewayTokenRef, config: ctx.cfg });
    if (!staticError) {
      if (ctx.options.allowExec !== true) {
        return;
      }
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
    note(
      [
        buildGatewayTokenSecretRefUnavailableMessage({
          cfg: ctx.cfg,
          ref: gatewayTokenRef,
          unresolvedRefReason,
        }),
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
  ctx.cfg = {
    ...ctx.cfg,
    gateway: {
      ...ctx.cfg.gateway,
      auth: { ...ctx.cfg.gateway?.auth, mode: "token", token: randomToken() },
    },
  };
  note("Gateway token configured.", "Gateway auth");
}

export async function runCommandOwnerHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteCommandOwnerHealth } = await import("../commands/doctor-command-owner.js");
  noteCommandOwnerHealth(ctx.cfg);
}

export async function runClaudeCliHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteClaudeCliHealth } = await import("../commands/doctor-claude-cli.js");
  noteClaudeCliHealth(ctx.cfg);
}

export async function runGatewayServicesHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairGatewayServiceConfig, maybeScanExtraGatewayServices } =
    await import("../commands/doctor-gateway-services.js");
  const {
    noteMacLaunchAgentOverrides,
    noteMacLaunchctlGatewayEnvOverrides,
    noteMacStaleOpenClawUpdateLaunchdJobs,
  } = await import("../commands/doctor-platform-notes.js");
  await maybeScanExtraGatewayServices(ctx.options, ctx.runtime, ctx.prompter);
  const updateDoctorRun = isUpdateDoctorRun(ctx.env ?? process.env);
  ctx.cfg = await maybeRepairGatewayServiceConfig(
    ctx.cfg,
    resolveDoctorMode(ctx.cfg),
    ctx.runtime,
    ctx.prompter,
    {
      allowExecSecretRefs: ctx.options.allowExec === true,
      allowConfigSizeDrop: ctx.configResult.shouldWriteConfig === true || updateDoctorRun,
      skipPluginValidation:
        ctx.configResult.skipPluginValidationOnWrite === true || updateDoctorRun,
      preservedLegacyRootKeys: ctx.configResult.preservedLegacyRootKeys,
      ...resolveLegacyParentVersionOverride(ctx),
    },
  );
  await noteMacLaunchAgentOverrides();
  await noteMacStaleOpenClawUpdateLaunchdJobs();
  await noteMacLaunchctlGatewayEnvOverrides(ctx.cfg);
}

export async function runStartupChannelMaintenanceHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { maybeRunDoctorStartupChannelMaintenance } =
    await import("./doctor-startup-channel-maintenance.js");
  await maybeRunDoctorStartupChannelMaintenance({
    cfg: ctx.cfg,
    env: process.env,
    runtime: ctx.runtime,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

export async function runSecurityHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteInstallPolicyHealth } = await import("../commands/doctor-install-policy.js");
  const { noteSecurityWarnings } = await import("../commands/doctor-security.js");
  await noteSecurityWarnings(ctx.cfg);
  await noteInstallPolicyHealth(ctx.cfg, { deep: ctx.options.deep === true, env: ctx.env });
}

export async function runWebFetchProxyHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteWebFetchProxyDiagnostic } = await import("../commands/doctor-web-fetch-proxy.js");
  await noteWebFetchProxyDiagnostic({ cfg: ctx.cfg, env: ctx.env ?? process.env });
}

export async function runBrowserHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteChromeMcpBrowserReadiness } = await import("../commands/doctor-browser.js");
  await runCoreContributionHealth(ctx, ["core/doctor/browser-clawd-profile-residue"]);
  await noteChromeMcpBrowserReadiness(ctx.cfg);
}

export async function runOpenAIOAuthTlsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteOpenAIOAuthTlsPrerequisites } =
    await import("../plugins/provider-openai-chatgpt-oauth-tls.js");
  await noteOpenAIOAuthTlsPrerequisites({ cfg: ctx.cfg, deep: ctx.options.deep === true });
}

export async function runGatewayHealthChecks(ctx: DoctorHealthFlowContext): Promise<void> {
  const { note } = await import("../../packages/terminal-core/src/note.js");
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
  const timeoutMs = ctx.options.nonInteractive === true ? 3000 : 10_000;
  const { healthOk, authenticated, status } = await checkGatewayHealth({
    runtime: ctx.runtime,
    cfg: ctx.cfg,
    timeoutMs,
  });
  ctx.gatewayHealthSkipped = false;
  ctx.healthOk = healthOk;
  ctx.gatewayHealthAuthenticated = authenticated;
  ctx.gatewayStatus = status;
  ctx.gatewayMemoryProbe = authenticated
    ? await probeGatewayMemoryStatus({ cfg: ctx.cfg, timeoutMs })
    : { checked: false, ready: false, skipped: healthOk };
}

export async function runWhatsappResponsivenessHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteWhatsappResponsivenessHealth } =
    await import("../commands/doctor-whatsapp-responsiveness.js");
  await noteWhatsappResponsivenessHealth({
    cfg: ctx.cfg,
    status: ctx.gatewayStatus,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

export async function runDevicePairingHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteDevicePairingHealth } = await import("../commands/doctor-device-pairing.js");
  await noteDevicePairingHealth({ cfg: ctx.cfg, healthOk: ctx.healthOk ?? false });
}

export async function runGatewayDaemonHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairGatewayDaemon } = await import("../commands/doctor-gateway-daemon-flow.js");
  await maybeRepairGatewayDaemon({
    cfg: ctx.cfg,
    runtime: ctx.runtime,
    prompter: ctx.prompter,
    options: ctx.options,
    gatewayDetailsMessage: ctx.gatewayDetails?.message ?? "",
    // A skipped exec-backed token probe is unknown, not unhealthy. Do not let
    // doctor --fix restart services only because probing would require exec.
    healthOk: ctx.healthOk ?? false,
    healthSkipped: ctx.gatewayHealthSkipped === true,
  });
}
