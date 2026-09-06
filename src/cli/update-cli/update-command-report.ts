/** Interactive, explicit consent flow for one final update failure report. */
import { isCancel } from "@clack/prompts";
import { confirm, select } from "../../commands/configure.shared.js";
import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  prepareUpdateFailureReport,
  submitUpdateFailureReport,
  type UpdateFailureReportSubmitResult,
} from "../../infra/update-failure-report.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { RuntimeEnv } from "../../runtime.js";

type UpdateFailureAction = "triage" | "report" | "dismiss";

function renderSubmissionResult(result: UpdateFailureReportSubmitResult): string[] {
  if (result.status === "created") {
    return [`Created GitHub issue: ${result.url}`, ...(result.message ? [result.message] : [])];
  }
  if (result.status === "fallback") {
    return [
      `GitHub issue creation was unavailable: ${result.message}`,
      `Prefilled issue: ${result.fallbackUrl}`,
      `Saved sanitized report: ${result.savedReportPath}`,
    ];
  }
  if (result.status === "retryable") {
    return [result.message];
  }
  return [
    result.message,
    ...(result.url ? [`Existing issue: ${result.url}`] : []),
    ...(result.fallbackUrl ? [`Existing prefilled issue: ${result.fallbackUrl}`] : []),
    `Saved sanitized report: ${result.savedReportPath}`,
  ];
}

/** Offers report as a distinct interactive action; callers retain triage ownership. */
export async function runInteractiveUpdateFailureAction(params: {
  attemptId: string;
  env: NodeJS.ProcessEnv;
  error?: string;
  result?: UpdateRunResult;
  runtime: Pick<RuntimeEnv, "error" | "log">;
}): Promise<"triage" | "handled"> {
  while (true) {
    const action = await select<UpdateFailureAction>({
      message: "Choose the next action for this failed update",
      options: [
        { value: "triage", label: "Diagnose update failure" },
        { value: "report", label: "Report update failure" },
        { value: "dismiss", label: "Exit" },
      ],
    });
    if (isCancel(action) || action === "dismiss") {
      return "handled";
    }
    if (action === "triage") {
      return "triage";
    }
    try {
      const result: UpdateRunResult = params.result ?? {
        status: "error",
        mode: "unknown",
        reason: "unexpected-error",
        steps: [],
        durationMs: 0,
      };
      const stateDir = resolveStateDir(params.env);
      const prepared = await prepareUpdateFailureReport(
        {
          attemptId: params.attemptId,
          ...(params.error ? { error: params.error } : {}),
          result,
          ...(result.after?.upstreamRef ? { target: result.after.upstreamRef } : {}),
        },
        { env: params.env, stateDir },
      );
      params.runtime.log("Sanitized update failure report preview:");
      params.runtime.log(prepared.body);
      const confirmed = await confirm({
        message: "Submit this sanitized report to openclaw/openclaw now?",
        initialValue: false,
      });
      if (isCancel(confirmed) || !confirmed) {
        params.runtime.log("Update failure report cancelled.");
        return "handled";
      }
      const submitted = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        env: params.env,
        stateDir,
      });
      for (const line of renderSubmissionResult(submitted)) {
        params.runtime.log(line);
      }
      if (submitted.status !== "retryable") {
        return "handled";
      }
    } catch (error) {
      params.runtime.error(`Update failure report failed: ${formatErrorMessage(error)}`);
    }
  }
}
