import { getGatewayStartGuardErrors } from "../cli/gateway-cli/start-guard.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { CONFIG_AUDIT_STORE_LABEL } from "../config/io.audit.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { defaultGatewayBindMode } from "../gateway/net.js";
import {
  inspectStartupSessionMigrationPrerequisites,
  type SessionStartupPreflightResult,
} from "../gateway/server-startup-session-migration.js";
import {
  inspectGatewayStartupBindAuth,
  inspectGatewayStartupAuth,
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
const CORE_CONFIG_PREFLIGHT_MIGRATION_ID = "gateway-config";

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
    blockers.push({
      id: `${authInspectionId}/bind-auth-required`,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_AUTH_PREFLIGHT_MIGRATION_ID,
      code: "gateway-bind-auth-required",
      message: `Refusing to bind gateway to ${bindResult.mode} without auth.`,
      remediation: [
        "Set gateway.auth.token/password or the corresponding target environment variable.",
      ],
      configPath: "gateway.auth",
    });
  } else if (bindResult.status === "indeterminate") {
    errors.push({
      id: `${authInspectionId}/bind`,
      pluginId: CORE_PREFLIGHT_PLUGIN_ID,
      migrationId: CORE_AUTH_PREFLIGHT_MIGRATION_ID,
      code: "gateway-bind-inspection-required",
      message: bindResult.reason ?? `Gateway bind mode ${bindResult.mode} requires inspection.`,
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
  try {
    const tailscaleMode = snapshot.config.gateway?.tailscale?.mode ?? "off";
    const bindMode = snapshot.config.gateway?.bind ?? defaultGatewayBindMode(tailscaleMode);
    const bindResult = inspectGatewayStartupBindAuth({
      bindMode,
      customBindHost: snapshot.config.gateway?.customBindHost,
      hasSharedSecret: authResult.hasSharedSecret,
      resolvedAuthMode: authResult.auth.mode,
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
      combineCoreStartupPreflight(pluginResult, authResult, bindResult, sessionResult),
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
        },
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
