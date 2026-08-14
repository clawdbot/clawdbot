import { resolveGatewayShellEnvFallbackPlan } from "../cli/gateway-cli/shell-env-fallback-plan.js";
import { getGatewayStartGuardErrors } from "../cli/gateway-cli/start-guard.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { ensureControlUiAllowedOriginsForNonLoopbackBind } from "../config/gateway-control-ui-origins.js";
import { CONFIG_AUDIT_STORE_LABEL } from "../config/io.audit.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { defaultGatewayBindMode } from "../gateway/net.js";
import {
  inspectGatewayStartupRuntimePolicy,
  type GatewayStartupRuntimePolicyInspection,
} from "../gateway/server-runtime-config.js";
import {
  inspectStartupSessionMigrationPrerequisites,
  type SessionStartupPreflightResult,
} from "../gateway/server-startup-session-migration.js";
import {
  inspectGatewayStartupBindAuth,
  inspectGatewayStartupAuth,
  resolveGatewayStartupAuthShellEnvMissingKeys,
  type GatewayStartupBindAuthInspection,
  type GatewayStartupAuthInspection,
} from "../gateway/startup-auth.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withReadOnlyPathCaseProbe } from "../infra/path-case.js";
import {
  resolveSqliteReadOnlyInspectionLocation,
  withSqliteReadOnlyInspectionSnapshots,
} from "../infra/sqlite-readonly-inspection.js";
import {
  collectGatewayStartupPreflight,
  type GatewayStartupPreflightBlocker,
  type GatewayStartupPreflightError,
} from "../infra/startup-preflight.js";
import {
  type OutputRuntimeEnv,
  type RuntimeEnv,
  defaultRuntime,
  writeRuntimeJson,
} from "../runtime.js";
import { withOpenClawStateDatabaseInspectionSnapshots } from "../state/openclaw-state-db-readonly.js";

const GATEWAY_STARTUP_PREFLIGHT_PROTOCOL = "openclaw.gateway.startup-preflight";
const GATEWAY_STARTUP_PREFLIGHT_PROTOCOL_VERSION = 1;

type GatewayStartupPreflightResult = {
  protocol: typeof GATEWAY_STARTUP_PREFLIGHT_PROTOCOL;
  protocolVersion: typeof GATEWAY_STARTUP_PREFLIGHT_PROTOCOL_VERSION;
  ok: boolean;
  status: "ready" | "blocked" | "indeterminate";
  checksRun: number;
  blockers: GatewayStartupPreflightBlocker[];
  errors: GatewayStartupPreflightError[];
};

const CORE_PREFLIGHT_PLUGIN_ID = "core";
const CORE_SESSION_PREFLIGHT_MIGRATION_ID = "session-sqlite";
const CORE_AUTH_PREFLIGHT_MIGRATION_ID = "gateway-auth";
const CORE_RUNTIME_PREFLIGHT_MIGRATION_ID = "gateway-runtime";
const CORE_CONFIG_PREFLIGHT_MIGRATION_ID = "gateway-config";
const CORE_ENVIRONMENT_PREFLIGHT_MIGRATION_ID = "gateway-environment";

function createResult(params: {
  checksRun?: number;
  blockers?: GatewayStartupPreflightBlocker[];
  errors?: GatewayStartupPreflightError[];
}): GatewayStartupPreflightResult {
  const blockers = params.blockers ?? [];
  const errors = params.errors ?? [];
  const status = errors.length > 0 ? "indeterminate" : blockers.length > 0 ? "blocked" : "ready";
  return {
    protocol: GATEWAY_STARTUP_PREFLIGHT_PROTOCOL,
    protocolVersion: GATEWAY_STARTUP_PREFLIGHT_PROTOCOL_VERSION,
    ok: status === "ready",
    status,
    checksRun: params.checksRun ?? 0,
    blockers,
    errors,
  };
}

function combineCoreStartupPreflight(
  pluginResult: {
    checksRun: number;
    blockers: GatewayStartupPreflightBlocker[];
    errors: GatewayStartupPreflightError[];
  },
  authResult: GatewayStartupAuthInspection,
  bindResult: GatewayStartupBindAuthInspection,
  runtimePolicyResult: GatewayStartupRuntimePolicyInspection,
  sessionResult?: SessionStartupPreflightResult,
): {
  checksRun: number;
  blockers: GatewayStartupPreflightBlocker[];
  errors: GatewayStartupPreflightError[];
} {
  const inspectionId = `${CORE_PREFLIGHT_PLUGIN_ID}/${CORE_SESSION_PREFLIGHT_MIGRATION_ID}`;
  const blockers = [...pluginResult.blockers];
  const errors = [...pluginResult.errors];
  const authInspectionId = `${CORE_PREFLIGHT_PLUGIN_ID}/${CORE_AUTH_PREFLIGHT_MIGRATION_ID}`;
  if (authResult.explicitModeRequiredError) {
    blockers.push({
      id: `${authInspectionId}/explicit-mode-required`,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_AUTH_PREFLIGHT_MIGRATION_ID,
      code: "gateway-auth-mode-required",
      message: authResult.explicitModeRequiredError,
      remediation: ["Set gateway.auth.mode to token or password for the target Gateway."],
      configPath: "gateway.auth.mode",
    });
  }
  if (authResult.passwordMissing) {
    blockers.push({
      id: `${authInspectionId}/password-missing`,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_AUTH_PREFLIGHT_MIGRATION_ID,
      code: "gateway-password-missing",
      message: "Gateway auth is set to password, but no password is configured.",
      remediation: [
        "Set gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD for the target Gateway.",
      ],
      configPath: "gateway.auth.password",
    });
  }
  if (authResult.knownWeakCredentialError) {
    blockers.push({
      id: `${authInspectionId}/known-weak-credential`,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_AUTH_PREFLIGHT_MIGRATION_ID,
      code: "gateway-auth-known-weak",
      message: authResult.knownWeakCredentialError,
      remediation: ["Replace the published example credential before starting the Gateway."],
      configPath:
        authResult.auth.mode === "password" ? "gateway.auth.password" : "gateway.auth.token",
    });
  }
  if (bindResult.status === "blocked") {
    const suffix =
      bindResult.issue.code === "gateway-bind-auth-required"
        ? "bind-auth-required"
        : bindResult.issue.code;
    blockers.push({
      id: `${authInspectionId}/${suffix}`,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_AUTH_PREFLIGHT_MIGRATION_ID,
      code: bindResult.issue.code,
      message: bindResult.issue.message,
      remediation: bindResult.issue.remediation,
      configPath: bindResult.issue.configPath,
    });
  }
  if (runtimePolicyResult.status === "blocked") {
    const runtimeInspectionId = `${CORE_PREFLIGHT_PLUGIN_ID}/${CORE_RUNTIME_PREFLIGHT_MIGRATION_ID}`;
    blockers.push({
      id: `${runtimeInspectionId}/${runtimePolicyResult.issue.code}`,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_RUNTIME_PREFLIGHT_MIGRATION_ID,
      code: runtimePolicyResult.issue.code,
      message: runtimePolicyResult.issue.message,
      remediation: runtimePolicyResult.issue.remediation,
      configPath: runtimePolicyResult.issue.configPath,
    });
  } else if (
    bindResult.status !== "blocked" &&
    (bindResult.status === "indeterminate" || runtimePolicyResult.status === "indeterminate")
  ) {
    errors.push({
      id: `${authInspectionId}/bind`,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_AUTH_PREFLIGHT_MIGRATION_ID,
      code: "gateway-bind-inspection-required",
      message:
        bindResult.status === "indeterminate"
          ? bindResult.reason
          : runtimePolicyResult.status === "indeterminate"
            ? runtimePolicyResult.reason
            : `Gateway bind mode ${bindResult.mode} requires inspection.`,
    });
  }
  if (authResult.activeSecretRefPaths.length > 0) {
    errors.push({
      id: authInspectionId,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_AUTH_PREFLIGHT_MIGRATION_ID,
      code: "credential-inspection-required",
      message: `Gateway startup depends on credential references that preflight does not resolve: ${authResult.activeSecretRefPaths.join(", ")}.`,
    });
  }

  if (sessionResult?.status === "blocked") {
    for (const finding of sessionResult.findings) {
      blockers.push({
        id: `${inspectionId}/${finding.id}`,
        pluginId: CORE_PREFLIGHT_PLUGIN_ID,
        migrationId: CORE_SESSION_PREFLIGHT_MIGRATION_ID,
        code: finding.code,
        message: finding.message,
        remediation: finding.remediation,
        ...(finding.agentId ? { agentId: finding.agentId } : {}),
      });
    }
  } else if (sessionResult?.status === "indeterminate") {
    errors.push({
      id: inspectionId,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_SESSION_PREFLIGHT_MIGRATION_ID,
      code: "inspection-indeterminate",
      message: sessionResult.reason,
    });
  }
  return {
    checksRun: pluginResult.checksRun + 1 + (sessionResult ? 1 : 0),
    blockers: blockers.toSorted((left, right) => left.id.localeCompare(right.id)),
    errors: errors.toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

async function evaluateGatewayStartupPreflight(): Promise<GatewayStartupPreflightResult> {
  const previousJitiFsCache = process.env.JITI_FS_CACHE;
  process.env.JITI_FS_CACHE = "false";
  try {
    const inspection = await withReadOnlyPathCaseProbe(() =>
      withOpenClawStateDatabaseInspectionSnapshots(() =>
        withSqliteReadOnlyInspectionSnapshots(() =>
          evaluateGatewayStartupPreflightWithoutModuleCacheWrites(),
        ),
      ),
    );
    if (inspection.unresolvedDirectories.length === 0) {
      return inspection.value;
    }
    return createResult({
      checksRun: inspection.value.checksRun,
      blockers: inspection.value.blockers,
      errors: [
        ...inspection.value.errors,
        {
          id: "filesystem/path-case",
          code: "filesystem-inspection-indeterminate",
          message:
            "Could not determine filesystem case semantics without writing a probe entry: " +
            inspection.unresolvedDirectories.join(", "),
        },
      ],
    });
  } finally {
    if (previousJitiFsCache === undefined) {
      delete process.env.JITI_FS_CACHE;
    } else {
      process.env.JITI_FS_CACHE = previousJitiFsCache;
    }
  }
}

async function evaluateGatewayStartupPreflightWithoutModuleCacheWrites(): Promise<GatewayStartupPreflightResult> {
  let snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  try {
    snapshot = await readConfigFileSnapshot({ observe: false });
  } catch (error) {
    return createResult({
      errors: [
        {
          id: "config/read",
          code: "config-read-failed",
          message: formatErrorMessage(error),
        },
      ],
    });
  }
  if (!snapshot.valid) {
    const message =
      snapshot.issues.length > 0
        ? formatConfigIssueLines(snapshot.issues, "-").join("\n")
        : "Unknown config validation issue.";
    return createResult({
      errors: [
        {
          id: "config/validation",
          code: "invalid-config",
          message,
        },
      ],
    });
  }

  const startGuardErrors = getGatewayStartGuardErrors({
    configExists: snapshot.exists,
    configAuditLocation: CONFIG_AUDIT_STORE_LABEL,
    mode: snapshot.config.gateway?.mode,
  });
  if (startGuardErrors.length > 0) {
    const [message, ...remediation] = startGuardErrors;
    return createResult({
      checksRun: 1,
      blockers: [
        {
          id: `${CORE_PREFLIGHT_PLUGIN_ID}/${CORE_CONFIG_PREFLIGHT_MIGRATION_ID}/start-guard`,
          pluginId: CORE_PREFLIGHT_PLUGIN_ID,
          migrationId: CORE_CONFIG_PREFLIGHT_MIGRATION_ID,
          code: "gateway-start-config-blocked",
          message: message ?? "Gateway startup configuration is blocked.",
          ...(remediation.length > 0 ? { remediation } : {}),
          configPath: "gateway.mode",
        },
      ],
    });
  }

  const authResult = inspectGatewayStartupAuth({
    cfg: snapshot.config,
    env: process.env,
  });
  const shellEnvPlan = resolveGatewayShellEnvFallbackPlan(snapshot.config, process.env);
  const authShellEnvMissingKeys = shellEnvPlan.enabled
    ? resolveGatewayStartupAuthShellEnvMissingKeys({
        inspection: authResult,
        missingKeys: shellEnvPlan.missingKeys,
      })
    : [];
  if (authShellEnvMissingKeys.length > 0) {
    return createResult({
      checksRun: 2,
      errors: [
        {
          id: `${CORE_PREFLIGHT_PLUGIN_ID}/${CORE_ENVIRONMENT_PREFLIGHT_MIGRATION_ID}/shell-fallback`,
          pluginId: CORE_PREFLIGHT_PLUGIN_ID,
          migrationId: CORE_ENVIRONMENT_PREFLIGHT_MIGRATION_ID,
          code: "gateway-shell-env-inspection-required",
          message:
            "Gateway startup may import missing values from a login shell, which passive " +
            `preflight does not execute: ${authShellEnvMissingKeys.join(", ")}.`,
        },
      ],
    });
  }

  try {
    const tailscaleMode = snapshot.config.gateway?.tailscale?.mode ?? "off";
    const bindMode = snapshot.config.gateway?.bind ?? defaultGatewayBindMode(tailscaleMode);
    const bindResult = inspectGatewayStartupBindAuth({
      bindMode,
      customBindHost: snapshot.config.gateway?.customBindHost,
      hasSharedSecret: authResult.hasSharedSecret,
      resolvedAuthMode: authResult.auth.mode,
    });
    const runtimeConfig = ensureControlUiAllowedOriginsForNonLoopbackBind(snapshot.config, {
      runtimeBind: bindMode,
      runtimePort: snapshot.config.gateway?.port,
    }).config;
    const runtimePolicyResult = inspectGatewayStartupRuntimePolicy({
      authMode: authResult.auth.mode,
      hasSharedSecret: authResult.hasSharedSecret,
      hostClass: bindResult.status === "ready" ? bindResult.hostClass : "indeterminate",
      controlUiEnabled: runtimeConfig.gateway?.controlUi?.enabled ?? true,
      controlUiAllowedOrigins: (runtimeConfig.gateway?.controlUi?.allowedOrigins ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
      dangerouslyAllowHostHeaderOriginFallback:
        runtimeConfig.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
      tailscaleMode,
      trustedProxies: runtimeConfig.gateway?.trustedProxies ?? [],
    });
    const [pluginResult, sessionResult] = await Promise.all([
      collectGatewayStartupPreflight({
        config: snapshot.config,
        env: process.env,
        resolveSqliteReadOnlyLocation: resolveSqliteReadOnlyInspectionLocation,
      }),
      inspectStartupSessionMigrationPrerequisites({
        cfg: snapshot.config,
        env: process.env,
      }),
    ]);
    return createResult(
      combineCoreStartupPreflight(
        pluginResult,
        authResult,
        bindResult,
        runtimePolicyResult,
        sessionResult,
      ),
    );
  } catch (error) {
    return createResult(
      combineCoreStartupPreflight(
        {
          checksRun: 0,
          blockers: [],
          errors: [
            {
              id: "plugins/memory",
              code: "plugin-inspection-unavailable",
              message: formatErrorMessage(error),
            },
          ],
        },
        authResult,
        {
          mode: snapshot.config.gateway?.bind ?? "loopback",
          status: "ready",
          hostClass: "loopback",
        },
        { status: "ready" },
      ),
    );
  }
}

function renderHumanResult(result: GatewayStartupPreflightResult, runtime: RuntimeEnv): void {
  runtime.log(
    `Gateway startup preflight: ${result.status} (${result.checksRun} check${
      result.checksRun === 1 ? "" : "s"
    })`,
  );
  for (const blocker of result.blockers) {
    runtime.log(`- [${blocker.code}] ${blocker.message}`);
    for (const remediation of blocker.remediation ?? []) {
      runtime.log(`  ${remediation}`);
    }
  }
  for (const error of result.errors) {
    runtime.error(`- [${error.code}] ${error.message}`);
  }
}

export async function gatewayPreflightCommand(
  opts: { json?: boolean },
  runtime: RuntimeEnv | OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  const result = await evaluateGatewayStartupPreflight();
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    renderHumanResult(result, runtime);
  }
  if (result.status !== "ready") {
    runtime.exit(result.status === "blocked" ? 1 : 2, { resetStream: process.stderr });
  }
}
