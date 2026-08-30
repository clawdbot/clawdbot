/** Matrix-private request carried only to the host's admitted inbound boundary. */
export type MatrixTurnLocalBeforeAgentFinalize = (event: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider: string;
  model: string;
  lastAssistantMessage: string;
  revisionAttempt: number;
}) => Promise<MatrixTurnLocalBeforeAgentFinalizeResult> | MatrixTurnLocalBeforeAgentFinalizeResult;

export type MatrixSourceCleanupCapability = Readonly<{
  isSourceLive: () => boolean;
}>;

type MatrixTurnLocalBeforeAgentFinalizeResult =
  | { action: "continue" }
  | {
      action: "revise";
      instruction: string;
      disableTools: true;
      onAccepted?: (capability: MatrixSourceCleanupCapability) => Promise<void> | void;
    }
  | {
      action: "discard";
      onAccepted?: (capability: MatrixSourceCleanupCapability) => Promise<void> | void;
    };

type MatrixSourceFinalizationRequest = Readonly<{
  sourceContext: object;
  onBeforeAgentFinalize?: MatrixTurnLocalBeforeAgentFinalize;
}>;

const MATRIX_SOURCE_FINALIZATION_REQUEST = Symbol.for(
  "openclaw.matrixSourceFinalizationRequest.v1",
);

/**
 * Carries Matrix-owned finalization policy to core without publishing a Plugin SDK contract.
 * Core redeems it only for the exact live bundled Matrix inbound admission.
 */
export function bindMatrixSourceFinalizationRequest<T extends object>(params: {
  replyOptions: T;
  sourceContext: object;
  onBeforeAgentFinalize?: MatrixTurnLocalBeforeAgentFinalize;
}): T {
  const bound = { ...params.replyOptions };
  const request = Object.freeze({
    sourceContext: params.sourceContext,
    onBeforeAgentFinalize: params.onBeforeAgentFinalize,
  }) satisfies MatrixSourceFinalizationRequest;
  Object.defineProperty(bound, MATRIX_SOURCE_FINALIZATION_REQUEST, {
    configurable: false,
    enumerable: true,
    value: request,
    writable: false,
  });
  return bound;
}
