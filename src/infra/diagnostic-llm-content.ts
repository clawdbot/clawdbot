/** Per-field policy for diagnostic traces that may include model-visible content. */
export type DiagnosticModelContentCapturePolicy = {
  /** Capture chat/message payloads sent to a model. */
  inputMessages: boolean;
  /** Capture model response messages. */
  outputMessages: boolean;
  /** Capture tool invocation arguments. */
  toolInputs: boolean;
  /** Capture tool result payloads. */
  toolOutputs: boolean;
  /** Capture the system prompt or instruction block. */
  systemPrompt: boolean;
  /** Capture tool schemas/definitions presented to a model. */
  toolDefinitions: boolean;
  /** Whether any model-visible prompt/response/schema content is enabled. */
  anyModelContent: boolean;
};

const NO_MODEL_CONTENT_CAPTURE: DiagnosticModelContentCapturePolicy = Object.freeze({
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
  toolDefinitions: false,
  anyModelContent: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withDerivedFields(
  policy: Omit<DiagnosticModelContentCapturePolicy, "anyModelContent">,
): DiagnosticModelContentCapturePolicy {
  return {
    ...policy,
    anyModelContent:
      policy.inputMessages ||
      policy.outputMessages ||
      policy.systemPrompt ||
      policy.toolDefinitions,
  };
}

/** Resolves model-content diagnostic capture from config, defaulting to no content capture. */
export function resolveDiagnosticModelContentCapturePolicy(
  config: unknown,
): DiagnosticModelContentCapturePolicy {
  if (!isRecord(config)) {
    return NO_MODEL_CONTENT_CAPTURE;
  }
  const diagnostics = config.diagnostics;
  if (!isRecord(diagnostics) || diagnostics.enabled === false) {
    return NO_MODEL_CONTENT_CAPTURE;
  }
  const otel = diagnostics.otel;
  if (!isRecord(otel) || otel.enabled !== true || otel.traces === false) {
    return NO_MODEL_CONTENT_CAPTURE;
  }

  const captureContent = otel.captureContent;
  if (captureContent === true) {
    return withDerivedFields({
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: true,
    });
  }
  if (!isRecord(captureContent) || captureContent.enabled !== true) {
    return NO_MODEL_CONTENT_CAPTURE;
  }
  return withDerivedFields({
    inputMessages: captureContent.inputMessages === true,
    outputMessages: captureContent.outputMessages === true,
    toolInputs: captureContent.toolInputs === true,
    toolOutputs: captureContent.toolOutputs === true,
    systemPrompt: captureContent.systemPrompt === true,
    toolDefinitions: captureContent.toolDefinitions === true,
  });
}
