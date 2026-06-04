// Filesystem-backed session archive barrel. Gateway code imports this narrow
// surface instead of the transcript file module directly.
export {
  archiveFileOnDisk,
  archiveSessionTranscriptsDetailed,
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
  resolveStableSessionEndTranscript,
} from "./session-transcript-files.fs.js";
