import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
  type DiagnosticEventMetadata,
} from "./diagnostic-events.js";
import {
  CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY,
  markCoreSemanticRunProgressDiagnosticEvent,
} from "./diagnostic-semantic-run-progress-provenance.js";

type CoreSemanticRunProgressEventInput = Omit<
  Extract<DiagnosticEventInput, { type: "run.progress" }>,
  "runId" | "type"
> & { runId: string };

type CoreSemanticRunProgressMetadata = DiagnosticEventMetadata &
  Readonly<{
    [CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY]?: boolean;
  }>;

/** Emits semantic run progress from the core boundary that validated the model result. */
export function emitCoreSemanticRunProgressDiagnosticEvent(
  event: CoreSemanticRunProgressEventInput,
): void {
  emitTrustedDiagnosticEvent(
    markCoreSemanticRunProgressDiagnosticEvent({
      ...event,
      type: "run.progress",
    }),
  );
}

/** Returns whether core validated the semantic model result that produced this progress event. */
export function isCoreSemanticRunProgressDiagnosticMetadata(
  metadata: DiagnosticEventMetadata,
): boolean {
  return (
    (metadata as CoreSemanticRunProgressMetadata)[CORE_SEMANTIC_RUN_PROGRESS_METADATA_KEY] === true
  );
}
