import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withReadOnlyPathCaseProbe } from "../infra/path-case.js";
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

async function evaluateGatewayStartupPreflight(): Promise<GatewayStartupPreflightResult> {
  const previousJitiFsCache = process.env.JITI_FS_CACHE;
  process.env.JITI_FS_CACHE = "false";
  try {
    const inspection = await withReadOnlyPathCaseProbe(() =>
      withOpenClawStateDatabaseInspectionSnapshots(() =>
        evaluateGatewayStartupPreflightWithoutModuleCacheWrites(),
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

  try {
    await ensureCliPluginRegistryLoaded({
      scope: "memory-embedding-providers",
      routeLogsToStderr: true,
      config: snapshot.config,
      ...(snapshot.sourceConfig ? { activationSourceConfig: snapshot.sourceConfig } : {}),
    });
    return createResult(
      await collectGatewayStartupPreflight({
        config: snapshot.config,
        env: process.env,
      }),
    );
  } catch (error) {
    return createResult({
      errors: [
        {
          id: "plugins/memory",
          code: "plugin-inspection-unavailable",
          message: formatErrorMessage(error),
        },
      ],
    });
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
