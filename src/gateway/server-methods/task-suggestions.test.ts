import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  abandonTaskSuggestionAcceptance,
  beginTaskSuggestionAcceptance,
  completeTaskSuggestionAcceptance,
} from "../task-suggestion-registry.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import {
  call,
  configuredCloudContext,
  createLocalTaskSuggestion,
  createSourceSuggestion,
  dismissPendingTaskSuggestions,
  GIT_CWD,
  operatorClient,
  requirePayload,
  SOURCE_SESSION_KEY,
} from "./task-suggestions.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
const sessionReadState = vi.hoisted(() => ({ mode: "normal" as "normal" | "present" | "throw" }));
type TaskOperatorRole = "none" | "view" | "suggest" | "restricted";
const taskRoleConfig = (role: TaskOperatorRole): OpenClawConfig => ({
  gateway: {
    roles: {
      default: "guest",
      definitions: {
        guest: {
          sessions: { others: role === "restricted" ? "write" : role },
          agents: role === "restricted" ? ["allowed"] : "*",
          scopes: ["operator.read", "operator.write"],
        },
      },
    },
  },
});

function taskRoleClient(profileId: string, admin = false): GatewayClient {
  const client = operatorClient();
  client.connect.scopes = admin ? ["operator.admin"] : ["operator.read", "operator.write"];
  client.authenticatedUserId = profileId;
  client.authenticatedUserProfile = {
    profileId,
    displayName: null,
    hasAvatar: false,
    updatedAt: 1,
  };
  return client;
}

async function createRoleSuggestion(sessionKey: string): Promise<string> {
  const created = await call("taskSuggestions.create", {
    title: "Follow up on this session",
    prompt: "Complete the session's suggested task.",
    tldr: "The session needs a follow-up task.",
    cwd: GIT_CWD,
    sessionKey,
    agentId: "main",
  });
  return (requirePayload(created) as { taskId: string }).taskId;
}

async function createTaskRoleScenario(role: TaskOperatorRole, ownsSource = false) {
  const profile = ensureProfileForEmail(`task-${role}@example.test`);
  const owner = ownsSource ? profile : ensureProfileForEmail(`task-${role}-owner@example.test`);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
    {
      sessionId: "shared-task-source",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: owner.id },
    },
  );
  const taskId = await createRoleSuggestion(SOURCE_SESSION_KEY);
  const client = taskRoleClient(profile.id);
  const request = (method: Parameters<typeof call>[0], params: Record<string, unknown> = {}) =>
    call(method, params, vi.fn(), { client, config: taskRoleConfig(role) });
  return { owner, profile, taskId, request };
}

vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadGatewaySessionEntryReadOnly: (
      ...args: Parameters<typeof actual.loadGatewaySessionEntryReadOnly>
    ) => {
      if (sessionReadState.mode === "throw") {
        throw new Error("session inspection unavailable");
      }
      const loaded = actual.loadGatewaySessionEntryReadOnly(...args);
      return sessionReadState.mode === "present"
        ? { ...loaded, entry: { sessionId: "surviving-session", updatedAt: 1 } }
        : loaded;
    },
  };
});

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

describe("task suggestion gateway methods", () => {
  it.each(["none", "view", "suggest", "restricted"] as const)(
    "enforces %s role ownership, session access, and agent-creation boundaries",
    async (roleName) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { owner, profile, taskId, request } = await createTaskRoleScenario(
          roleName,
          roleName === "restricted",
        );
        if (roleName === "none") {
          const ownSessionKey = "agent:main:dashboard:own-task-source";
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: ownSessionKey },
            {
              sessionId: "own-task-source",
              updatedAt: 1,
              createdActor: { type: "human", source: "profile", id: profile.id },
            },
          );
          const ownTaskId = await createRoleSuggestion(ownSessionKey);
          expect((await request("taskSuggestions.list")).response?.[1]).toMatchObject({
            suggestions: [{ id: ownTaskId }],
          });
          expect(
            (await request("taskSuggestions.list", { sessionKey: SOURCE_SESSION_KEY }))
              .response?.[1],
          ).toEqual({ suggestions: [] });
          expect(
            (await request("taskSuggestions.accept", { taskId, mode: "session" })).response?.[2],
          ).toMatchObject({
            code: "INVALID_REQUEST",
            message: expect.stringContaining("was not found"),
          });
          const dismissed = await request("taskSuggestions.dismiss", { taskId });
          expect(dismissed.response?.[1]).toEqual({ taskId, dismissed: false });
          expect(dismissed.broadcast).not.toHaveBeenCalled();
          expect(mocks.handleChatSend).not.toHaveBeenCalled();
          const admin = await call("taskSuggestions.list", {}, vi.fn(), {
            client: taskRoleClient(profile.id, true),
            config: taskRoleConfig("none"),
          });
          expect(admin.response?.[1]).toMatchObject({
            suggestions: [{ id: ownTaskId }, { id: taskId }],
          });
          return;
        }
        if (roleName === "restricted") {
          const createSession = vi.spyOn(sessionCreateHandlers, "sessions.create");
          for (const mode of ["worktree", "local", "cloud"] as const) {
            const accepted = await request("taskSuggestions.accept", { taskId, mode });
            expect(accepted.response?.[2], mode).toMatchObject({
              code: "FORBIDDEN",
              message: expect.stringContaining('agent "main"'),
            });
          }
          expect(createSession).not.toHaveBeenCalled();
          expect(mocks.handleChatSend).not.toHaveBeenCalled();
          const accepted = await request("taskSuggestions.accept", { taskId, mode: "session" });
          expect(accepted.response?.[1]).toEqual({ taskId, key: SOURCE_SESSION_KEY });
          expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
          return;
        }
        const rejected = await request("taskSuggestions.accept", { taskId, mode: "session" });
        const dismissed = await request("taskSuggestions.dismiss", { taskId });
        expect(rejected.response?.[2]).toMatchObject({
          details: { code: "SESSION_PARTICIPATION_REQUIRED", visibility: "shared" },
        });
        expect(dismissed.response?.[1]).toEqual({ taskId, dismissed: false });
        expect(mocks.handleChatSend).not.toHaveBeenCalled();
        addSessionMember(
          { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
          {
            identityId: profile.id,
            addedBy: owner.id,
            expectedSessionId: "shared-task-source",
          },
        );
        const accepted = await request("taskSuggestions.accept", { taskId, mode: "session" });
        const replay = await request("taskSuggestions.accept", { taskId, mode: "session" });
        expect(accepted.response?.[1]).toEqual({ taskId, key: SOURCE_SESSION_KEY });
        expect(replay.response?.[1]).toEqual({ taskId, key: SOURCE_SESSION_KEY });
        expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
      });
    },
  );

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
      { dropIfSlow: true, sessionKeys: ["agent:main:main"], agentId: "main" },
    );

    const empty = await call("taskSuggestions.list", {});
    expect(empty.response?.[1]).toEqual({ suggestions: [] });
  });

  it("attributes a bare source session to the persisted fixed-store owner", async () => {
    const config = {
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        list: [{ id: "ops" }, { id: "research" }],
        defaults: { sessionStore: { agentId: "ops" } },
      },
    };
    const created = await call(
      "taskSuggestions.create",
      {
        title: "Inspect the deployment",
        prompt: "Check the deployment logs.",
        tldr: "Deployment needs inspection.",
        cwd: GIT_CWD,
        sessionKey: "global",
      },
      vi.fn(),
      config,
    );

    expect(created.response?.[0]).toBe(true);
    expect(created.response?.[1]).toMatchObject({ suggestion: { agentId: "ops" } });
    const listed = await call("taskSuggestions.list", { sessionKey: "global" }, vi.fn(), config);
    expect(listed.response?.[1]).toMatchObject({
      suggestions: [expect.objectContaining({ agentId: "ops", sessionKey: "global" })],
    });
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
      { dropIfSlow: true, sessionKeys: ["agent:main:main"], agentId: "main" },
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
        queueMode: "steer",
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
      await upsertSessionEntryCore(
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

      expect(accepted.response?.[0]).toBe(true);
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
            queueMode: "steer",
            idempotencyKey: `task-suggestion:${taskId}`,
          },
        }),
      );
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
        message: "source session no longer exists; start it in a new session instead",
      });
      expect(deleteSession).not.toHaveBeenCalled();
      expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
    });
  });

  it("restores a session-mode suggestion after delivery failure without deleting its source", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
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
                  reason: "cleanup-failed",
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
      { dropIfSlow: true, sessionKeys: ["agent:main:main"], agentId: "main" },
    );
    expect(listed.response?.[1]).toEqual({ suggestions: [] });
  });

  it("rejects a relative cwd before recording or broadcasting", async () => {
    const result = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "relative/folder",
      sessionKey: "agent:main:main",
    });
    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "task suggestion cwd must be absolute",
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
    const result = await call(
      "taskSuggestions.create",
      {
        title: "Add coverage",
        prompt: "Add the missing regression test.",
        tldr: "The edge case is untested.",
        cwd: GIT_CWD,
        sessionKey: "agent:main:main",
        agentId: "work",
      },
      vi.fn(),
      { agents: { list: [{ id: "main" }, { id: "work" }] } },
    );

    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'agent "work" does not match session key agent "main"',
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
      { dropIfSlow: true, sessionKeys: ["agent:main:main"], agentId: "main" },
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
