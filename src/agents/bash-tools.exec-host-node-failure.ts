import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import { renderExecUpdateText } from "./bash-tools.exec-output.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { callGatewayTool } from "./tools/gateway.js";

type NodeInvokeFailure =
  | {
      reason: "not-dispatched";
      retrySafe: true;
      code: "NOT_CONNECTED";
      message: string;
      nodeCommandDispatched: false;
      requestSent?: boolean;
    }
  | {
      reason: "outcome-unknown";
      retrySafe: false;
      code?: string;
      message: string;
      nodeCommandDispatched?: boolean;
      requestSent?: boolean;
    };

type NodeSystemRunInvokeResult =
  | { ok: true; raw: unknown }
  | { ok: false; failure: NodeInvokeFailure };

/** Only NOT_CONNECTED plus explicit pre-dispatch provenance proves a retry cannot duplicate work. */
function classifyNodeInvokeFailure(error: unknown): NodeInvokeFailure {
  const errorRecord = asNullableRecord(error);
  const details = asNullableRecord(errorRecord?.details);
  const nodeError = asNullableRecord(details?.nodeError);
  const code = readString(nodeError?.code);
  const message =
    readString(nodeError?.message) ??
    (error instanceof Error ? error.message : readString(error)) ??
    "node invoke failed";
  const nodeCommandDispatched =
    typeof details?.nodeCommandDispatched === "boolean" ? details.nodeCommandDispatched : undefined;
  const requestSent =
    typeof errorRecord?.requestSent === "boolean" ? errorRecord.requestSent : undefined;

  if (code === "NOT_CONNECTED" && nodeCommandDispatched === false) {
    return {
      reason: "not-dispatched",
      retrySafe: true,
      code,
      message,
      nodeCommandDispatched,
      ...(requestSent !== undefined ? { requestSent } : {}),
    };
  }
  return {
    reason: "outcome-unknown",
    retrySafe: false,
    ...(code ? { code } : {}),
    message,
    ...(nodeCommandDispatched !== undefined ? { nodeCommandDispatched } : {}),
    ...(requestSent !== undefined ? { requestSent } : {}),
  };
}

function formatNodeInvokeFailureText(params: {
  failure: NodeInvokeFailure;
  nodeId: string;
  command: string;
}): string {
  const summary =
    params.failure.reason === "outcome-unknown"
      ? [
          `Node command outcome is unknown for ${params.nodeId}.`,
          "The command may have executed. Do not rerun it automatically.",
        ]
      : [
          `Node command was not dispatched to ${params.nodeId}.`,
          "It can be retried after the node reconnects.",
        ];
  return [
    ...summary,
    "",
    "Command:",
    params.command,
    "",
    `Details: ${params.failure.message}`,
  ].join("\n");
}

export function formatNodeInvokeFailureFollowup(params: {
  failure: NodeInvokeFailure;
  nodeId: string;
  approvalId: string;
  command: string;
}): string {
  const prefix =
    params.failure.reason === "outcome-unknown"
      ? `Exec outcome unknown (node=${params.nodeId} id=${params.approvalId}, outcome-unknown)`
      : `Exec not dispatched (node=${params.nodeId} id=${params.approvalId}, not-dispatched)`;
  return `${prefix}\n${formatNodeInvokeFailureText(params)}`;
}

export function formatNodeInvokeFailureToolResult(params: {
  failure: NodeInvokeFailure;
  nodeId: string;
  command: string;
  startedAt: number;
  cwd: string | undefined;
  warnings?: string[];
}): AgentToolResult<ExecToolDetails> {
  const text = formatNodeInvokeFailureText(params);
  return {
    content: [
      {
        type: "text",
        text: renderExecUpdateText({ tailText: text, warnings: params.warnings ?? [] }),
      },
    ],
    details: {
      status: "failed",
      exitCode: null,
      failureKind: params.failure.reason,
      reason: params.failure.reason,
      nodeInvokeFailure: {
        ...(params.failure.code ? { failureCode: params.failure.code } : {}),
        message: params.failure.message,
        ...(params.failure.nodeCommandDispatched !== undefined
          ? { nodeCommandDispatched: params.failure.nodeCommandDispatched }
          : {}),
        ...(params.failure.requestSent !== undefined
          ? { requestSent: params.failure.requestSent }
          : {}),
      },
      durationMs: Date.now() - params.startedAt,
      aggregated: text,
      cwd: params.cwd,
    },
  };
}

/** Invokes node system.run and turns every non-cancellation failure into provenance-aware data. */
export async function invokeNodeSystemRun(params: {
  invokeWaitMs: number;
  invoke: Record<string, unknown>;
  signal?: AbortSignal;
  scopes?: OperatorScope[];
}): Promise<NodeSystemRunInvokeResult> {
  try {
    const callOptions =
      params.scopes || params.signal
        ? {
            ...(params.scopes ? { scopes: params.scopes } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
          }
        : undefined;
    const raw = callOptions
      ? await callGatewayTool(
          "node.invoke",
          { timeoutMs: params.invokeWaitMs },
          params.invoke,
          callOptions,
        )
      : await callGatewayTool("node.invoke", { timeoutMs: params.invokeWaitMs }, params.invoke);
    if (typeof asNullableRecord(asNullableRecord(raw)?.payload)?.success !== "boolean") {
      return {
        ok: false,
        failure: {
          reason: "outcome-unknown",
          retrySafe: false,
          message: "malformed node invoke response",
        },
      };
    }
    return { ok: true, raw };
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    return { ok: false, failure: classifyNodeInvokeFailure(error) };
  }
}
