import {
  redactExecDetails,
  redactExecOutputText,
  renderExecUpdateText,
  withRedactionMarker,
} from "./bash-tools.exec-output.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

/** Formats a raw `node.invoke system.run` response as an exec tool result. */
export function formatNodeRunToolResult(params: {
  raw: unknown;
  startedAt: number;
  cwd: string | undefined;
  warnings?: string[];
}): AgentToolResult<ExecToolDetails> {
  const payload =
    params.raw && typeof params.raw === "object"
      ? (params.raw as { payload?: unknown }).payload
      : undefined;
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const stdout = typeof payloadObj.stdout === "string" ? payloadObj.stdout : "";
  const stderr = typeof payloadObj.stderr === "string" ? payloadObj.stderr : "";
  const errorText = typeof payloadObj.error === "string" ? payloadObj.error : "";
  const output = redactExecOutputText(stdout || stderr || errorText);
  const aggregated = redactExecOutputText([stdout, stderr, errorText].filter(Boolean).join("\n"));
  const warnings = (params.warnings ?? []).map((warning) => redactExecOutputText(warning));
  const success = typeof payloadObj.success === "boolean" ? payloadObj.success : false;
  const exitCode = typeof payloadObj.exitCode === "number" ? payloadObj.exitCode : null;
  const details = redactExecDetails({
    status: success ? "completed" : "failed",
    exitCode,
    durationMs: Date.now() - params.startedAt,
    aggregated: aggregated.text,
    cwd: params.cwd,
  } satisfies ExecToolDetails);
  const redacted =
    output.redacted ||
    aggregated.redacted ||
    warnings.some((warning) => warning.redacted) ||
    details.redacted;
  return {
    content: [
      {
        type: "text",
        text: renderExecUpdateText({
          tailText: output.text,
          warnings: warnings.map((warning) => warning.text),
          redacted,
        }),
      },
    ],
    details: withRedactionMarker(details.details, redacted),
  };
}
