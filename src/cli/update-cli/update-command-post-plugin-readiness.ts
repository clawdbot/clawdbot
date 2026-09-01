import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { runExec } from "../../process/exec.js";
import { resolveNodeRunner } from "./shared.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

type UpdateReadinessFinding = {
  checkId: string;
  message: string;
  source?: string;
  fixHint?: string;
};

type UpdateReadinessReport = {
  ok: boolean;
  checksRun: number;
  findings: UpdateReadinessFinding[];
};

function parseUpdateReadinessReport(stdout: string): UpdateReadinessReport {
  const result: unknown = JSON.parse(stdout);
  if (
    !isRecord(result) ||
    typeof result.ok !== "boolean" ||
    typeof result.checksRun !== "number" ||
    !Number.isInteger(result.checksRun) ||
    result.checksRun < 0 ||
    !Array.isArray(result.findings)
  ) {
    throw new Error("Updated Doctor returned an invalid readiness result.");
  }
  const findings = result.findings.map((finding): UpdateReadinessFinding => {
    if (
      !isRecord(finding) ||
      typeof finding.checkId !== "string" ||
      typeof finding.message !== "string" ||
      (finding.source !== undefined && typeof finding.source !== "string") ||
      (finding.fixHint !== undefined && typeof finding.fixHint !== "string")
    ) {
      throw new Error("Updated Doctor returned an invalid readiness finding.");
    }
    return {
      checkId: finding.checkId,
      message: finding.message,
      ...(finding.source !== undefined ? { source: finding.source } : {}),
      ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
    };
  });
  return { ok: result.ok, checksRun: result.checksRun, findings };
}

function createPostPluginReadinessExecutionFailure(
  pluginUpdate: PostCorePluginUpdateResult,
  reason: string,
): PostCorePluginUpdateResult {
  return {
    ...pluginUpdate,
    status: "error",
    reason: "post-plugin-update-readiness-execution-failed",
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      {
        reason,
        message: "Updated plugin readiness checks could not be completed before restart.",
        guidance: ["Run `openclaw update repair` to retry post-update readiness checks."],
      },
    ],
  };
}

export async function applyPostPluginUpdateReadiness(params: {
  root: string;
  entryPath?: string;
  pluginUpdate: PostCorePluginUpdateResult;
  timeoutMs: number;
  nodeRunner?: string;
}): Promise<PostCorePluginUpdateResult> {
  let entryPath = params.entryPath;
  if (!entryPath) {
    try {
      entryPath = await resolveGatewayInstallEntrypoint(params.root);
    } catch (error) {
      return createPostPluginReadinessExecutionFailure(params.pluginUpdate, String(error));
    }
  }
  if (!entryPath) {
    return createPostPluginReadinessExecutionFailure(
      params.pluginUpdate,
      "Updated OpenClaw entrypoint not found for post-plugin readiness checks",
    );
  }
  const args = [entryPath, "doctor", "--lint", "--json", "--severity-min", "error"];
  const baseEnv = stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env));
  delete baseEnv[UPDATE_POST_CORE_CONVERGENCE_ENV];
  let stdout: string;
  let executionFailed = false;
  try {
    stdout = (
      await runExec(params.nodeRunner ?? resolveNodeRunner(), args, {
        cwd: params.root,
        timeoutMs: params.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        logOutput: false,
        baseEnv,
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
        },
      })
    ).stdout;
  } catch (error) {
    if (!isRecord(error) || typeof error.stdout !== "string") {
      return createPostPluginReadinessExecutionFailure(params.pluginUpdate, String(error));
    }
    executionFailed = true;
    stdout = error.stdout;
  }

  let report: UpdateReadinessReport;
  try {
    report = parseUpdateReadinessReport(stdout);
  } catch (error) {
    return createPostPluginReadinessExecutionFailure(params.pluginUpdate, String(error));
  }
  if (report.ok && !executionFailed && report.checksRun > 0 && report.findings.length === 0) {
    return params.pluginUpdate;
  }
  if (report.findings.length === 0) {
    return createPostPluginReadinessExecutionFailure(
      params.pluginUpdate,
      report.checksRun === 0
        ? "Updated Doctor did not run a declared readiness check."
        : "Updated Doctor readiness checks failed without a finding.",
    );
  }
  return {
    ...params.pluginUpdate,
    status: "error",
    reason: "post-plugin-update-readiness-failed",
    warnings: [
      ...(params.pluginUpdate.warnings ?? []),
      ...report.findings.map((finding) => {
        const warning: NonNullable<PostCorePluginUpdateResult["warnings"]>[number] = {
          reason: finding.checkId,
          message: finding.message,
          guidance: [
            finding.fixHint ??
              `Resolve this finding, then rerun \`openclaw doctor --lint --only ${finding.checkId}\`.`,
          ],
        };
        if (finding.source) {
          warning.pluginId = finding.source;
        }
        return warning;
      }),
    ],
  };
}
