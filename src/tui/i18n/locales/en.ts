import type { LocalizationCatalog } from "@openclaw/localization-core";

export const TUI_ENGLISH_CATALOG = {
  "tui.status.heading": "Gateway status",
  "tui.status.version": "Version: {version}",
  "tui.status.linkChannelUnknown": "Link channel: unknown",
  "tui.status.linkChannelLabel": "Link channel",
  "tui.status.lastRefreshed": " (last refreshed {age})",
  "tui.status.linked": "linked",
  "tui.status.notLinked": "not linked",
  "tui.status.systemHeading": "System:",
  "tui.status.unknown": "unknown",
  "tui.status.disabledAgent": "disabled ({agent})",
  "tui.status.heartbeat": "Heartbeat: {summary}",
  "tui.status.sessionStore": "Session store: {path}",
  "tui.status.sessionStores": "Session stores: {count}",
  "tui.status.contextSuffix": " ({tokens} ctx)",
  "tui.status.defaultModel": "Default model: {model}{context}",
  "tui.status.activeSessions": "Active sessions: {count}",
  "tui.status.recentSessions": "Recent sessions:",
  "tui.status.noActivity": "no activity",
  "tui.status.flags": " | flags: {flags}",
  "tui.status.recentSession": "- {session}{kind} | {age} | model {model} | {usage}{flags}",
  "tui.status.queuedEvents": "Queued system events ({count}): {preview}",
  "tui.status.contextRemaining": "{remaining} left",
  "tui.status.contextUsage": "tokens {total}/{context}",
  "tui.status.contextUsageWithExtra": "tokens {total}/{context} ({extra})",
} as const satisfies LocalizationCatalog;

export type TuiMessageKey = keyof typeof TUI_ENGLISH_CATALOG;
