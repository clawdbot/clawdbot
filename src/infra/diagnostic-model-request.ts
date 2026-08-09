import {
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticEventInput,
  type DiagnosticEventMetadata,
  type DiagnosticEventPrivateData,
} from "./diagnostic-events.js";
import {
  CORE_MODEL_REQUEST_STARTED_METADATA_KEY,
  markCoreModelRequestStartedDiagnosticEvent,
} from "./diagnostic-model-request-provenance.js";

type CoreModelRequestStartedEventInput = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "observationUnit" | "type"
>;

type CoreModelRequestStartedMetadata = DiagnosticEventMetadata &
  Readonly<{
    [CORE_MODEL_REQUEST_STARTED_METADATA_KEY]?: boolean;
  }>;

/** Emits a request attempt from the core boundary that owns provider streaming. */
export function emitCoreModelRequestStartedDiagnosticEvent(
  event: CoreModelRequestStartedEventInput,
  privateData?: DiagnosticEventPrivateData,
): void {
  emitTrustedDiagnosticEventWithPrivateData(
    markCoreModelRequestStartedDiagnosticEvent({
      ...event,
      type: "model.call.started",
      observationUnit: "request" as const,
    }),
    privateData,
  );
}

/** Returns whether core observed the provider request represented by this event. */
export function isCoreModelRequestStartedDiagnosticMetadata(
  metadata: DiagnosticEventMetadata,
): boolean {
  return (
    (metadata as CoreModelRequestStartedMetadata)[CORE_MODEL_REQUEST_STARTED_METADATA_KEY] === true
  );
}
