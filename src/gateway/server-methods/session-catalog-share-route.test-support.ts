import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

export const TEST_SESSION_CATALOG_SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "shared-sessions",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const satisfies NonNullable<SessionCatalogProvider["shareRoute"]>;
