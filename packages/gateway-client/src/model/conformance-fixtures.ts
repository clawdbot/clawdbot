export type ControlModelCatalogRefreshConformanceFixture = Readonly<{
  id: string;
  response: unknown;
  expected: Readonly<{
    status: "ready" | "error";
    sessionKeys: readonly string[];
    errorCode: string | null;
  }>;
}>;

export const CONTROL_MODEL_CATALOG_REFRESH_CONFORMANCE_FIXTURES: readonly ControlModelCatalogRefreshConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "catalog.accepts-authoritative-session-list",
      response: Object.freeze({
        sessions: Object.freeze([
          Object.freeze({ key: "agent:main:one", kind: "direct", label: "Primary" }),
        ]),
        totalCount: 1,
        hasMore: false,
      }),
      expected: Object.freeze({
        status: "ready",
        sessionKeys: Object.freeze(["agent:main:one"]),
        errorCode: null,
      }),
    }),
    Object.freeze({
      id: "catalog.rejects-malformed-session-list",
      response: Object.freeze({ sessions: null }),
      expected: Object.freeze({
        status: "error",
        sessionKeys: Object.freeze([]),
        errorCode: "CONTROL_MODEL_REQUEST_FAILED",
      }),
    }),
  ]);
