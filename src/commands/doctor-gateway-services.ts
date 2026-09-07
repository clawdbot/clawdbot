/** Doctor repairs for installed gateway service config and duplicate legacy services. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { SUPPORTED_NODE_VERSIONS } from "../../node-version.mjs";
import { note } from "../../packages/terminal-core/src/note.js";
import { replaceConfigFile, type OpenClawConfig } from "../config/config.js";
import { isDefaultInstallIdentity, resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { formatGatewayHeapLimitReport, inspectGatewayHeapLimit } from "../daemon/gateway-heap.js";
import {
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
  type ExtraGatewayService,
} from "../daemon/inspect.js";
import { execLaunchctl, isLaunchctlNotLoaded } from "../daemon/launchd-exec.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
import { renderSystemNodeWarning, resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import { readWindowsStartupFallbackRuntimeForUpdate } from "../daemon/schtasks.js";
import {
  auditGatewayServiceConfig,
  needsNodeRuntimeMigration,
  readEmbeddedGatewayToken,
  SERVICE_AUDIT_CODES,
} from "../daemon/service-audit.js";
import { mergeGatewayServiceEnv } from "../daemon/service-env-merge.js";
import { SERVICE_PROXY_ENV_KEYS } from "../daemon/service-env.js";
import { summarizeGatewayServiceLayout } from "../daemon/service-layout.js";
import {
  normalizeServiceEnvKey,
  readManagedServiceEnvKeysFromEnvironment,
} from "../daemon/service-managed-env.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import {
  assertServiceDefinitionWritable,
  hasGatewayServiceEnvironmentOverride,
  hasGatewayServiceLauncherOverride,
  resolveManagedGatewayServiceCommand,
  type GatewayServiceInstallArgs,
} from "../daemon/service-types.js";
import { resolveGatewayService, type GatewayServiceCommandConfig } from "../daemon/service.js";
import {
  findSystemdGatewayInstallation,
  isSystemUnitActiveAndEnabled,
  isSystemdUnitActive,
  uninstallLegacySystemdUnits,
  uninstallUserSystemdGatewayUnit,
  type SystemdUnitScope,
} from "../daemon/systemd.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON } from "../infra/gateway-supervision.js";
import { readWindowsProcessArgsSync } from "../infra/windows-port-pids.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { resolveGatewayDaemonRuntime, type GatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveGatewayAuthTokenForService } from "./doctor-gateway-auth-token.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode } from "./doctor-repair-mode.js";
import {
  confirmDoctorServiceRepair,
  EXTERNAL_SERVICE_REPAIR_NOTE,
  isServiceRepairExternallyManaged,
  resolveServiceRepairPolicy,
  resolveUpdateParentGatewayActivation,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";
import {
  UPDATE_IN_PROGRESS_ENV,
  UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV,
} from "./doctor/shared/update-phase.js";

type GatewayServiceConfigRepairOptions = {
  allowConfigSizeDrop?: boolean;
  allowExecSecretRefs?: boolean;
  lastTouchedVersionOverride?: string;
  preservedLegacyRootKeys?: readonly string[];
  skipPluginValidation?: boolean;
};

function shouldSkipLegacyUpdateRepairConfigWrite(env: NodeJS.ProcessEnv): boolean {
  return (
    isTruthyEnvValue(env[UPDATE_IN_PROGRESS_ENV]) &&
    !isTruthyEnvValue(env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV])
  );
}

function updateParentAllowsGatewayActivation(env: NodeJS.ProcessEnv): boolean {
  const activationPolicy = resolveUpdateParentGatewayActivation(env);
  if (activationPolicy !== undefined) {
    return activationPolicy;
  }
  // Shipped parents predate the marker. Recover their explicit CLI policy from
  // the direct parent; unreadable ancestry stays staged rather than disrupting it.
  const parentArgs = readWindowsProcessArgsSync(process.ppid, 1_500);
  if (parentArgs === null) {
    return false;
  }
  const normalizedParentArgs = parentArgs.map(normalizeLowercaseStringOrEmpty);
  const updateIndex = Math.max(
    normalizedParentArgs.lastIndexOf("update"),
    normalizedParentArgs.lastIndexOf("--update"),
  );
  const legacyDoctorUpdateParent = normalizedParentArgs.lastIndexOf("doctor") >= 0;
  const legacyWizardParent = updateIndex >= 0 && normalizedParentArgs[updateIndex + 1] === "wizard";
  return (
    (updateIndex >= 0 || legacyDoctorUpdateParent) &&
    !legacyWizardParent &&
    !normalizedParentArgs.includes("--no-restart")
  );
}

function updateParentAllowsGatewayServiceRepair(env: NodeJS.ProcessEnv): boolean {
  const repairPolicy = env[UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV];
  // A legacy parent cannot prove which checkout owns the service. First upgrade fails closed.
  return repairPolicy !== undefined && isTruthyEnvValue(repairPolicy);
}

const EXECSTART_REPAIR_CODES = new Set<string>([
  SERVICE_AUDIT_CODES.gatewayCommandMissing,
  SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
]);
const DOCTOR_LAUNCHCTL_TIMEOUT_MS = 5_000;
const DOCTOR_LAUNCHCTL_CONFIRM_POLL_MS = 100;
async function confirmLegacyLaunchdServiceUnloaded(serviceTarget: string): Promise<boolean> {
  const deadline = Date.now() + DOCTOR_LAUNCHCTL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const probe = await execLaunchctl(
      ["print", serviceTarget],
      Math.min(DOCTOR_LAUNCHCTL_TIMEOUT_MS, remainingMs),
    );
    if (probe.code !== 0) {
      // A successful print (including a stopped job) means launchd still owns
      // the label. Unknown errors and probe timeouts stay fail-closed.
      return isLaunchctlNotLoaded(probe);
    }
    const delayMs = Math.min(DOCTOR_LAUNCHCTL_CONFIRM_POLL_MS, deadline - Date.now());
    if (delayMs <= 0) {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  return false;
}
const GATEWAY_SERVICES_EXTRA_CHECK_ID = "core/doctor/gateway-services/extra";

function findGatewayEntrypoint(programArguments?: string[]): string | null {
  if (!programArguments || programArguments.length === 0) {
    return null;
  }
  const gatewayIndex = programArguments.indexOf("gateway");
  if (gatewayIndex <= 0) {
    return null;
  }
  return programArguments[gatewayIndex - 1] ?? null;
}

async function buildExpectedGatewayServicePlan(params: {
  cfg: OpenClawConfig;
  command: GatewayServiceCommandConfig;
  serviceInstallEnv: NodeJS.ProcessEnv;
  port: number;
  runtime: GatewayDaemonRuntime;
  runtimePath?: string;
}) {
  const managed = resolveManagedGatewayServiceCommand(params.command);
  return buildGatewayInstallPlan({
    env: params.serviceInstallEnv,
    port: params.port,
    runtime: params.runtime,
    runtimePath: params.runtimePath,
    existingCommand: params.command,
    existingEnvironment: managed?.environment,
    existingEnvironmentValueSources: managed?.environmentValueSources,
    warn: (message, title) => note(message, title),
    config: params.cfg,
  });
}

async function normalizeExecutablePath(value: string): Promise<string> {
  const resolvedPath = path.resolve(value);
  try {
    return await fs.realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function extractDetailPath(detail: string, prefix: string): string | null {
  if (!detail.startsWith(prefix)) {
    return null;
  }
  const value = detail.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function isExecStartRepairIssue(issue: { code: string }): boolean {
  return EXECSTART_REPAIR_CODES.has(issue.code);
}

function isOperatorOwnedEnvironmentIssue(
  issue: { code: string; environmentKeys?: readonly string[] },
  command: GatewayServiceCommandConfig,
  environmentValueSources: GatewayServiceInstallArgs["environmentValueSources"],
): boolean {
  switch (issue.code) {
    case SERVICE_AUDIT_CODES.gatewayPathMissing:
    case SERVICE_AUDIT_CODES.gatewayPathMissingDirs:
    case SERVICE_AUDIT_CODES.gatewayPathNonMinimal:
      return hasGatewayServiceEnvironmentOverride(command, ["PATH"], { environmentValueSources });
    case SERVICE_AUDIT_CODES.gatewayTokenEmbedded:
    case SERVICE_AUDIT_CODES.gatewayTokenMismatch:
    case SERVICE_AUDIT_CODES.gatewayTokenDrift:
      return hasGatewayServiceEnvironmentOverride(command, ["OPENCLAW_GATEWAY_TOKEN"], {
        environmentValueSources,
      });
    case SERVICE_AUDIT_CODES.gatewayPasswordEmbedded:
      return hasGatewayServiceEnvironmentOverride(command, ["OPENCLAW_GATEWAY_PASSWORD"], {
        environmentValueSources,
      });
    case SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded:
      return hasGatewayServiceEnvironmentOverride(command, issue.environmentKeys ?? [], {
        environmentValueSources,
        normalizeKey: normalizeServiceEnvKey,
      });
    case SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded:
      return hasGatewayServiceEnvironmentOverride(
        command,
        (issue.environmentKeys ?? []).filter((key) =>
          SERVICE_PROXY_ENV_KEYS.some((proxyKey) => proxyKey === key),
        ),
        { ignoreResets: true },
      );
    default:
      return false;
  }
}

function resolveSystemdScopeFromServicePath(sourcePath: string | undefined): SystemdUnitScope {
  const normalized = sourcePath?.replaceAll("\\", "/") ?? "";
  return normalized.startsWith("/etc/systemd/") ||
    normalized.startsWith("/usr/lib/systemd/") ||
    normalized.startsWith("/lib/systemd/")
    ? "system"
    : "user";
}

function resolveSystemdUnitNameFromServicePath(sourcePath: string | undefined): string {
  const base = sourcePath ? path.posix.basename(sourcePath.replaceAll("\\", "/")) : "";
  return base.endsWith(".service") ? base : "openclaw-gateway.service";
}

function shouldDeferUpdateModeSystemdServiceRepair(params: {
  repairMode: DoctorPrompter["repairMode"];
  shouldForce: boolean;
}): boolean {
  return (
    process.platform === "linux" &&
    isDoctorUpdateRepairMode(params.repairMode) &&
    !params.shouldForce
  );
}

async function readWindowsGatewayRuntimeForUpdateRepair(params: {
  service: ReturnType<typeof resolveGatewayService>;
  env: NodeJS.ProcessEnv;
}): Promise<GatewayServiceRuntime | null> {
  if (process.platform !== "win32") {
    return null;
  }
  return await params.service.readRuntime(params.env).catch(() => null);
}

async function resolveSystemdServiceRewriteBlock(
  command: GatewayServiceCommandConfig,
  issues: { code: string }[],
): Promise<string | undefined> {
  if (process.platform !== "linux" || !issues.some(isExecStartRepairIssue)) {
    return undefined;
  }
  const unitName = resolveSystemdUnitNameFromServicePath(command.sourcePath);
  const scope = resolveSystemdScopeFromServicePath(command.sourcePath);
  const active = await isSystemdUnitActive(process.env, unitName, scope);
  if (!active.ok) {
    return `Could not determine whether gateway service ${unitName} is active: ${active.error}. Leaving supervisor metadata unchanged. Check \`systemctl${scope === "user" ? " --user" : ""} status ${unitName}\` and rerun doctor.`;
  }
  if (!active.value) {
    return undefined;
  }
  issues.splice(0, issues.length, ...issues.filter((issue) => !isExecStartRepairIssue(issue)));
  return `Gateway service ${unitName} is running; skipped command/entrypoint rewrites and leaving supervisor metadata unchanged. Stop the service first or use \`openclaw gateway install --force\` when you want to replace the active launcher.`;
}

async function filterInactiveExtraGatewayServices(
  services: ExtraGatewayService[],
): Promise<ExtraGatewayService[]> {
  if (process.platform !== "linux") {
    return services;
  }
  const activeOrLegacy: ExtraGatewayService[] = [];
  for (const svc of services) {
    if (svc.platform !== "linux" || svc.legacy === true) {
      activeOrLegacy.push(svc);
      continue;
    }
    const active = await isSystemdUnitActive(process.env, svc.label, svc.scope);
    if (!active.ok || active.value) {
      activeOrLegacy.push(svc);
    }
  }
  return activeOrLegacy;
}

export async function detectExtraGatewayServiceIssues(
  options: Pick<DoctorOptions, "deep"> = {},
): Promise<readonly ExtraGatewayService[]> {
  if (!isDefaultInstallIdentity(process.env) || !(await shouldManageGatewayService())) {
    return [];
  }
  const detectedExtraServices = await findExtraGatewayServices(process.env, {
    deep: options.deep,
  });
  return await filterInactiveExtraGatewayServices(detectedExtraServices);
}

export function extraGatewayServiceToHealthFinding(service: ExtraGatewayService): HealthFinding {
  return {
    checkId: GATEWAY_SERVICES_EXTRA_CHECK_ID,
    severity: service.legacy === true ? "warning" : "info",
    message: `Other gateway-like service detected: ${service.label} (${service.scope}, ${service.detail})`,
    source: service.platform,
    target: service.label,
    fixHint:
      service.legacy === true
        ? "Run `openclaw doctor` interactively to review legacy gateway services and confirm supported cleanup."
        : "Run a single gateway per machine unless this extra gateway is intentional.",
  };
}

export function extraGatewayServiceToRepairEffects(
  service: ExtraGatewayService,
): readonly HealthRepairEffect[] {
  if (service.legacy !== true) {
    return [];
  }
  return [
    {
      kind: "service",
      action: "would-remove-legacy-gateway-service",
      target: service.label,
      dryRunSafe: false,
    },
  ];
}

async function cleanupLegacyLaunchdService(params: {
  label: string;
  plistPath: string;
}): Promise<{ status: "removed"; destination?: string } | { status: "failed"; reason: string }> {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  await execLaunchctl(["bootout", domain, params.plistPath], DOCTOR_LAUNCHCTL_TIMEOUT_MS);
  await execLaunchctl(["unload", params.plistPath], DOCTOR_LAUNCHCTL_TIMEOUT_MS);

  // bootout/unload can return before launchd finishes stopping the job. A plist
  // must stay in place unless a bounded print probe observes the label gone.
  if (!(await confirmLegacyLaunchdServiceUnloaded(`${domain}/${params.label}`))) {
    return { status: "failed", reason: "launchctl could not confirm unload" };
  }

  const trashDir = path.join(os.homedir(), ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    await fs.access(params.plistPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "removed" };
    }
    return { status: "failed", reason: "could not inspect plist" };
  }

  const dest = path.join(trashDir, `${params.label}-${Date.now()}.plist`);
  try {
    await fs.rename(params.plistPath, dest);
    return { status: "removed", destination: dest };
  } catch {
    return { status: "failed", reason: "could not move plist" };
  }
}

function classifyLegacyServices(legacyServices: ExtraGatewayService[]): {
  darwinUserServices: ExtraGatewayService[];
  linuxUserServices: ExtraGatewayService[];
  failed: string[];
} {
  const darwinUserServices: ExtraGatewayService[] = [];
  const linuxUserServices: ExtraGatewayService[] = [];
  const failed: string[] = [];

  for (const svc of legacyServices) {
    if (svc.platform === "darwin") {
      if (svc.scope === "user") {
        darwinUserServices.push(svc);
      } else {
        failed.push(`${svc.label} (${svc.scope})`);
      }
      continue;
    }

    if (svc.platform === "linux") {
      if (svc.scope === "user") {
        linuxUserServices.push(svc);
      } else {
        failed.push(`${svc.label} (${svc.scope})`);
      }
      continue;
    }

    failed.push(`${svc.label} (${svc.platform})`);
  }

  return { darwinUserServices, linuxUserServices, failed };
}

async function cleanupLegacyDarwinServices(
  services: ExtraGatewayService[],
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];

  for (const svc of services) {
    const plistPath = extractDetailPath(svc.detail, "plist:");
    if (!plistPath) {
      failed.push(`${svc.label} (missing plist path)`);
      continue;
    }
    const result = await cleanupLegacyLaunchdService({
      label: svc.label,
      plistPath,
    });
    if (result.status === "removed") {
      removed.push(result.destination ? `${svc.label} -> ${result.destination}` : svc.label);
    } else {
      failed.push(`${svc.label} (${result.reason})`);
    }
  }

  return { removed, failed };
}

async function cleanupLegacyLinuxUserServices(
  services: ExtraGatewayService[],
  runtime: RuntimeEnv,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];

  try {
    const removedUnits = await uninstallLegacySystemdUnits({
      env: process.env,
      stdout: process.stdout,
    });
    const removedByLabel: Map<string, (typeof removedUnits)[number]> = new Map(
      removedUnits.map((unit) => [`${unit.name}.service`, unit] as const),
    );
    for (const svc of services) {
      const removedUnit = removedByLabel.get(svc.label);
      if (!removedUnit) {
        failed.push(`${svc.label} (legacy unit name not recognized)`);
        continue;
      }
      removed.push(`${svc.label} -> ${removedUnit.unitPath}`);
    }
  } catch (err) {
    runtime.error(`Legacy Linux gateway cleanup failed: ${String(err)}`);
    for (const svc of services) {
      failed.push(`${svc.label} (linux cleanup failed)`);
    }
  }

  return { removed, failed };
}

/**
 * Audits and optionally rewrites the installed local gateway service configuration.
 *
 * The repair preserves managed env sources and avoids Nix/remote installs. Update-mode repairs
 * stay staged except for running Windows services, which must be activated to replace a fallback.
 */
export async function maybeRepairGatewayServiceConfig(
  cfg: OpenClawConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  options: GatewayServiceConfigRepairOptions = {},
): Promise<OpenClawConfig> {
  if (!isDefaultInstallIdentity(process.env)) {
    note(NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON, "Gateway");
    return cfg;
  }
  if (resolveIsNixMode(process.env)) {
    note("Nix mode detected; skip service updates.", "Gateway");
    return cfg;
  }

  if (mode === "remote") {
    note("Gateway mode is remote; skipped local service audit.", "Gateway");
    return cfg;
  }

  const service = resolveGatewayService();
  let command: Awaited<ReturnType<typeof service.readCommand>> | null;
  try {
    command = await service.readCommand(process.env);
  } catch {
    command = null;
  }
  if (!command) {
    const audit = await auditGatewayServiceConfig({
      env: process.env,
      command: null,
      platform: process.platform,
    });
    if (audit.issues.length > 0) {
      note(
        audit.issues
          .map((issue) =>
            issue.detail ? `- ${issue.message} (${issue.detail})` : `- ${issue.message}`,
          )
          .join("\n"),
        "Gateway service config",
      );
    }
    return cfg;
  }
  const managedDefinition = resolveManagedGatewayServiceCommand(command) ?? command;
  note(
    formatGatewayHeapLimitReport(
      inspectGatewayHeapLimit(command.environment?.NODE_OPTIONS, {}, command.programArguments),
    ),
    "Gateway heap",
  );
  const managedWrapperPath = managedDefinition.environment?.[OPENCLAW_WRAPPER_ENV_KEY]?.trim();
  const serviceInstallEnv =
    managedWrapperPath && !Object.hasOwn(process.env, OPENCLAW_WRAPPER_ENV_KEY)
      ? { ...process.env, [OPENCLAW_WRAPPER_ENV_KEY]: managedWrapperPath }
      : process.env;
  const serviceWrapperPath = normalizeOptionalString(
    command.environment?.[OPENCLAW_WRAPPER_ENV_KEY],
  );
  if (serviceWrapperPath) {
    note(`Gateway service invokes ${OPENCLAW_WRAPPER_ENV_KEY}: ${serviceWrapperPath}`, "Gateway");
  }
  const serviceLayout = await summarizeGatewayServiceLayout(command);
  const sourceCheckoutWarning = serviceLayout?.entrypointSourceCheckout
    ? [
        `Gateway service entrypoint resolves to a source checkout: ${serviceLayout.packageRootReal ?? serviceLayout.packageRoot ?? serviceLayout.entrypointReal ?? serviceLayout.entrypoint}.`,
        "Run `openclaw gateway install --force` from the intended package install to replace the gateway service definition.",
      ].join("\n")
    : null;

  const tokenRefConfigured = Boolean(
    resolveSecretInputRef({
      value: cfg.gateway?.auth?.token,
      defaults: cfg.secrets?.defaults,
    }).ref,
  );
  const gatewayTokenResolution = await resolveGatewayAuthTokenForService(cfg, process.env, {
    allowExecSecretRefs: options.allowExecSecretRefs === true,
  });
  if (gatewayTokenResolution.unavailableReason) {
    note(
      `Unable to verify gateway service token drift: ${gatewayTokenResolution.unavailableReason}`,
      "Gateway service config",
    );
  }
  const expectedGatewayToken = tokenRefConfigured ? undefined : gatewayTokenResolution.token;
  const port = resolveGatewayPort(cfg, process.env);
  const runtimeChoice = resolveGatewayDaemonRuntime(managedDefinition.programArguments);
  const installedRuntimePath =
    runtimeChoice === "bun" ? managedDefinition.programArguments[0] : undefined;
  const expectedPlan = await buildExpectedGatewayServicePlan({
    cfg,
    command,
    serviceInstallEnv,
    port,
    runtime: runtimeChoice,
    runtimePath: installedRuntimePath,
  });
  const expectedManagedServiceEnvKeys = readManagedServiceEnvKeysFromEnvironment(
    expectedPlan.environment,
  );
  const audit = await auditGatewayServiceConfig({
    env: process.env,
    command,
    expectedGatewayToken,
    expectedManagedServiceEnvKeys,
    expectedServicePath: expectedPlan.environment.PATH,
    expectedPort: port,
  });
  const serviceToken = readEmbeddedGatewayToken(command);
  if (tokenRefConfigured && serviceToken) {
    audit.issues.push({
      code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
      message:
        "Gateway service OPENCLAW_GATEWAY_TOKEN should be unset when gateway.auth.token is SecretRef-managed",
      detail: "service token is stale",
      level: "recommended",
    });
  }
  const needsNodeRuntime = needsNodeRuntimeMigration(audit.issues);
  // Unsupported Bun and version-managed Node services migrate through a concrete system Node.
  const systemNodeInfo = needsNodeRuntime
    ? await resolveSystemNodeInfo({ env: process.env })
    : null;
  const systemNodePath = systemNodeInfo?.status === "supported" ? systemNodeInfo.path : null;
  if (needsNodeRuntime && !systemNodePath && runtimeChoice !== "node") {
    const warning = renderSystemNodeWarning(systemNodeInfo);
    if (warning) {
      note(warning, "Gateway runtime");
    } else {
      note(
        `System Node ${SUPPORTED_NODE_VERSIONS} not found. Install via Homebrew/apt/choco and rerun doctor to migrate off Bun/version managers.`,
        "Gateway runtime",
      );
    }
  }

  const expectedRuntimePlan =
    needsNodeRuntime && systemNodePath
      ? await buildExpectedGatewayServicePlan({
          cfg,
          command,
          serviceInstallEnv,
          port,
          runtime: "node",
          runtimePath: systemNodePath,
        })
      : expectedPlan;
  const { programArguments } = expectedRuntimePlan;
  const expectedEntrypoint = findGatewayEntrypoint(programArguments);
  const currentEntrypoint = findGatewayEntrypoint(command.programArguments);
  const normalizedExpectedEntrypoint = expectedEntrypoint
    ? await normalizeExecutablePath(expectedEntrypoint)
    : null;
  const normalizedCurrentEntrypoint = serviceLayout?.entrypoint
    ? await normalizeExecutablePath(serviceLayout.entrypoint)
    : null;
  if (
    normalizedExpectedEntrypoint &&
    normalizedCurrentEntrypoint &&
    normalizedExpectedEntrypoint !== normalizedCurrentEntrypoint
  ) {
    audit.issues.push({
      code: SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
      message: "Gateway service entrypoint does not match the current install.",
      detail: `${currentEntrypoint} -> ${expectedEntrypoint}`,
      level: "recommended",
    });
  }

  const serviceRewriteBlock = await resolveSystemdServiceRewriteBlock(command, audit.issues);
  if (serviceRewriteBlock) {
    note(serviceRewriteBlock, "Gateway service config");
  }

  const hasEntrypointMismatch = audit.issues.some(
    (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
  );
  const showSourceCheckoutWarning = sourceCheckoutWarning !== null && !hasEntrypointMismatch;

  if (audit.issues.length === 0) {
    if (sourceCheckoutWarning !== null && !hasEntrypointMismatch) {
      note(sourceCheckoutWarning, "Gateway service config");
    }
    return cfg;
  }

  const serviceRepairPolicy = resolveServiceRepairPolicy();
  const serviceRepairExternal = isServiceRepairExternallyManaged(serviceRepairPolicy);

  const consolidatedLines: string[] = [];
  let emittedSourceCheckoutWarning = false;
  if (sourceCheckoutWarning !== null && showSourceCheckoutWarning) {
    consolidatedLines.push(sourceCheckoutWarning);
    consolidatedLines.push("");
    emittedSourceCheckoutWarning = true;
  }
  consolidatedLines.push(
    ...audit.issues.map((issue) =>
      issue.detail ? `- ${issue.message} (${issue.detail})` : `- ${issue.message}`,
    ),
  );
  note(consolidatedLines.join("\n"), "Gateway service config");
  if (audit.issues.every((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeProbeFailed)) {
    return cfg;
  }

  const aggressiveIssues = audit.issues.filter((issue) => issue.level === "aggressive");
  const needsAggressive = aggressiveIssues.length > 0;

  if (needsAggressive && !prompter.shouldForce) {
    note(
      "Custom or unexpected service edits detected. Rerun with --force to overwrite.",
      "Gateway service config",
    );
  }

  if (serviceRepairExternal) {
    note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway service config");
    return cfg;
  }

  if (serviceRewriteBlock) {
    return cfg;
  }

  if (
    process.platform === "linux" &&
    audit.issues.some(
      (issue) =>
        (isExecStartRepairIssue(issue) && hasGatewayServiceLauncherOverride(command)) ||
        (issue.code === SERVICE_AUDIT_CODES.gatewayPortMismatch &&
          hasGatewayServiceLauncherOverride(command, { includeWorkingDirectory: false })) ||
        isOperatorOwnedEnvironmentIssue(issue, command, expectedPlan.environmentValueSources),
    )
  ) {
    const unitName = resolveSystemdUnitNameFromServicePath(command.sourcePath);
    const scope = resolveSystemdScopeFromServicePath(command.sourcePath);
    const inspectCommand = `systemctl${scope === "user" ? " --user" : ""} cat ${unitName}`;
    note(
      `Gateway service command, working directory, or environment comes from an operator-owned systemd drop-in; rewriting the managed unit cannot repair it. Inspect with \`${inspectCommand}\`, then update or remove the drop-in and rerun doctor.`,
      "Gateway service config",
    );
    return cfg;
  }

  const updateRepairMode = isDoctorUpdateRepairMode(prompter.repairMode);
  if (updateRepairMode && !updateParentAllowsGatewayServiceRepair(process.env)) {
    note(
      "Update parent did not authorize changes to this gateway service definition; leaving it unchanged.",
      "Gateway service config",
    );
    return cfg;
  }
  if (
    shouldDeferUpdateModeSystemdServiceRepair({
      repairMode: prompter.repairMode,
      shouldForce: prompter.shouldForce,
    })
  ) {
    note(
      "Update-mode doctor detected gateway service drift but left the live systemd unit unchanged. Review the service file and run `openclaw gateway install --force` when you want OpenClaw to rewrite its managed unit; operator-owned drop-ins remain unchanged.",
      "Gateway service config",
    );
    return cfg;
  }

  const repairMessage = needsAggressive
    ? "Overwrite gateway service config with current defaults now?"
    : "Update gateway service config to the recommended defaults now?";
  const repair = updateRepairMode
    ? needsAggressive
      ? await prompter.confirmAggressiveAutoFix({
          message: repairMessage,
          initialValue: prompter.shouldForce,
        })
      : await prompter.confirmAutoFix({
          message: repairMessage,
          initialValue: true,
        })
    : await prompter.confirmRuntimeRepair({
        message: repairMessage,
        initialValue: needsAggressive ? prompter.shouldForce : true,
        requiresInteractiveConfirmation: true,
      });
  if (!repair) {
    if (!emittedSourceCheckoutWarning) {
      note(
        "Run `openclaw gateway install --force` when you want to replace the gateway service definition.",
        "Gateway service config",
      );
    }
    return cfg;
  }
  try {
    // Installed and planned environments can select different state files. Check
    // both before token persistence; native publication still revalidates under locks.
    for (const environment of [
      mergeGatewayServiceEnv(serviceInstallEnv, command),
      expectedRuntimePlan.environment,
    ]) {
      const capability = await service
        .readDefinitionMutationCapability?.({ env: serviceInstallEnv, environment })
        .catch(() => ({ kind: "unknown", reason: "inspection-failed" }) as const);
      if (capability) {
        assertServiceDefinitionWritable(capability);
      }
    }
  } catch (err) {
    runtime.error(`Gateway service repair blocked: ${String(err)}`);
    return cfg;
  }
  const serviceEmbeddedToken = readEmbeddedGatewayToken(managedDefinition);
  const gatewayTokenForRepair = expectedGatewayToken ?? serviceEmbeddedToken;
  const configuredGatewayToken =
    typeof cfg.gateway?.auth?.token === "string"
      ? normalizeOptionalString(cfg.gateway.auth.token)
      : undefined;
  let cfgForServiceInstall = cfg;
  // Windows update repairs rewrite the Scheduled Task immediately, so migrate an
  // embedded legacy token first; otherwise the restarted gateway loses auth.
  const updateRepairWillRewriteWindowsTask = updateRepairMode && process.platform === "win32";
  const serviceRuntimeEnv = {
    ...serviceInstallEnv,
    ...managedDefinition.environment,
  };
  const installedWindowsTaskName =
    managedDefinition.environment?.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  const serviceRepairEnv =
    updateRepairWillRewriteWindowsTask && installedWindowsTaskName
      ? {
          ...serviceInstallEnv,
          OPENCLAW_WINDOWS_TASK_NAME: installedWindowsTaskName,
        }
      : serviceInstallEnv;
  const updateRepairCanActivateGateway =
    updateRepairWillRewriteWindowsTask && updateParentAllowsGatewayActivation(process.env);
  // Config writes can make the live gateway reload between audit and repair.
  // Preserve its initial state so a transient reload does not strand a fallback.
  const updateRepairRuntime = updateRepairCanActivateGateway
    ? await readWindowsGatewayRuntimeForUpdateRepair({
        service,
        env: serviceRuntimeEnv,
      })
    : null;
  const updateRepairShouldInstall = updateRepairRuntime?.status === "running";
  let startupFallbackTakeoverRuntime: GatewayServiceRuntime | undefined;
  if (updateRepairShouldInstall) {
    try {
      const fallbackRuntime = await readWindowsStartupFallbackRuntimeForUpdate(serviceRuntimeEnv);
      if (fallbackRuntime && (fallbackRuntime.status !== "running" || !fallbackRuntime.pid)) {
        note(
          "Could not verify the running Windows login item before service repair; leaving it unchanged.",
          "Gateway",
        );
        return cfg;
      }
      startupFallbackTakeoverRuntime = fallbackRuntime ?? undefined;
    } catch (err) {
      runtime.error(
        `Could not inspect the Windows login item before service repair: ${String(err)}`,
      );
      return cfg;
    }
  }
  if (
    (!updateRepairMode || updateRepairWillRewriteWindowsTask) &&
    !tokenRefConfigured &&
    !configuredGatewayToken &&
    gatewayTokenForRepair
  ) {
    if (
      updateRepairWillRewriteWindowsTask &&
      shouldSkipLegacyUpdateRepairConfigWrite(process.env)
    ) {
      note(
        "Legacy update parent cannot persist gateway.auth.token before service repair; leaving the existing gateway service unchanged.",
        "Gateway",
      );
      return cfg;
    }
    const nextCfg: OpenClawConfig = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        auth: {
          ...cfg.gateway?.auth,
          mode: cfg.gateway?.auth?.mode ?? "token",
          token: gatewayTokenForRepair,
        },
      },
    };
    try {
      await replaceConfigFile({
        nextConfig: nextCfg,
        afterWrite: { mode: "auto" },
        writeOptions: {
          auditOrigin: "doctor",
          allowConfigSizeDrop: options.allowConfigSizeDrop === true || updateRepairMode,
          skipPluginValidation: options.skipPluginValidation === true || updateRepairMode,
          preservedLegacyRootKeys: options.preservedLegacyRootKeys,
          ...(options.lastTouchedVersionOverride
            ? { lastTouchedVersionOverride: options.lastTouchedVersionOverride }
            : {}),
        },
      });
      cfgForServiceInstall = nextCfg;
      note(
        expectedGatewayToken
          ? "Persisted gateway.auth.token from environment before reinstalling service."
          : "Persisted gateway.auth.token from existing service definition before reinstalling service.",
        "Gateway",
      );
    } catch (err) {
      runtime.error(`Failed to persist gateway.auth.token before service repair: ${String(err)}`);
      return cfg;
    }
  }

  const updatedPort = resolveGatewayPort(cfgForServiceInstall, process.env);
  const updatedPlan = await buildExpectedGatewayServicePlan({
    cfg: cfgForServiceInstall,
    command,
    serviceInstallEnv,
    port: updatedPort,
    runtime: needsNodeRuntime && systemNodePath ? "node" : runtimeChoice,
    runtimePath: needsNodeRuntime && systemNodePath ? systemNodePath : installedRuntimePath,
  });
  // Windows `install` activates the task/login item. Require both a running
  // gateway and parent authorization so `update --no-restart` stays non-disruptive.
  const repairService =
    updateRepairMode && !updateRepairShouldInstall ? service.stage : service.install;
  try {
    await repairService({
      env: serviceRepairEnv,
      stdout: process.stdout,
      warn: (message) => note(message, "Gateway"),
      programArguments: updatedPlan.programArguments,
      workingDirectory: updatedPlan.workingDirectory,
      environment: updatedPlan.environment,
      environmentValueSources: updatedPlan.environmentValueSources,
      startupFallbackTakeoverRuntime,
    });
    if (
      updateRepairShouldInstall &&
      !isTruthyEnvValue(process.env[UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV])
    ) {
      const restartEnv = {
        ...serviceRepairEnv,
        ...updatedPlan.environment,
      };
      if (installedWindowsTaskName) {
        // Scheduled Task identity is caller-owned; a canonical rebuilt plan must
        // not redirect restart/cleanup to the default task after profile repair.
        restartEnv.OPENCLAW_WINDOWS_TASK_NAME = installedWindowsTaskName;
      }
      await service.restart({
        env: restartEnv,
        stdout: process.stdout,
      });
      note("Restarted the repaired gateway for a legacy update parent.", "Gateway");
    }
  } catch (err) {
    runtime.error(`Gateway service update failed: ${String(err)}`);
  }
  return cfgForServiceInstall;
}

/**
 * Reports duplicate gateway-like services and removes legacy user services after confirmation.
 */
export async function maybeScanExtraGatewayServices(
  options: DoctorOptions,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  if (!isDefaultInstallIdentity(process.env)) {
    note(NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON, "Gateway");
    return;
  }
  const extraServices = await detectExtraGatewayServiceIssues(options);
  if (extraServices.length === 0) {
    return;
  }

  note(
    extraServices.map((svc) => `- ${svc.label} (${svc.scope}, ${svc.detail})`).join("\n"),
    "Other gateway-like services detected",
  );

  const legacyServices = extraServices.filter((svc) => svc.legacy === true);
  if (legacyServices.length > 0) {
    const serviceRepairPolicy = resolveServiceRepairPolicy();
    const serviceRepairExternal = isServiceRepairExternallyManaged(serviceRepairPolicy);
    if (serviceRepairExternal) {
      note(EXTERNAL_SERVICE_REPAIR_NOTE, "Legacy gateway cleanup skipped");
    }
    const shouldRemove = serviceRepairExternal
      ? false
      : await confirmDoctorServiceRepair(
          prompter,
          {
            message: "Remove legacy gateway services now?",
            initialValue: true,
          },
          serviceRepairPolicy,
        );
    if (shouldRemove) {
      const removed: string[] = [];
      const { darwinUserServices, linuxUserServices, failed } =
        classifyLegacyServices(legacyServices);

      if (darwinUserServices.length > 0) {
        const result = await cleanupLegacyDarwinServices(darwinUserServices);
        removed.push(...result.removed);
        failed.push(...result.failed);
      }

      if (linuxUserServices.length > 0) {
        const result = await cleanupLegacyLinuxUserServices(linuxUserServices, runtime);
        removed.push(...result.removed);
        failed.push(...result.failed);
      }

      if (removed.length > 0) {
        note(removed.map((line) => `- ${line}`).join("\n"), "Legacy gateway removed");
      }
      if (failed.length > 0) {
        note(failed.map((line) => `- ${line}`).join("\n"), "Legacy gateway cleanup skipped");
      }
    }
  }

  // Legacy jobs have their own confirmed cleanup flow; generic hints must
  // only name detected extra services, never the active managed gateway.
  const cleanupHints = renderGatewayServiceCleanupHints(
    extraServices.filter((service) => service.legacy !== true),
  );
  if (cleanupHints.length > 0) {
    note(cleanupHints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
  }

  note(
    [
      "Recommendation: run a single gateway per machine for most setups.",
      "One gateway supports multiple agents.",
      "If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
    ].join("\n"),
    "Gateway recommendation",
  );
}

/**
 * Resolves a `dueling` systemd install (both a user-scope and a system-scope
 * gateway unit present) by removing the redundant user-scope unit after
 * confirmation, keeping the root-installed system-scope unit as authoritative.
 *
 * This is the fix for issue #79375: on Linux the two units bind the same port
 * and SIGTERM each other in an endless restart loop. The canonical units are
 * deliberately excluded from `findExtraGatewayServices`, so this detects the
 * condition directly via `findSystemdGatewayInstallation`. Removing a unit
 * under `$HOME` needs no root; the system-scope unit is never auto-removed
 * (only a `sudo`-flavored hint is offered for that direction).
 */
export async function maybeResolveDuelingSystemdGatewayScopes(
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  if (process.platform !== "linux") {
    return;
  }
  const installation = await findSystemdGatewayInstallation(process.env).catch(() => null);
  if (installation?.kind !== "dueling") {
    return;
  }
  const { user, system } = installation;
  note(
    [
      "Both a user-scope and a system-scope OpenClaw gateway unit are installed:",
      `- user:   ${user.unitPath}`,
      `- system: ${system.unitPath}`,
      "They bind the same port and will SIGTERM each other in a restart loop.",
    ].join("\n"),
    "Dueling gateway services detected",
  );

  // Ownership guard: delete the user unit only when the system unit is the
  // live or boot-configured supervisor. A staged/disabled/failed/uncheckable
  // system unit file with a working user gateway must fail closed to hints,
  // or doctor would take down the operator's only running gateway.
  const systemOwnsGateway = await isSystemUnitActiveAndEnabled(process.env, system.unitName).catch(
    () => false,
  );
  if (!systemOwnsGateway) {
    note(
      [
        "Could not verify the system-scope unit is both running and enabled at boot, so the",
        "user-scope unit may be your working gateway. Not removing anything",
        "automatically.",
        "If the system-scope unit is the one you want, activate it and re-run doctor:",
        `- sudo systemctl enable --now ${system.unitName}`,
        "If the user-scope unit is the one you want, remove the system unit:",
        `- sudo systemctl disable --now ${system.unitName} && sudo rm ${system.unitPath}`,
      ].join("\n"),
      "Gateway cleanup needs an owner decision",
    );
    return;
  }
  note(
    [
      "The system-scope unit is the active and boot-enabled supervisor and is",
      "treated as authoritative; the user-scope unit is the redundant leftover.",
    ].join("\n"),
    "System-scope unit owns the gateway",
  );

  const policy = resolveServiceRepairPolicy();
  if (isServiceRepairExternallyManaged(policy)) {
    note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway cleanup skipped");
    return;
  }

  const shouldRemove = await confirmDoctorServiceRepair(
    prompter,
    {
      message: "Remove the redundant user-scope gateway unit and keep the system-scope unit?",
      initialValue: true,
    },
    policy,
  );
  if (!shouldRemove) {
    const hints = renderGatewayServiceCleanupHints();
    if (hints.length > 0) {
      note(hints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
    }
    return;
  }

  try {
    const result = await uninstallUserSystemdGatewayUnit({
      env: process.env,
      stdout: process.stdout,
    });
    note(
      result.removed
        ? `Removed user-scope unit ${result.unitPath}.`
        : `User-scope unit already absent at ${result.unitPath}.`,
      "Redundant user gateway removed",
    );
    // Only claim the conflict is resolved when systemd actually released the
    // unit; a file-only removal can leave the loaded unit running.
    runtime.log(
      result.disabled
        ? "Removed the redundant user-scope gateway unit. The system-scope unit is now the sole gateway manager."
        : `Removed the user-scope unit file, but systemctl was unavailable to stop it. Run: systemctl --user disable --now ${result.unitName} && systemctl --user daemon-reload`,
    );
  } catch (err) {
    runtime.error(`Failed to remove redundant user-scope gateway unit: ${String(err)}`);
    const hints = renderGatewayServiceCleanupHints();
    if (hints.length > 0) {
      note(hints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
