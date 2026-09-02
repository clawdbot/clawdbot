import type { TranscriptSessionDescriptor } from "./provider-types.js";

export type TranscriptsSessionEntry = {
  session: TranscriptSessionDescriptor;
  sessionDir: string;
  selector: string;
  summaryPath: string;
  hasSummary: boolean;
};

export type TranscriptArtifactKind = "all" | "metadata" | "summary" | "transcript";

export type MaterializedTranscriptArtifacts = {
  sessionDir: string;
  metadataPath: string;
  transcriptPath: string;
  summaryJsonPath: string;
  summaryPath: string;
  hasSummary: boolean;
};
