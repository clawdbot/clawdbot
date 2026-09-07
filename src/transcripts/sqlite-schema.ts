// Additive meeting-transcript schema used by the feature's one-time lazy ensure.
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema.js";

export const ensureMeetingTranscriptsSchema = createOpenClawStateSchemaEnsurer({
  table: "meeting_transcript_sessions",
  endMarker: "  CHECK (summary_json IS NOT NULL OR markdown IS NOT NULL)\n) STRICT;\n",
  operationLabel: "meeting-transcripts.schema.ensure",
});
