import { isRecord } from "@openclaw/normalization-core/record-coerce";

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

// Clone captured content so private diagnostic payloads never alias live runtime
// objects (tool params/results, model messages) that callers keep mutating.
export function cloneDiagnosticContentValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
    } catch {
      return String(value);
    }
  }
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
  return NO_MODEL_CONTENT_CAPTURE;
}
