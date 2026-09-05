import { createHash } from "node:crypto";
import type {
  AcpElicitationHandler,
  AcpElicitationResponse,
  AcpJsonRpcId,
} from "@openclaw/acp-core/runtime/types";
import { runStructuredInput } from "../../agents/harness/structured-input-execution.js";
import type { ReplyPayload } from "../types.js";
import { parseAcpElicitationRequest } from "./acp-elicitation.js";

const DEFAULT_ELICITATION_TIMEOUT_MS = 15 * 60_000;
const MAX_REQUEST_ID_TEXT = 128;

type AcpElicitationDelivery = {
  deliver: (kind: "block", payload: ReplyPayload) => Promise<boolean>;
};

export type AcpElicitationHandlerParams = {
  sourceSessionKey: string;
  targetSessionKey: string;
  outerRequestId: string;
  agentId: string;
  runId: string;
  delivery: AcpElicitationDelivery;
  isActive: () => boolean;
};

function questionId(params: {
  contextRequestId: AcpJsonRpcId;
  correlation: unknown;
  sourceSessionKey: string;
  targetSessionKey: string;
  outerRequestId: string;
  batch: number;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 24);
  return `acp_${digest}_${params.batch}`;
}

function cancellation(message: string): AcpElicitationResponse {
  return { action: "cancel", _meta: { message } };
}

function decline(message?: string): AcpElicitationResponse {
  return { action: "decline", ...(message ? { _meta: { message } } : {}) };
}

function isContextRequestIdValid(value: AcpJsonRpcId): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_TEXT)
  );
}

/** Creates the turn-owned ACP form/URL bridge used by channel delivery. */
export function createAcpElicitationHandler(
  params: AcpElicitationHandlerParams,
): AcpElicitationHandler {
  const delivery = {
    onBlockReply: async (payload: ReplyPayload) => {
      await params.delivery.deliver("block", payload);
    },
  };
  return async (request, context) => {
    if (
      !isContextRequestIdValid(context.requestId) ||
      context.signal.aborted ||
      !params.isActive()
    ) {
      return cancellation("ACP input request is no longer active.");
    }
    const parsed = parseAcpElicitationRequest(request);
    const result = await runStructuredInput({
      input: parsed.input,
      sessionKey: params.targetSessionKey,
      agentId: params.agentId,
      runId: params.runId,
      timeoutMs: DEFAULT_ELICITATION_TIMEOUT_MS,
      delivery,
      signal: context.signal,
      isActive: params.isActive,
      questionId: (batch) =>
        questionId({
          contextRequestId: context.requestId,
          correlation: parsed.correlation,
          sourceSessionKey: params.sourceSessionKey,
          targetSessionKey: params.targetSessionKey,
          outerRequestId: params.outerRequestId,
          batch,
        }),
      promptOptions: {
        unsupportedIntro: "ACP input request could not be shown:",
        urlIntro: "ACP needs confirmation:",
      },
    });
    if (result.status === "answered") {
      return parsed.input.kind === "ready" && parsed.input.plan.kind === "url"
        ? { action: "accept" }
        : { action: "accept", content: result.content };
    }
    if (result.status === "declined") {
      return decline(result.message);
    }
    if (result.status === "unsupported") {
      return decline(result.message);
    }
    return cancellation(result.message ?? "ACP input request was cancelled.");
  };
}
