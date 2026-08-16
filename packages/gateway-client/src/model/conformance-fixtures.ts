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

type ControlModelConformanceMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
  __openclaw: Readonly<{ id: string; seq: number }>;
}>;

function conformanceMessage(sequence: number): ControlModelConformanceMessage {
  return Object.freeze({
    role: sequence % 2 ? "user" : "assistant",
    content: `message-${sequence}`,
    __openclaw: Object.freeze({ id: `message-${sequence}`, seq: sequence }),
  });
}

export type ControlModelConversationOverlapConformanceFixture = Readonly<{
  id: string;
  initialHistory: readonly ControlModelConformanceMessage[];
  liveMessages: readonly ControlModelConformanceMessage[];
  authoritativeHistory: readonly ControlModelConformanceMessage[];
  expectedMessageIds: readonly string[];
}>;

export const CONTROL_MODEL_CONVERSATION_OVERLAP_CONFORMANCE_FIXTURES: readonly ControlModelConversationOverlapConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "conversation.reconciles-history-live-overlap",
      initialHistory: Object.freeze([conformanceMessage(2)]),
      liveMessages: Object.freeze([conformanceMessage(3), conformanceMessage(1)]),
      authoritativeHistory: Object.freeze([
        conformanceMessage(3),
        conformanceMessage(2),
        conformanceMessage(1),
        conformanceMessage(3),
      ]),
      expectedMessageIds: Object.freeze(["message-1", "message-2", "message-3"]),
    }),
  ]);

export type ControlModelConversationReconnectConformanceFixture = Readonly<{
  id: string;
  gapMessage: ControlModelConformanceMessage;
  authoritativeHistory: readonly ControlModelConformanceMessage[];
  retiredEpoch: number;
  nextEpoch: number;
  retiredLiveMessage: ControlModelConformanceMessage;
  expectedRetiredMessageId: string;
  expectedPartialReason: "transport-gap";
}>;

export const CONTROL_MODEL_CONVERSATION_RECONNECT_CONFORMANCE_FIXTURES: readonly ControlModelConversationReconnectConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "conversation.refreshes-gap-and-rejects-retired-epoch",
      gapMessage: conformanceMessage(2),
      authoritativeHistory: Object.freeze([conformanceMessage(2)]),
      retiredEpoch: 1,
      nextEpoch: 2,
      retiredLiveMessage: conformanceMessage(99),
      expectedRetiredMessageId: "message-99",
      expectedPartialReason: "transport-gap",
    }),
  ]);

export type ControlModelApprovalAuthorizationConformanceFixture = Readonly<{
  id: string;
  approval: Readonly<{
    id: string;
    status: "pending";
    sessionKey: string;
    presentation: Readonly<{
      kind: "exec";
      allowedDecisions: readonly ("allow-once" | "deny")[];
    }>;
  }>;
  deniedDecision: string;
  allowedDecision: "allow-once" | "deny";
  expectedDeniedCategory: "forbidden";
  terminalStatus: "expired";
}>;

const APPROVAL_DECISIONS: readonly ("allow-once" | "deny")[] = Object.freeze([
  "allow-once",
  "deny",
]);

export const CONTROL_MODEL_APPROVAL_AUTHORIZATION_CONFORMANCE_FIXTURES: readonly ControlModelApprovalAuthorizationConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "authorization.rejects-unlisted-and-forwards-allowed-approval-decision",
      approval: Object.freeze({
        id: "approval-1",
        status: "pending",
        sessionKey: "agent:main:one",
        presentation: Object.freeze({
          kind: "exec",
          allowedDecisions: APPROVAL_DECISIONS,
        }),
      }),
      deniedDecision: "maybe",
      allowedDecision: "allow-once",
      expectedDeniedCategory: "forbidden",
      terminalStatus: "expired",
    }),
  ]);
