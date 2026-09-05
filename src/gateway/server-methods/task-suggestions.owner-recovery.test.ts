import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { abandonTaskSuggestionAcceptance } from "../task-suggestion-registry.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import {
  call,
  configuredCloudContext,
  createSourceSuggestion,
  dismissPendingTaskSuggestions,
  SOURCE_SESSION_KEY,
} from "./task-suggestions.test-support.js";
import type { RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));

beforeEach(async () => {
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

describe("task suggestion owner recovery", () => {
  it.each(["worktree", "local", "cloud", "session"] as const)(
    "keeps %s suggestions retryable when their owner is temporarily unavailable",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
          { sessionId: "source-session", updatedAt: 1 },
        );
        const taskId = await createSourceSuggestion();
        const config: OpenClawConfig = {
          agents: { entries: { other: {} } },
          cloudWorkers: { profiles: { primary: { provider: "test" } } },
        };
        const context = { ...configuredCloudContext(), getRuntimeConfig: () => config };
        const acceptParams = {
          taskId,
          mode,
          ...(mode === "cloud" ? { cloudProfileId: "primary" } : {}),
        };
        const createSession = vi
          .spyOn(sessionCreateHandlers, "sessions.create")
          .mockImplementation(async ({ params, respond }) => {
            respond(true, { key: (params as { key: string }).key, runStarted: true }, undefined);
          });
        const dispatchSession = vi
          .spyOn(sessionDispatchHandlers, "sessions.dispatch")
          .mockImplementation(async ({ respond }) => respond(true, { ok: true }, undefined));
        try {
          const rejected = await call("taskSuggestions.accept", acceptParams, vi.fn(), { context });
          expect(rejected.response?.[2]).toMatchObject({
            code: "INVALID_REQUEST",
            message: 'Unknown agent id "main"',
          });
          expect(createSession).not.toHaveBeenCalled();
          expect(dispatchSession).not.toHaveBeenCalled();
          expect(mocks.handleChatSend).not.toHaveBeenCalled();
          const listed = await call("taskSuggestions.list", {});
          expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });

          config.agents = { entries: { main: {} } };
          const accepted = await call("taskSuggestions.accept", acceptParams, vi.fn(), { context });
          expect(accepted.response?.[0]).toBe(true);
          config.agents = { entries: { other: {} } };
          const replay = await call("taskSuggestions.accept", acceptParams, vi.fn(), { context });
          expect(replay.response).toEqual(accepted.response);
          expect(createSession).toHaveBeenCalledTimes(mode === "session" ? 0 : 1);
          expect(dispatchSession).toHaveBeenCalledTimes(mode === "cloud" ? 1 : 0);
          expect(mocks.handleChatSend).toHaveBeenCalledTimes(
            mode === "session" || mode === "cloud" ? 1 : 0,
          );
        } finally {
          abandonTaskSuggestionAcceptance(taskId);
        }
      });
    },
  );
});
