// Tests gateway active-run matching by logical session key and backing id.
import { describe, expect, it } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  buildProjectedAgentRunIndex,
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import {
  collectTrackedActiveSessionRunSnapshot,
  collectTrackedActiveSessionRuns,
  hasTrackedActiveSessionRun,
  hasVisibleActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";
import type { GatewayRequestContext } from "./types.js";

it("keeps prebuilt active-run indexes in parity with per-row scans", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-main", { sessionKey: "agent:main:main", sessionId: "session-main" }],
      ["run-global", { sessionKey: "global", agentId: "work" }],
      ["run-hidden", { sessionKey: "agent:main:hidden", projectSessionActive: false }],
    ]),
  } as never;
  registerAgentRunContext("projected-key", {
    projectSessionActive: true,
    sessionKey: "agent:main:projected",
  });
  registerAgentRunContext("projected-id", {
    projectSessionActive: true,
    sessionId: "session-projected",
  });
  try {
    const trackedActiveRuns = collectTrackedActiveSessionRuns(context);
    const projectedAgentRunIndex = buildProjectedAgentRunIndex();
    const cases = [
      { requestedKey: "agent:main:main", canonicalKey: "agent:main:main" },
      { requestedKey: "agent:main:projected", canonicalKey: "agent:main:projected" },
      {
        requestedKey: "agent:main:by-id",
        canonicalKey: "agent:main:by-id",
        sessionId: "session-projected",
      },
      {
        requestedKey: "global",
        canonicalKey: "global",
        agentId: "work",
        defaultAgentId: "main",
      },
      { requestedKey: "agent:main:missing", canonicalKey: "agent:main:missing" },
    ];
    for (const activeCase of cases) {
      expect(
        resolveVisibleActiveSessionRunState({
          context,
          ...activeCase,
          trackedActiveRuns,
          projectedAgentRunIndex,
        }),
      ).toEqual(resolveVisibleActiveSessionRunState({ context, ...activeCase }));
    }
  } finally {
    clearAgentRunContext("projected-key");
    clearAgentRunContext("projected-id");
  }
});

function contextWithRuns(
  runs: Array<
    [
      string,
      {
        sessionId?: string;
        sessionKey?: string;
        agentId?: string;
        ownerConnId?: string;
        kind?: "chat-send" | "agent";
        startedAtMs?: number;
        expiresAtMs?: number;
        controlUiVisible?: boolean;
        projectSessionActive?: boolean;
        projectSessionTerminalPending?: boolean;
        projectSessionTerminalPersisted?: boolean;
      },
    ]
  >,
): Partial<Pick<GatewayRequestContext, "chatAbortControllers">> {
  return {
    chatAbortControllers: new Map(
      runs.map(([runId, run]) => [
        runId,
        {
          controller: new AbortController(),
          startedAtMs: 1_000,
          expiresAtMs: 10_000,
          ...run,
        },
      ]),
    ) as GatewayRequestContext["chatAbortControllers"],
  };
}

describe("session active runs", () => {
  it("matches session-id-only gateway runs during archive admission", () => {
    const context = contextWithRuns([
      [
        "run-1",
        {
          sessionId: "session-1",
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]);

    expect(
      hasVisibleActiveSessionRun({
        context,
        requestedKey: "agent:main:child",
        canonicalKey: "agent:main:child",
        sessionId: "session-1",
      }),
    ).toBe(true);
  });

  it("excludes the replacement run from an internal active-session check", () => {
    const sessionKey = "agent:main:main";
    const context = contextWithRuns([
      [
        "replacement-run",
        {
          sessionKey,
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]);

    expect(
      hasTrackedActiveSessionRun({
        context,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        excludeRunIds: new Set(["replacement-run"]),
      }),
    ).toBe(false);
    expect(
      hasTrackedActiveSessionRun({
        context,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
      }),
    ).toBe(true);
  });

  it("returns deterministic visible run ids for the selected session", () => {
    const context = contextWithRuns([
      ["run-z", { sessionKey: "main" }],
      ["run-hidden", { sessionKey: "main", controlUiVisible: false }],
      ["run-other", { sessionKey: "other" }],
      ["run-a", { sessionKey: "main" }],
    ]);

    expect(
      resolveVisibleActiveSessionRunState({
        context,
        requestedKey: "main",
        canonicalKey: "main",
      }),
    ).toEqual({ active: true, runIds: ["run-a", "run-z"] });
  });

  it("does not match a conflicting keyed run by session id alone", () => {
    const context = contextWithRuns([
      [
        "run-other",
        {
          sessionId: "session-1",
          sessionKey: "agent:main:other",
          agentId: "main",
        },
      ],
    ]);

    expect(
      resolveVisibleActiveSessionRunState({
        context,
        requestedKey: "agent:main:main",
        canonicalKey: "agent:main:main",
        sessionId: "session-1",
      }),
    ).toEqual({ active: false, runIds: [] });
    expect(
      collectTrackedActiveSessionRunSnapshot({
        context,
        requestedKey: "agent:main:main",
        canonicalKey: "agent:main:main",
        sessionId: "session-1",
      }),
    ).toEqual({ hasActiveRun: false, runs: [] });
  });

  it("does not match a session-id-only run from another agent", () => {
    const context = contextWithRuns([
      [
        "run-work",
        {
          sessionId: "session-1",
          agentId: "work",
        },
      ],
    ]);

    expect(
      resolveVisibleActiveSessionRunState({
        context,
        requestedKey: "agent:main:main",
        canonicalKey: "agent:main:main",
        sessionId: "session-1",
        defaultAgentId: "main",
      }),
    ).toEqual({ active: false, runIds: [] });
    expect(
      collectTrackedActiveSessionRunSnapshot({
        context,
        requestedKey: "agent:main:main",
        canonicalKey: "agent:main:main",
        sessionId: "session-1",
        defaultAgentId: "main",
      }),
    ).toEqual({ hasActiveRun: false, runs: [] });
  });

  it("projects a lifecycle-owned worker run without widening event visibility", () => {
    registerAgentRunContext("worker-run", {
      isControlUiVisible: false,
      projectSessionActive: true,
      sessionId: "worker-session",
      sessionKey: "agent:main:worker",
    });
    try {
      expect(
        resolveVisibleActiveSessionRunState({
          context: {},
          requestedKey: "agent:main:worker",
          canonicalKey: "agent:main:worker",
          sessionId: "worker-session",
        }),
      ).toEqual({ active: true, runIds: [] });
      expect(
        collectTrackedActiveSessionRunSnapshot({
          context: {},
          requestedKey: "agent:main:worker",
          canonicalKey: "agent:main:worker",
          sessionId: "worker-session",
        }),
      ).toEqual({ hasActiveRun: true, runs: [] });
    } finally {
      clearAgentRunContext("worker-run");
    }
  });

  it("preserves unscoped unknown fallback behavior for lifecycle projections", () => {
    registerAgentRunContext("unknown-run", {
      isControlUiVisible: false,
      projectSessionActive: true,
      sessionId: "session-main",
      sessionKey: "unknown",
      agentId: "main",
    });
    try {
      expect(
        resolveVisibleActiveSessionRunState({
          context: {},
          requestedKey: "unknown",
          canonicalKey: "unknown",
          sessionId: "session-work",
          agentId: "work",
          defaultAgentId: "main",
        }),
      ).toEqual({ active: true, runIds: [] });
      expect(
        resolveVisibleActiveSessionRunState({
          context: {},
          requestedKey: "unknown",
          canonicalKey: "unknown",
          sessionId: "session-work",
          agentId: "work",
          defaultAgentId: "main",
          scopeUnknownByAgent: true,
        }),
      ).toEqual({ active: false, runIds: [] });
    } finally {
      clearAgentRunContext("unknown-run");
    }
  });

  it("requires explicit ownership for strict multi-agent fallback projections", () => {
    const context = contextWithRuns([
      [
        "ownerless-controller",
        {
          sessionId: "shared-global-session",
        },
      ],
    ]);
    registerAgentRunContext("ownerless-lifecycle", {
      isControlUiVisible: false,
      projectSessionActive: true,
      sessionId: "shared-global-session",
      sessionKey: "global",
    });
    try {
      expect(
        collectTrackedActiveSessionRunSnapshot({
          context,
          requestedKey: "global",
          canonicalKey: "global",
          sessionId: "shared-global-session",
          agentId: "work",
          defaultAgentId: "main",
        }).hasActiveRun,
      ).toBe(true);
      expect(
        collectTrackedActiveSessionRunSnapshot({
          context,
          requestedKey: "global",
          canonicalKey: "global",
          sessionId: "shared-global-session",
          agentId: "work",
          defaultAgentId: "main",
          requireFallbackAgentOwnership: true,
        }),
      ).toEqual({ hasActiveRun: false, runs: [] });
    } finally {
      clearAgentRunContext("ownerless-lifecycle");
    }
  });
});

describe("collectTrackedActiveSessionRunSnapshot", () => {
  it("projects visible active runs without exposing internal ownership state", () => {
    const snapshot = collectTrackedActiveSessionRunSnapshot({
      context: contextWithRuns([
        [
          "run-visible",
          {
            sessionId: "session-1",
            sessionKey: "agent:main:main",
            agentId: "main",
            ownerConnId: "conn-1",
            kind: "agent",
            startedAtMs: 1_000,
            expiresAtMs: 11_000,
            projectSessionTerminalPending: true,
          },
        ],
        [
          "run-hidden",
          {
            sessionId: "session-hidden",
            sessionKey: "agent:main:main",
            controlUiVisible: false,
          },
        ],
      ]),
      requestedKey: "agent:main:main",
      canonicalKey: "agent:main:main",
      now: 6_000,
    });

    expect(snapshot).toEqual({
      hasActiveRun: true,
      runs: [
        {
          runId: "run-visible",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          kind: "agent",
          startedAtMs: 1_000,
          expiresAtMs: 11_000,
          startedAgeMs: 5_000,
          expiresInMs: 5_000,
          terminalPending: true,
        },
      ],
    });
  });

  it("projects visible runs that only carry the diagnosed session id", () => {
    const snapshot = collectTrackedActiveSessionRunSnapshot({
      context: contextWithRuns([
        [
          "run-id-only",
          {
            sessionId: "session-1",
            agentId: "main",
          },
        ],
      ]),
      requestedKey: "agent:main:main",
      canonicalKey: "agent:main:main",
      sessionId: "session-1",
      now: 6_000,
    });

    expect(snapshot).toMatchObject({
      hasActiveRun: true,
      runs: [
        {
          runId: "run-id-only",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          agentId: "main",
        },
      ],
    });
  });

  it("projects visible runs that only carry the diagnosed session key", () => {
    const snapshot = collectTrackedActiveSessionRunSnapshot({
      context: contextWithRuns([
        [
          "run-key-only",
          {
            sessionKey: "agent:main:main",
            agentId: "main",
          },
        ],
      ]),
      requestedKey: "agent:main:main",
      canonicalKey: "agent:main:main",
      sessionId: "session-1",
      now: 6_000,
    });

    expect(snapshot).toMatchObject({
      hasActiveRun: true,
      runs: [
        {
          runId: "run-key-only",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          agentId: "main",
        },
      ],
    });
  });

  it("matches global sessions by requested agent id", () => {
    const context = contextWithRuns([
      [
        "run-main",
        {
          sessionId: "session-main",
          sessionKey: "global",
          agentId: "main",
        },
      ],
      [
        "run-work",
        {
          sessionId: "session-work",
          sessionKey: "global",
          agentId: "work",
          projectSessionTerminalPersisted: true,
        },
      ],
    ]);

    expect(
      collectTrackedActiveSessionRunSnapshot({
        context,
        requestedKey: "global",
        canonicalKey: "global",
        agentId: "work",
        defaultAgentId: "main",
        now: 2_000,
      }).runs,
    ).toEqual([
      expect.objectContaining({
        runId: "run-work",
        sessionId: "session-work",
        terminalPersisted: true,
      }),
    ]);
  });

  it("keeps unknown fallback active runs unscoped by default", () => {
    const context = contextWithRuns([
      [
        "run-main",
        {
          sessionId: "session-main",
          sessionKey: "unknown",
          agentId: "main",
        },
      ],
      [
        "run-work",
        {
          sessionId: "session-work",
          sessionKey: "unknown",
          agentId: "work",
        },
      ],
    ]);

    expect(
      collectTrackedActiveSessionRunSnapshot({
        context,
        requestedKey: "unknown",
        canonicalKey: "unknown",
        agentId: "work",
        defaultAgentId: "main",
        now: 2_000,
      }).runs,
    ).toEqual([
      expect.objectContaining({
        runId: "run-main",
        sessionId: "session-main",
        agentId: "main",
      }),
      expect.objectContaining({
        runId: "run-work",
        sessionId: "session-work",
        agentId: "work",
      }),
    ]);
  });

  it("matches unknown fallback sessions by requested agent id when scoped", () => {
    const context = contextWithRuns([
      [
        "run-main",
        {
          sessionId: "session-main",
          sessionKey: "unknown",
          agentId: "main",
        },
      ],
      [
        "run-work",
        {
          sessionId: "session-work",
          sessionKey: "unknown",
          agentId: "work",
        },
      ],
    ]);

    expect(
      collectTrackedActiveSessionRunSnapshot({
        context,
        requestedKey: "unknown",
        canonicalKey: "unknown",
        agentId: "work",
        defaultAgentId: "main",
        scopeUnknownByAgent: true,
        now: 2_000,
      }).runs,
    ).toEqual([
      expect.objectContaining({
        runId: "run-work",
        sessionId: "session-work",
        agentId: "work",
      }),
    ]);
  });
});

it("does not project a terminal reply operation retained for settlement as active", () => {
  const sessionKey = "agent:main:reply-settling";
  const sessionId = "reply-settling-session";
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const replacementHandle: EmbeddedAgentQueueHandle = {
    abort: () => undefined,
    isAborted: () => false,
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => undefined,
  };
  try {
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: [] });

    operation.setPhase("running");
    expect(operation.abortByUser()).toBe(true);
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: false, runIds: [] });

    setActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: [] });
  } finally {
    clearActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    operation.complete();
  }
});

it("preserves an independent lifecycle-owned worker while a reply operation settles", () => {
  const sessionKey = "agent:main:worker-overlap";
  const sessionId = "worker-overlap-session";
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  registerAgentRunContext("worker-overlap-run", {
    projectSessionActive: true,
    sessionId,
    sessionKey,
  });
  try {
    expect(operation.abortByUser()).toBe(true);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: [] });
  } finally {
    operation.complete();
    clearAgentRunContext("worker-overlap-run");
  }
});

it("does not project an aborted embedded handle retained for cleanup as active", () => {
  const sessionKey = "agent:main:handle-settling";
  const sessionId = "handle-settling-session";
  let aborted = false;
  const handle: EmbeddedAgentQueueHandle = {
    abort: () => {
      aborted = true;
    },
    isAborted: () => aborted,
    isCompacting: () => false,
    // Prompt completion closes steering before post-turn finalization. That
    // state alone must not make a normally finishing run disappear.
    isStopped: () => true,
    isStreaming: () => false,
    queueMessage: async () => undefined,
  };
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  try {
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: [] });

    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(
      resolveVisibleActiveSessionRunState({
        context: {},
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: false, runIds: [] });

    expect(
      resolveVisibleActiveSessionRunState({
        context: {
          chatAbortControllers: new Map([["new-run", { sessionId, sessionKey }]]),
        } as never,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: ["new-run"] });
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
});
