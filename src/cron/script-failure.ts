import type {
  CronFailureNotificationDetail,
  CronRunErrorClassification,
  CronTriggerFailureCode,
} from "./types.js";

function classifyCronScriptFailure(code: CronTriggerFailureCode): CronRunErrorClassification {
  if (code === "timeout") {
    return { kind: "reason", reason: "timeout" };
  }
  if (code === "runtime_unavailable") {
    return { kind: "reason", reason: "server_error" };
  }
  return { kind: "permanent" };
}

/** Authors matched retry policy and safe notification detail from one closed code. */
export function cronScriptFailureMetadata(
  source: Extract<CronFailureNotificationDetail, { kind: "script-failure" }>["source"],
  code: CronTriggerFailureCode,
) {
  return {
    errorClassification: classifyCronScriptFailure(code),
    failureNotificationDetail: { kind: "script-failure" as const, source, code },
  };
}
