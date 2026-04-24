// Real workspace contract for QMD/session/query helpers used by the memory engine.

export { extractKeywords, isQueryStopWordToken } from "./host/query-expansion.js";
export {
  buildSessionEntry,
  listSessionFilesForAgent,
  loadDreamingNarrativeTranscriptPathSetForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  sessionPathForFile,
  type BuildSessionEntryOptions,
  type SessionFileEntry,
  type SessionTranscriptClassification,
} from "./host/session-files.js";
export { parseUsageCountedSessionIdFromFileName } from "../config/sessions/artifacts.js";
export { parseQmdQueryJson, type QmdQueryResult } from "./host/qmd-query-parser.js";
export {
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
} from "./host/qmd-scope.js";
export {
  checkQmdBinaryAvailability,
  resolveCliSpawnInvocation,
  runCliCommand,
} from "./host/qmd-process.js";
