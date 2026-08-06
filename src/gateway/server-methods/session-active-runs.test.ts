// Tests gateway active-run matching by logical session key and backing id.
import { expect, it } from "vitest";
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
  collectTrackedActiveSessionRuns,
  hasRegisteredChatRunForSessionKey,
  hasTrackedActiveSessionRun,
  hasVisibleActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";

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

it("matches session-id-only gateway runs during archive admission", () => {
  const context = {
    chatAbortControllers: new Map([
      [
        "run-1",
        {
          sessionId: "session-1",
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]),
  } as never;

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
  const context = {
    chatAbortControllers: new Map([
      [
        "replacement-run",
        {
          sessionKey,
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]),
  } as never;

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
  const context = {
    chatAbortControllers: new Map([
      ["run-z", { sessionKey: "main" }],
      ["run-hidden", { sessionKey: "main", controlUiVisible: false }],
      ["run-other", { sessionKey: "other" }],
      ["run-a", { sessionKey: "main" }],
    ]),
  } as never;

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "main",
      canonicalKey: "main",
    }),
  ).toEqual({ active: true, runIds: ["run-a", "run-z"] });
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
  } finally {
    clearAgentRunContext("worker-run");
  }
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

it("counts settled but still registered chat runs for a session key", () => {
  const context = {
    chatAbortControllers: new Map([
      [
        "run-finalizing",
        {
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          projectSessionActive: false,
          controlUiVisible: false,
        },
      ],
      ["run-global-work", { sessionKey: "global", agentId: "work" }],
    ]),
  } as never;

  expect(
    hasRegisteredChatRunForSessionKey({
      context,
      sessionKey: "agent:main:main",
      agentId: undefined,
    }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({
      context,
      sessionKey: "agent:other:other",
      agentId: undefined,
    }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: "work" }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: "other" }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: undefined }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({
      context: {},
      sessionKey: "agent:main:main",
      agentId: undefined,
    }),
  ).toBe(false);
});
