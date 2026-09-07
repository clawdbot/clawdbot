export type {
  SessionCatalogArchiveProviderParams,
  SessionCatalogContinueProviderParams,
  SessionCatalogContinueProviderResult,
  SessionCatalogEntrySnapshot,
  SessionCatalogEntrySummary,
  SessionCatalogListProviderParams,
  SessionCatalogProvider,
  SessionCatalogReadProviderParams,
  SessionCatalogStartTerminalProviderParams,
  SessionCatalogTerminalPlan,
  SessionUpstreamActivity,
  SessionUpstreamJsonValue,
  SessionUpstreamKind,
  SessionUpstreamProbe,
} from "../plugins/session-catalog.js";
export {
  createSessionCatalogAdoptionCoordinator,
  isExternalUserText,
  listAdoptedSessionCatalogSessions,
  listSessionCatalogEntries,
  normalizeUserText,
  sessionCatalogAdoptedSessionKey,
  sessionCatalogAdoptedSourceKey,
} from "../plugins/session-catalog.js";
export { importSessionCatalogHistory } from "../plugins/session-catalog-history-import.js";
export type {
  SessionCatalog,
  SessionCatalogCapabilities,
  SessionCatalogDescriptor,
  SessionCatalogHost,
  SessionCatalogLocator,
  SessionCatalogPullRequestSummary,
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogArchiveParams,
  SessionsCatalogArchiveResult,
  SessionsCatalogContinueParams,
  SessionsCatalogContinueResult,
  SessionsCatalogListParams,
  SessionsCatalogListResult,
  SessionsCatalogReadParams,
  SessionsCatalogReadResult,
  SessionsCatalogStartTerminalParams,
  SessionsCatalogStartTerminalResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
export {
  deleteSessionUpstreamLink,
  upsertSessionUpstreamLink,
} from "../sessions/session-upstream-links.js";
export {
  classifyClaudeCliHistoryMessage,
  classifyClaudeCliHistoryLine,
  type ClaudeCliHistoryLineClassification,
} from "../gateway/cli-session-history.claude-activity.js";
export {
  createSessionCatalogFamily,
  createSessionCatalogNodeHostBindings,
  type SessionCatalogFamilyOptions,
  type SessionCatalogNodeHostBindingsOptions,
} from "../plugins/session-catalog-family.js";

export { publishSessionCatalogHost, sessionCatalogPaging } from "./session-catalog-paging.js";
