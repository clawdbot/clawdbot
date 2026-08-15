// Filesystem-backed session archive barrel. Gateway code imports this narrow
// surface instead of the transcript file module directly.
export {
  archiveSessionTranscriptPaths,
  archiveSessionTranscriptsDetailed,
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
  resolveSessionTranscriptCandidates,
  resolveStableSessionEndTranscript,
} from "./session-transcript-files.fs.js";
