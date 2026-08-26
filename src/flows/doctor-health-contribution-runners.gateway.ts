import { note } from "../../packages/terminal-core/src/note.js";
import { shouldManageGatewayService } from "../commands/doctor-service-repair-policy.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON } from "../infra/gateway-supervision.js";
import { runCoreContributionHealth } from "./doctor-health-contribution-core.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  isUpdateDoctorRun,
  resolveDoctorMode,
  resolveLegacyParentVersionOverride,
} from "./doctor-health-contribution-utils.js";

export async function runCommandOwnerHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteCommandOwnerHealth } = await import("../commands/doctor-command-owner.js");
  noteCommandOwnerHealth(ctx.cfg);
}

export async function runClaudeCliHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteClaudeCliHealth } = await import("../commands/doctor-claude-cli.js");
  noteClaudeCliHealth(ctx.cfg);
}

export async function runGatewayServicesHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (!isDefaultInstallIdentity(ctx.env ?? process.env)) {
    note(NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON, "Gateway");
    return;
  }
  if (!(await shouldManageGatewayService(ctx.env ?? process.env))) {
    return;
  }
  const {
    maybeRepairGatewayServiceConfig,
    maybeResolveDuelingSystemdGatewayScopes,
    maybeScanExtraGatewayServices,
  } = await import("../commands/doctor-gateway-services.js");
  const {
    noteMacLaunchAgentOverrides,
    noteMacLaunchctlGatewayEnvOverrides,
    noteMacStaleOpenClawUpdateLaunchdJobs,
  } = await import("../commands/doctor-platform-notes.js");
  await maybeScanExtraGatewayServices(ctx.options, ctx.runtime, ctx.prompter);
  await maybeResolveDuelingSystemdGatewayScopes(ctx.runtime, ctx.prompter);
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

export async function runHostDesktopHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteHostDesktopHealth } = await import("../commands/doctor-host-desktop.js");
  await noteHostDesktopHealth(ctx.cfg, { prompter: ctx.prompter });
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
  if (!isDefaultInstallIdentity(ctx.env ?? process.env)) {
    return;
  }
  const { noteWebFetchProxyDiagnostic } = await import("../commands/doctor-web-fetch-proxy.js");
  await noteWebFetchProxyDiagnostic({ cfg: ctx.cfg, env: ctx.env ?? process.env });
}

export async function runGitHubProjectHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { hasConfiguredGitHubApiCredential } = await import("../gateway/control-ui-github-api.js");
  if (!hasConfiguredGitHubApiCredential(ctx.env ?? process.env, ctx.cfg)) {
    note(
      "Prefer gateway.controlUi.github.token for Gateway-owned GitHub project access, or set GH_TOKEN/GITHUB_TOKEN in the shared Gateway process environment. Without either, search is public-only.",
      "GitHub projects",
    );
  }
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
  if (!isDefaultInstallIdentity(ctx.env ?? process.env)) {
    return;
  }
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
