import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  abandonTaskSuggestionAcceptance,
  beginTaskSuggestionAcceptance,
  completeTaskSuggestionAcceptance,
} from "../task-suggestion-registry.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import { taskSuggestionsHandlers } from "./task-suggestions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
const sessionReadState = vi.hoisted(() => ({ mode: "normal" as "normal" | "present" | "throw" }));

vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntryReadOnly: (...args: Parameters<typeof actual.loadSessionEntryReadOnly>) => {
      if (sessionReadState.mode === "throw") {
        throw new Error("session inspection unavailable");
      }
      const loaded = actual.loadSessionEntryReadOnly(...args);
      return sessionReadState.mode === "present"
        ? { ...loaded, entry: { sessionId: "surviving-session", updatedAt: 1 } }
        : loaded;
    },
  };
});

type Method =
  | "taskSuggestions.list"
  | "taskSuggestions.create"
  | "taskSuggestions.accept"
  | "taskSuggestions.dismiss";

const GIT_CWD = process.cwd();
const SOURCE_SESSION_KEY = "agent:main:source";

async function call(
  method: Method,
  params: Record<string, unknown>,
  broadcast = vi.fn(),
  overrides: {
    client?: GatewayClient | null;
    context?: Partial<GatewayRequestContext>;
  } = {},
) {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  await taskSuggestionsHandlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    respond,
    client: overrides.client ?? null,
    isWebchatConnect: () => true,
    context: { broadcast, getRuntimeConfig: () => ({}), ...overrides.context },
  } as never);
  return { response: calls[0], broadcast };
}

function requirePayload(result: Awaited<ReturnType<typeof call>>): unknown {
  expect(result.response?.[0]).toBe(true);
  if (!result.response?.[0]) {
    throw new Error("expected a successful gateway response");
  }
  return result.response[1];
}

async function dismissPendingTaskSuggestions(): Promise<void> {
  const listed = await call("taskSuggestions.list", {});
  const payload = requirePayload(listed) as { suggestions: Array<{ id: string }> };
  for (const suggestion of payload.suggestions) {
    await call("taskSuggestions.dismiss", { taskId: suggestion.id });
  }
}

beforeEach(async () => {
  sessionReadState.mode = "normal";
  await dismissPendingTaskSuggestions();
  mocks.handleChatSend.mockReset();
  mocks.handleChatSend.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, { runId: "suggested-task-run", status: "started" }, undefined);
  });
});
afterEach(async () => {
  await dismissPendingTaskSuggestions();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

function operatorClient(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
    },
  };
}

function configuredCloudContext(
  profiles: Record<string, { provider: string }> = { primary: { provider: "test" } },
): Partial<GatewayRequestContext> {
  return {
    workerEnvironmentService: {} as never,
    workerPlacementDispatchService: {} as never,
    getRuntimeConfig: () => ({ cloudWorkers: { profiles } }),
  };
}

async function createSourceSuggestion() {
  const created = await call("taskSuggestions.create", {
    title: "Fix the source session",
    prompt: "Apply the focused fix in this session.",
    tldr: "The current session already owns the relevant context.",
    cwd: GIT_CWD,
    sessionKey: SOURCE_SESSION_KEY,
    agentId: "main",
  });
  return (requirePayload(created) as { taskId: string }).taskId;
}

async function createLocalTaskSuggestion() {
  const created = await call("taskSuggestions.create", {
    title: "Add coverage",
    prompt: "Add the missing regression test.",
    tldr: "The edge case is untested.",
    cwd: GIT_CWD,
    sessionKey: "agent:main:main",
    agentId: "main",
  });
  return (requirePayload(created) as { taskId: string }).taskId;
}

describe("task suggestion gateway methods", () => {
  it("creates, lists, and resolves an ephemeral suggestion", async () => {
    const created = await call("taskSuggestions.create", {
      title: "  Remove stale adapter  ",
      prompt: "  Delete src/example.ts and update its tests.  ",
      tldr: "  The adapter is unreachable and adds maintenance cost.  ",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
    });
    const payload = requirePayload(created) as { taskId: string };
    expect(payload.taskId).toMatch(/^task_/);
    expect(created.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      expect.objectContaining({
        action: "created",
        suggestion: expect.objectContaining({
          agentId: "main",
          title: "Remove stale adapter",
          prompt: "Delete src/example.ts and update its tests.",
          tldr: "The adapter is unreachable and adds maintenance cost.",
        }),
      }),
      { dropIfSlow: true },
    );

    const listed = await call("taskSuggestions.list", {
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(listed.response?.[1]).toMatchObject({
      suggestions: [
        {
          id: payload.taskId,
          cwd: GIT_CWD,
          title: "Remove stale adapter",
          prompt: "Delete src/example.ts and update its tests.",
          tldr: "The adapter is unreachable and adds maintenance cost.",
        },
      ],
    });

    const resolved = await call("taskSuggestions.dismiss", {
      taskId: payload.taskId,
    });
    expect(resolved.response?.[1]).toEqual({ taskId: payload.taskId, dismissed: true });
    expect(resolved.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      { action: "resolved", taskId: payload.taskId, resolution: "dismissed" },
      { dropIfSlow: true },
    );

    const empty = await call("taskSuggestions.list", {});
    expect(empty.response?.[1]).toEqual({ suggestions: [] });
  });

  it("evicts accepted-session replay before an unseen pending suggestion", async () => {
    const created = await call("taskSuggestions.create", {
      title: "Remove stale adapter",
      prompt: "Delete src/example.ts and update its tests.",
      tldr: "The adapter is unreachable and adds maintenance cost.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const taskId = (requirePayload(created) as { taskId: string }).taskId;
    let sessionKey = "";
    const createSession = vi
      .spyOn(sessionCreateHandlers, "sessions.create")
      .mockImplementation(async ({ params, respond }) => {
        expect(params).toMatchObject({
          agentId: "main",
          parentSessionKey: "agent:main:main",
          label: "Remove stale adapter",
          task: "Delete src/example.ts and update its tests.",
          worktree: true,
          cwd: GIT_CWD,
        });
        sessionKey = (params as { key: string }).key;
        expect(sessionKey).toMatch(/^agent:main:dashboard:/);
        respond(true, { key: sessionKey, runStarted: true }, undefined);
      });

    const first = await call("taskSuggestions.accept", { taskId });
    for (let index = 0; index < 99; index += 1) {
      requirePayload(
        await call("taskSuggestions.create", {
          title: `Pending follow up ${index}`,
          prompt: `Complete pending follow-up task ${index}.`,
          tldr: "The operator has not accepted this follow-up.",
          cwd: GIT_CWD,
          sessionKey: "agent:main:main",
        }),
      );
    }

    const previous = await call("taskSuggestions.list", {});
    const pending = (requirePayload(previous) as { suggestions: Array<{ id: string }> })
      .suggestions;
    const oldestPending = pending.at(-1);
    expect(oldestPending).toBeDefined();
    const admitted = await call("taskSuggestions.create", {
      title: "Latest follow up",
      prompt: "Prefer unseen pending work over accepted replay state.",
      tldr: "Evict only the completed task replay.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
    });
    expect(admitted.response?.[0]).toBe(true);
    expect(admitted.broadcast).toHaveBeenCalledTimes(1);
    expect(admitted.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      expect.objectContaining({ action: "created" }),
      { dropIfSlow: true },
    );

    const retry = await call("taskSuggestions.accept", { taskId });
    const listed = await call("taskSuggestions.list", {});

    expect(first.response?.[1]).toEqual({ taskId, key: sessionKey });
    expect(retry.response?.[0]).toBe(false);
    expect(retry.response?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(
      (requirePayload(listed) as { suggestions: Array<{ id: string }> }).suggestions,
    ).toContainEqual(expect.objectContaining({ id: oldestPending?.id }));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(first.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      { action: "resolved", taskId, resolution: "accepted" },
      { dropIfSlow: true },
    );
  });

  it("admits new work when every bounded registry entry has already been accepted", async () => {
    const acceptedTaskIds: string[] = [];
    const createSession = vi
      .spyOn(sessionCreateHandlers, "sessions.create")
      .mockImplementation(async ({ params, respond }) => {
        respond(true, { key: (params as { key: string }).key, runStarted: true }, undefined);
      });

    for (let index = 0; index < 100; index += 1) {
      const created = await call("taskSuggestions.create", {
        title: `Accepted follow up ${index}`,
        prompt: `Complete accepted follow-up task ${index}.`,
        tldr: "This follow-up already created its managed task session.",
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
      });
      const taskId = (requirePayload(created) as { taskId: string }).taskId;
      const accepted = await call("taskSuggestions.accept", { taskId });
      expect(accepted.response?.[1]).toMatchObject({ taskId });
      acceptedTaskIds.push(taskId);
    }

    const replacement = await call("taskSuggestions.create", {
      title: "Latest follow up",
      prompt: "Keep accepting new suggestions after earlier tasks completed.",
      tldr: "Accepted-session replay is bounded best-effort state.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
    });

    expect(replacement.response?.[0]).toBe(true);
    expect(replacement.broadcast).toHaveBeenCalledTimes(1);
    expect(replacement.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      expect.objectContaining({ action: "created" }),
      { dropIfSlow: true },
    );
    const oldestRetry = await call("taskSuggestions.accept", { taskId: acceptedTaskIds[0] });
    expect(oldestRetry.response?.[0]).toBe(false);
    expect(oldestRetry.response?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(createSession).toHaveBeenCalledTimes(100);
  });

  it("coalesces concurrent acceptance requests", async () => {
    const created = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
    });
    const taskId = (requirePayload(created) as { taskId: string }).taskId;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createSession = vi
      .spyOn(sessionCreateHandlers, "sessions.create")
      .mockImplementation(async ({ params, respond }) => {
        await gate;
        respond(true, { key: (params as { key: string }).key, runStarted: true }, undefined);
      });

    const first = call("taskSuggestions.accept", { taskId });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const second = call("taskSuggestions.accept", { taskId });
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.response?.[1]).toEqual(secondResult.response?.[1]);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("starts local acceptance in the suggestion cwd without a worktree", async () => {
    const taskId = await createSourceSuggestion();
    const createSession = vi
      .spyOn(sessionCreateHandlers, "sessions.create")
      .mockImplementation(async ({ params, respond }) => {
        expect(params).toMatchObject({
          agentId: "main",
          parentSessionKey: SOURCE_SESSION_KEY,
          label: "Fix the source session",
          task: "Apply the focused fix in this session.",
          cwd: GIT_CWD,
        });
        expect(params).not.toHaveProperty("worktree");
        respond(true, { key: (params as { key: string }).key, runStarted: true }, undefined);
      });

    const accepted = await call("taskSuggestions.accept", { taskId, mode: "local" });

    expect(accepted.response?.[0]).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("rolls back a local session when its initial task does not start", async () => {
    const taskId = await createSourceSuggestion();
    let sessionKey = "";
    vi.spyOn(sessionCreateHandlers, "sessions.create").mockImplementation(
      async ({ params, respond }) => {
        sessionKey = (params as { key: string }).key;
        expect(params).not.toHaveProperty("worktree");
        expect(params).toMatchObject({ cwd: GIT_CWD });
        respond(true, { key: sessionKey, runStarted: false }, undefined);
      },
    );
    const deleteSession = vi
      .spyOn(sessionDeleteHandlers, "sessions.delete")
      .mockImplementation(async ({ respond }) => {
        respond(true, { deleted: true }, undefined);
      });

    const accepted = await call("taskSuggestions.accept", { taskId, mode: "local" });
    const listed = await call("taskSuggestions.list", {});

    expect(accepted.response?.[0]).toBe(false);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
  });

  it("creates, dispatches, then sends a cloud acceptance", async () => {
    const taskId = await createSourceSuggestion();
    const sequence: string[] = [];
    let sessionKey = "";
    vi.spyOn(sessionCreateHandlers, "sessions.create").mockImplementation(
      async ({ params, respond }) => {
        sequence.push("create");
        sessionKey = (params as { key: string }).key;
        expect(params).toEqual({
          key: sessionKey,
          agentId: "main",
          parentSessionKey: SOURCE_SESSION_KEY,
          label: "Fix the source session",
          worktree: true,
          cwd: GIT_CWD,
        });
        respond(true, { key: sessionKey, runStarted: false }, undefined);
      },
    );
    vi.spyOn(sessionDispatchHandlers, "sessions.dispatch").mockImplementation(
      async ({ params, respond }) => {
        sequence.push("dispatch");
        expect(params).toEqual({ key: sessionKey, agentId: "main", profileId: "primary" });
        respond(true, { ok: true, key: sessionKey }, undefined);
      },
    );
    mocks.handleChatSend.mockImplementationOnce(async ({ params, respond }) => {
      sequence.push("send");
      expect(params).toEqual({
        sessionKey,
        agentId: "main",
        message: "Apply the focused fix in this session.",
        idempotencyKey: `task-suggestion:${taskId}`,
      });
      respond(true, { runId: "cloud-run", status: "started" }, undefined);
    });

    const accepted = await call(
      "taskSuggestions.accept",
      { taskId, mode: "cloud", cloudProfileId: "primary" },
      vi.fn(),
      { client: operatorClient(), context: configuredCloudContext() },
    );

    expect(accepted.response?.[1]).toEqual({ taskId, key: sessionKey });
    expect(sequence).toEqual(["create", "dispatch", "send"]);
  });

  it.each([
    {
      label: "no configured profiles",
      context: configuredCloudContext({}),
      cloudProfileId: "primary",
      message: "no cloud worker profiles configured",
    },
    {
      label: "an unknown profile",
      context: configuredCloudContext(),
      cloudProfileId: "missing",
      message: "unknown cloud worker profile: missing",
    },
    {
      label: "a missing profile id",
      context: configuredCloudContext(),
      cloudProfileId: undefined,
      message: "cloudProfileId is required for cloud mode",
    },
  ])("rejects cloud acceptance with $label before handler calls", async (testCase) => {
    const taskId = await createSourceSuggestion();
    const createSession = vi.spyOn(sessionCreateHandlers, "sessions.create");
    const dispatchSession = vi.spyOn(sessionDispatchHandlers, "sessions.dispatch");

    const accepted = await call(
      "taskSuggestions.accept",
      {
        taskId,
        mode: "cloud",
        ...(testCase.cloudProfileId ? { cloudProfileId: testCase.cloudProfileId } : {}),
      },
      vi.fn(),
      { context: testCase.context },
    );

    expect(accepted.response?.[0]).toBe(false);
    expect(accepted.response?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: testCase.message,
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(mocks.handleChatSend).not.toHaveBeenCalled();
  });

  it("fully rolls back a cloud draft when dispatch fails", async () => {
    const taskId = await createSourceSuggestion();
    let sessionKey = "";
    vi.spyOn(sessionCreateHandlers, "sessions.create").mockImplementation(
      async ({ params, respond }) => {
        sessionKey = (params as { key: string }).key;
        respond(true, { key: sessionKey }, undefined);
      },
    );
    vi.spyOn(sessionDispatchHandlers, "sessions.dispatch").mockImplementation(
      async ({ respond }) => {
        respond(false, undefined, { code: "UNAVAILABLE", message: "dispatch unavailable" });
      },
    );
    const deleteSession = vi
      .spyOn(sessionDeleteHandlers, "sessions.delete")
      .mockImplementation(async ({ params, respond }) => {
        expect(params).toMatchObject({ key: sessionKey, agentId: "main" });
        respond(true, { deleted: true }, undefined);
      });

    const accepted = await call(
      "taskSuggestions.accept",
      { taskId, mode: "cloud", cloudProfileId: "primary" },
      vi.fn(),
      { context: configuredCloudContext() },
    );
    const listed = await call("taskSuggestions.list", {});

    expect(accepted.response?.[0]).toBe(false);
    expect(accepted.response?.[2]).toMatchObject({ message: "dispatch unavailable" });
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatSend).not.toHaveBeenCalled();
    expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
  });

  it("sends an idle session acceptance as a new turn and replays its source key", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "source-session", updatedAt: 1 },
      );
      const taskId = await createSourceSuggestion();
      const client = operatorClient();

      const accepted = await call("taskSuggestions.accept", { taskId, mode: "session" }, vi.fn(), {
        client,
        context: { chatAbortControllers: new Map() },
      });
      const replay = await call("taskSuggestions.accept", { taskId, mode: "session" });

      expect(accepted.response?.[1]).toEqual({ taskId, key: SOURCE_SESSION_KEY });
      expect(replay.response?.[1]).toEqual({ taskId, key: SOURCE_SESSION_KEY });
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
      expect(mocks.handleChatSend).toHaveBeenCalledWith(
        expect.objectContaining({
          client,
          params: {
            sessionKey: SOURCE_SESSION_KEY,
            agentId: "main",
            sessionId: "source-session",
            message: "Apply the focused fix in this session.",
            idempotencyKey: `task-suggestion:${taskId}`,
          },
        }),
      );
    });
  });

  it("steers a session acceptance into its one exact active run", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "source-session", updatedAt: 1 },
      );
      const taskId = await createSourceSuggestion();

      const accepted = await call("taskSuggestions.accept", { taskId, mode: "session" }, vi.fn(), {
        client: operatorClient(),
        context: {
          chatAbortControllers: new Map([
            [
              "run-one",
              { sessionKey: SOURCE_SESSION_KEY, sessionId: "source-session", agentId: "main" },
            ],
          ]) as never,
        },
      });

      expect(accepted.response?.[0]).toBe(true);
      expect(mocks.handleChatSend).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ queueMode: "steer", expectedRunId: "run-one" }),
        }),
      );
    });
  });

  it.each([
    { label: "multiple run IDs", runIds: ["run-one", "run-two"], projected: false },
    { label: "no exact run ID", runIds: [], projected: true },
  ])("rejects an active session with $label and restores the suggestion", async (testCase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "source-session", updatedAt: 1 },
      );
      const taskId = await createSourceSuggestion();
      const deleteSession = vi.spyOn(sessionDeleteHandlers, "sessions.delete");
      if (testCase.projected) {
        registerAgentRunContext("projected-task-suggestion-run", {
          projectSessionActive: true,
          sessionId: "source-session",
          sessionKey: SOURCE_SESSION_KEY,
        });
      }
      const activeRuns = new Map(
        testCase.runIds.map((runId) => [
          runId,
          {
            sessionKey: SOURCE_SESSION_KEY,
            sessionId: "source-session",
            agentId: "main",
            runId,
          },
        ]),
      );
      try {
        const accepted = await call(
          "taskSuggestions.accept",
          { taskId, mode: "session" },
          vi.fn(),
          {
            client: operatorClient(),
            context: { chatAbortControllers: activeRuns as never },
          },
        );
        const listed = await call("taskSuggestions.list", {});

        expect(accepted.response?.[0]).toBe(false);
        expect(accepted.response?.[2]).toMatchObject({
          code: "INVALID_REQUEST",
          details: { code: "SESSION_SUGGESTION_ACTIVE_RUN_AMBIGUOUS" },
        });
        if (testCase.projected) {
          expect(accepted.response?.[2]?.message).toBe(
            "active session run has no exact dispatch identity; refresh and retry",
          );
        }
        expect(mocks.handleChatSend).not.toHaveBeenCalled();
        expect(deleteSession).not.toHaveBeenCalled();
        expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
      } finally {
        if (testCase.projected) {
          clearAgentRunContext("projected-task-suggestion-run");
        }
      }
    });
  });

  it("rejects a missing source session and restores the suggestion", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const taskId = await createSourceSuggestion();
      const deleteSession = vi.spyOn(sessionDeleteHandlers, "sessions.delete");

      const accepted = await call("taskSuggestions.accept", { taskId, mode: "session" }, vi.fn(), {
        client: operatorClient(),
        context: { chatAbortControllers: new Map() },
      });
      const listed = await call("taskSuggestions.list", {});

      expect(accepted.response?.[0]).toBe(false);
      expect(accepted.response?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: "source session no longer exists; start it in a worktree instead",
      });
      expect(deleteSession).not.toHaveBeenCalled();
      expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
    });
  });

  it("restores a session-mode suggestion after delivery failure without deleting its source", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "source-session", updatedAt: 1 },
      );
      const taskId = await createSourceSuggestion();
      const deleteSession = vi.spyOn(sessionDeleteHandlers, "sessions.delete");
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        respond(false, undefined, { code: "UNAVAILABLE", message: "delivery unavailable" });
      });

      const accepted = await call("taskSuggestions.accept", { taskId, mode: "session" }, vi.fn(), {
        client: operatorClient(),
        context: { chatAbortControllers: new Map() },
      });
      const listed = await call("taskSuggestions.list", {});

      expect(accepted.response?.[0]).toBe(false);
      expect(accepted.response?.[2]).toMatchObject({ message: "delivery unavailable" });
      expect(deleteSession).not.toHaveBeenCalled();
      expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
    });
  });

  it("rejects an invalid acceptance mode before claiming the suggestion", async () => {
    const taskId = await createSourceSuggestion();
    const createSession = vi.spyOn(sessionCreateHandlers, "sessions.create");

    const accepted = await call("taskSuggestions.accept", { taskId, mode: "remote" });
    const listed = await call("taskSuggestions.list", {});

    expect(accepted.response?.[0]).toBe(false);
    expect(accepted.response?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(accepted.response?.[2]?.message).toContain("mode");
    expect(createSession).not.toHaveBeenCalled();
    expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
  });

  it("rolls back an empty session and keeps a failed seed suggestion pending", async () => {
    const taskId = await createLocalTaskSuggestion();
    let sessionKey = "";
    vi.spyOn(sessionCreateHandlers, "sessions.create").mockImplementation(
      async ({ params, respond }) => {
        sessionKey = (params as { key: string }).key;
        respond(
          true,
          {
            key: sessionKey,
            runStarted: false,
            runError: { message: "provider unavailable" },
          },
          undefined,
        );
      },
    );
    const deleteSession = vi
      .spyOn(sessionDeleteHandlers, "sessions.delete")
      .mockImplementation(async ({ params, respond }) => {
        expect(params).toEqual({
          key: sessionKey,
          agentId: "main",
          deleteTranscript: true,
          emitLifecycleHooks: false,
        });
        respond(true, { ok: true, deleted: true }, undefined);
      });

    const accepted = await call("taskSuggestions.accept", { taskId });
    const listed = await call("taskSuggestions.list", {});

    expect(accepted.response?.[0]).toBe(false);
    expect(accepted.response?.[2]).toMatchObject({ message: "provider unavailable" });
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(accepted.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      expect.objectContaining({
        action: "created",
        suggestion: expect.objectContaining({ id: taskId }),
      }),
      { dropIfSlow: true },
    );
    expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
  });

  it.each([true, false])(
    "rolls back a preallocated session when delete reports deleted=$deleted",
    async (deleted) => {
      const taskId = await createLocalTaskSuggestion();
      let sessionKey = "";
      vi.spyOn(sessionCreateHandlers, "sessions.create").mockImplementation(async ({ params }) => {
        sessionKey = (params as { key: string }).key;
        throw new Error("initial dispatch failed");
      });
      const deleteSession = vi
        .spyOn(sessionDeleteHandlers, "sessions.delete")
        .mockImplementation(async ({ params, respond }) => {
          expect(params).toMatchObject({ key: sessionKey, agentId: "main" });
          respond(true, { ok: true, deleted }, undefined);
        });

      const accepted = await call("taskSuggestions.accept", { taskId });
      const listed = await call("taskSuggestions.list", {});

      expect(accepted.response?.[0]).toBe(false);
      expect(accepted.response?.[2]).toMatchObject({ message: "initial dispatch failed" });
      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
    },
  );

  it.each([
    ["delete rejects", "reject"],
    ["delete throws", "throw"],
    ["the session row survives", "survives"],
    ["delete preserves the worktree", "preserved"],
    ["session inspection throws", "inspect-throws"],
  ] as const)("expires a suggestion when rollback is incomplete: %s", async (_name, failure) => {
    const taskId = await createLocalTaskSuggestion();
    vi.spyOn(sessionCreateHandlers, "sessions.create").mockRejectedValue(
      new Error("initial dispatch failed"),
    );
    sessionReadState.mode =
      failure === "survives" ? "present" : failure === "inspect-throws" ? "throw" : "normal";
    vi.spyOn(sessionDeleteHandlers, "sessions.delete").mockImplementation(async ({ respond }) => {
      if (failure === "throw") {
        throw new Error("delete handler failed");
      }
      if (failure === "reject") {
        respond(false, undefined, { code: "UNAVAILABLE", message: "still active" });
        return;
      }
      respond(
        true,
        {
          ok: true,
          deleted: true,
          ...(failure === "preserved"
            ? {
                worktreePreserved: {
                  id: "preserved-worktree",
                  path: "/preserved-worktree",
                  branch: "openclaw/preserved-worktree",
                },
              }
            : {}),
        },
        undefined,
      );
    });

    const accepted = await call("taskSuggestions.accept", { taskId });
    const listed = await call("taskSuggestions.list", {});

    expect(accepted.response?.[0]).toBe(false);
    expect(accepted.response?.[2]?.message).toContain("failed to roll back");
    expect(accepted.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      { action: "resolved", taskId, resolution: "expired" },
      { dropIfSlow: true },
    );
    expect(listed.response?.[1]).toEqual({ suggestions: [] });
  });

  it("rejects a relative cwd before recording or broadcasting", async () => {
    const result = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "relative/repo",
      sessionKey: "agent:main:main",
    });

    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({ message: "task suggestion cwd must be absolute" });
    expect(result.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a cwd outside a git checkout before recording or broadcasting", async () => {
    const result = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "/not-a-git-checkout",
      sessionKey: "agent:main:main",
    });

    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "task suggestion cwd must be inside a git checkout",
    });
    expect(result.broadcast).not.toHaveBeenCalled();
  });

  it.each(["title", "prompt", "tldr"] as const)(
    "rejects whitespace-only %s before recording or broadcasting",
    async (field) => {
      const params = {
        title: "Add coverage",
        prompt: "Add the missing regression test.",
        tldr: "The edge case is untested.",
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
      };
      params[field] = " \n\t ";

      const result = await call("taskSuggestions.create", params);

      expect(result.response?.[0]).toBe(false);
      expect(result.response?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
      expect(result.response?.[2]?.message).toContain(field);
      expect(result.broadcast).not.toHaveBeenCalled();
    },
  );

  it("rejects an agent that conflicts with the source session", async () => {
    const result = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
      agentId: "work",
    });

    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "task suggestion agentId must match its source session",
    });
    expect(result.broadcast).not.toHaveBeenCalled();
  });

  it("rejects retained fields beyond their protocol limits", async () => {
    const result = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "x".repeat(32_769),
      tldr: "The edge case is untested.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
    });

    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(result.broadcast).not.toHaveBeenCalled();
  });

  it("keeps the complete list below the retained payload budget", async () => {
    const taskIds: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      const created = await call("taskSuggestions.create", {
        title: `Follow up ${index}`,
        prompt: `${index}: ${"x".repeat(32_760)}`,
        tldr: "The follow-up remains useful.",
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
      });
      taskIds.push((requirePayload(created) as { taskId: string }).taskId);
    }

    const listed = await call("taskSuggestions.list", {});
    const payload = requirePayload(listed) as { suggestions: Array<{ id: string }> };
    expect(Buffer.byteLength(JSON.stringify(payload.suggestions))).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    expect(payload.suggestions.length).toBeLessThan(70);
    expect(payload.suggestions.some((suggestion) => suggestion.id === taskIds[0])).toBe(false);
  });

  it("broadcasts when the bounded registry expires a pending suggestion", async () => {
    for (let index = 0; index < 100; index += 1) {
      const created = await call("taskSuggestions.create", {
        title: `Follow up ${index}`,
        prompt: `Complete follow-up task ${index}.`,
        tldr: `Follow-up task ${index} remains useful.`,
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
      });
      requirePayload(created);
    }

    const previous = await call("taskSuggestions.list", {});
    const pending = (requirePayload(previous) as { suggestions: Array<{ id: string }> })
      .suggestions;
    const oldestPending = pending.at(-1);
    expect(oldestPending).toBeDefined();
    const replacement = await call("taskSuggestions.create", {
      title: "Latest follow up",
      prompt: "Complete the latest follow-up task.",
      tldr: "The latest follow-up remains useful.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
    });

    expect(replacement.response?.[0]).toBe(true);
    expect(replacement.broadcast).toHaveBeenNthCalledWith(
      1,
      "task.suggestion",
      { action: "resolved", taskId: oldestPending?.id, resolution: "expired" },
      { dropIfSlow: true },
    );
    const listed = await call("taskSuggestions.list", {});
    expect((requirePayload(listed) as { suggestions: unknown[] }).suggestions).toHaveLength(
      pending.length,
    );
  });

  it("rejects impossible byte admission without evicting accepted or pending suggestions", async () => {
    const acceptingTaskIds: string[] = [];
    const largePrompt = "🦀".repeat(16_000);

    try {
      for (let index = 0; index < 32; index += 1) {
        const created = await call("taskSuggestions.create", {
          title: `Running follow up ${index}`,
          prompt: largePrompt,
          tldr: "This accepted task is still starting.",
          cwd: GIT_CWD,
          sessionKey: "agent:main:main",
        });
        const taskId = (requirePayload(created) as { taskId: string }).taskId;
        expect(beginTaskSuggestionAcceptance(taskId).status).toBe("claimed");
        acceptingTaskIds.push(taskId);
      }

      const accepted = await call("taskSuggestions.create", {
        title: "Preserve accepted task",
        prompt: "Keep its accepted result available for retries.",
        tldr: "A rejected admission must not discard completed results.",
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
      });
      const acceptedTaskId = (requirePayload(accepted) as { taskId: string }).taskId;
      expect(beginTaskSuggestionAcceptance(acceptedTaskId).status).toBe("claimed");
      completeTaskSuggestionAcceptance(acceptedTaskId, "agent:main:dashboard:accepted");

      const pending = await call("taskSuggestions.create", {
        title: "Keep this follow up",
        prompt: "Do not discard this pending task.",
        tldr: "The operator has not accepted it yet.",
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
      });
      const pendingTaskId = (requirePayload(pending) as { taskId: string }).taskId;
      const rejected = await call("taskSuggestions.create", {
        title: "One oversized follow up",
        prompt: largePrompt,
        tldr: "This valid task cannot fit beside protected tasks.",
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
      });

      expect(rejected.response?.[0]).toBe(false);
      expect(rejected.response?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        message: "task suggestion registry is busy",
        retryable: true,
      });
      expect(rejected.broadcast).not.toHaveBeenCalled();
      expect(beginTaskSuggestionAcceptance(acceptedTaskId)).toEqual({
        status: "accepted",
        sessionKey: "agent:main:dashboard:accepted",
      });
      const listed = await call("taskSuggestions.list", {});
      expect(
        (requirePayload(listed) as { suggestions: Array<{ id: string }> }).suggestions,
      ).toEqual([expect.objectContaining({ id: pendingTaskId })]);
    } finally {
      for (const taskId of acceptingTaskIds) {
        expect(abandonTaskSuggestionAcceptance(taskId)).toBe(true);
      }
    }
  });

  it("rejects a new suggestion when every bounded registry entry is accepting", async () => {
    const claimedTaskIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const created = await call("taskSuggestions.create", {
        title: `Follow up ${index}`,
        prompt: `Complete follow-up task ${index}.`,
        tldr: `Follow-up task ${index} remains useful.`,
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
      });
      const taskId = (requirePayload(created) as { taskId: string }).taskId;
      expect(beginTaskSuggestionAcceptance(taskId).status).toBe("claimed");
      claimedTaskIds.push(taskId);
    }

    const rejected = await call("taskSuggestions.create", {
      title: "One too many",
      prompt: "Complete one more follow-up task.",
      tldr: "This follow-up can wait until capacity returns.",
      cwd: GIT_CWD,
      sessionKey: "agent:main:main",
    });

    expect(rejected.response?.[0]).toBe(false);
    expect(rejected.response?.[2]).toMatchObject({
      code: "UNAVAILABLE",
      message: "task suggestion registry is busy",
      retryable: true,
    });
    expect(rejected.broadcast).not.toHaveBeenCalled();

    for (const taskId of claimedTaskIds) {
      expect(abandonTaskSuggestionAcceptance(taskId)).toBe(true);
    }
  });
});
