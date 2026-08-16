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

type ControlModelConformanceEvent = Readonly<{
  event: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type ControlModelRunLifecycleConformanceFixture = Readonly<{
  id: string;
  events: readonly ControlModelConformanceEvent[];
  abortRunId: string;
  expectedActiveRunId: string;
  expectedRuns: readonly Readonly<{
    runId: string;
    status: "completed" | "aborted";
  }>[];
}>;

export const CONTROL_MODEL_RUN_LIFECYCLE_CONFORMANCE_FIXTURES: readonly ControlModelRunLifecycleConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "runs.project-stream-completion-and-exact-abort",
      events: Object.freeze([
        Object.freeze({
          event: "chat",
          payload: Object.freeze({
            sessionKey: "agent:main:one",
            runId: "run-complete",
            state: "delta",
            message: conformanceMessage(2),
          }),
        }),
        Object.freeze({
          event: "chat",
          payload: Object.freeze({
            sessionKey: "agent:main:one",
            runId: "run-complete",
            state: "final",
            message: Object.freeze({
              ...conformanceMessage(2),
              content: "complete",
            }),
          }),
        }),
        Object.freeze({
          event: "chat",
          payload: Object.freeze({
            sessionKey: "agent:main:one",
            runId: "run-abort",
            state: "delta",
          }),
        }),
        Object.freeze({
          event: "chat",
          payload: Object.freeze({
            sessionKey: "agent:main:one",
            runId: "run-active",
            state: "delta",
          }),
        }),
      ]),
      abortRunId: "run-abort",
      expectedActiveRunId: "run-active",
      expectedRuns: Object.freeze([
        Object.freeze({ runId: "run-complete", status: "completed" }),
        Object.freeze({ runId: "run-abort", status: "aborted" }),
      ]),
    }),
  ]);

export type ControlModelToolLifecycleConformanceFixture = Readonly<{
  id: string;
  events: readonly ControlModelConformanceEvent[];
  expectedTools: readonly Readonly<{
    toolCallId: string;
    status: "succeeded" | "failed" | "cancelled";
  }>[];
}>;

export const CONTROL_MODEL_TOOL_LIFECYCLE_CONFORMANCE_FIXTURES: readonly ControlModelToolLifecycleConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "tools.project-scoped-terminal-states",
      events: Object.freeze([
        Object.freeze({
          event: "agent",
          payload: Object.freeze({
            sessionKey: "agent:main:one",
            runId: "run-tools",
            stream: "tool",
            data: Object.freeze({
              phase: "start",
              name: "read",
              toolCallId: "tool-success",
              args: Object.freeze({ path: "a" }),
            }),
          }),
        }),
        Object.freeze({
          event: "agent",
          payload: Object.freeze({
            sessionKey: "agent:main:one",
            runId: "run-tools",
            stream: "tool",
            data: Object.freeze({
              phase: "result",
              name: "read",
              toolCallId: "tool-success",
              result: Object.freeze({ ok: true }),
            }),
          }),
        }),
        Object.freeze({
          event: "agent",
          payload: Object.freeze({
            sessionKey: "agent:main:one",
            runId: "run-tools",
            stream: "tool",
            data: Object.freeze({
              phase: "error",
              name: "write",
              toolCallId: "tool-failure",
              error: "denied",
            }),
          }),
        }),
        Object.freeze({
          event: "agent",
          payload: Object.freeze({
            sessionKey: "agent:main:one",
            runId: "run-tools",
            stream: "tool",
            data: Object.freeze({
              phase: "cancel",
              name: "exec",
              toolCallId: "tool-cancelled",
            }),
          }),
        }),
      ]),
      expectedTools: Object.freeze([
        Object.freeze({ toolCallId: "tool-success", status: "succeeded" }),
        Object.freeze({ toolCallId: "tool-failure", status: "failed" }),
        Object.freeze({ toolCallId: "tool-cancelled", status: "cancelled" }),
      ]),
    }),
  ]);

export type ControlModelQuestionLifecycleConformanceFixture = Readonly<{
  id: string;
  initialQuestion: Readonly<Record<string, unknown>>;
  requestedQuestion: Readonly<Record<string, unknown>>;
  answer: Readonly<Record<string, readonly string[]>>;
  terminalStatus: "cancelled";
}>;

export const CONTROL_MODEL_QUESTION_LIFECYCLE_CONFORMANCE_FIXTURES: readonly ControlModelQuestionLifecycleConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "questions.hydrate-answer-cancel-and-project-resolution",
      initialQuestion: Object.freeze({
        id: "question-answer",
        status: "pending",
        sessionKey: "agent:main:one",
      }),
      requestedQuestion: Object.freeze({
        id: "question-cancel",
        status: "pending",
        sessionKey: "agent:main:one",
      }),
      answer: Object.freeze({ choice: Object.freeze(["yes"]) }),
      terminalStatus: "cancelled",
    }),
  ]);

function conformanceArtifact(
  id: string,
  revision: number,
  views: readonly Readonly<Record<string, unknown>>[],
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: 1,
    id,
    revision,
    structuredContent: Object.freeze({ title: id }),
    views,
    state: "ready",
    source: Object.freeze({
      sessionKey: "agent:main:one",
      messageId: "message-2",
      toolCallId: "tool-artifact",
      toolName: "calendar",
    }),
    ...overrides,
  });
}

export type ControlModelArtifactConformanceFixture = Readonly<{
  id: string;
  historyMessage: Readonly<Record<string, unknown>>;
  artifactId: string;
  artifactRevision: number;
  selectedViewId: string;
  materializedResponse: Readonly<Record<string, unknown>>;
}>;

export const CONTROL_MODEL_ARTIFACT_CONFORMANCE_FIXTURES: readonly ControlModelArtifactConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "artifacts.sanitize-project-and-materialize-only-selected-view",
      historyMessage: Object.freeze({
        ...conformanceMessage(2),
        role: "toolResult",
        toolCallId: "tool-artifact",
        toolName: "calendar",
        details: Object.freeze({
          uiArtifacts: Object.freeze([
            conformanceArtifact(
              "artifact-calendar",
              4,
              Object.freeze([
                Object.freeze({
                  id: "calendar",
                  templateUri: "clawpilot://widgets/calendar",
                  dataVersion: 1,
                  availability: "deferred",
                }),
                Object.freeze({
                  id: "list",
                  templateUri: "clawpilot://widgets/list",
                  dataVersion: 1,
                  availability: "deferred",
                }),
              ]),
              Object.freeze({
                module: "https://attacker.invalid/component.js",
                registerComponent: "calendar",
              }),
            ),
          ]),
        }),
      }),
      artifactId: "artifact-calendar",
      artifactRevision: 4,
      selectedViewId: "list",
      materializedResponse: Object.freeze({
        artifactId: "artifact-calendar",
        artifactRevision: 4,
        view: Object.freeze({
          id: "list",
          templateUri: "clawpilot://widgets/list",
          dataVersion: 1,
          availability: "inline",
          data: Object.freeze({ rows: Object.freeze([Object.freeze({ id: "one" })]) }),
        }),
      }),
    }),
  ]);

export type ControlModelBoundsConformanceFixture = Readonly<{
  id: string;
  limits: Readonly<{
    messages: number;
    runs: number;
    tools: number;
    questions: number;
    artifacts: number;
    progressUpdates: number;
    progressBytes: number;
  }>;
  inputCount: number;
}>;

export const CONTROL_MODEL_BOUNDS_CONFORMANCE_FIXTURES: readonly ControlModelBoundsConformanceFixture[] =
  Object.freeze([
    Object.freeze({
      id: "bounds.truncate-each-retained-conversation-collection",
      limits: Object.freeze({
        messages: 2,
        runs: 2,
        tools: 2,
        questions: 2,
        artifacts: 2,
        progressUpdates: 2,
        progressBytes: 64,
      }),
      inputCount: 4,
    }),
  ]);
