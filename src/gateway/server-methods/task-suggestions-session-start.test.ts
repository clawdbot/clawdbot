import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  call,
  dismissPendingTaskSuggestions,
  requirePayload,
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
  closeOpenClawAgentDatabasesForTest();
});

describe("session-first task suggestion acceptance", () => {
  it.each(["plain folder", "unavailable Git metadata"])(
    "starts a follow-up without worktree setup: %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ workspaceDir }) => {
        const cwd = await fs.realpath(workspaceDir);
        const gitMarker = path.join(cwd, ".git");
        const brokenGit = "gitdir: /missing/follow-up-repository\n";
        if (scenario === "unavailable Git metadata") {
          await fs.writeFile(gitMarker, brokenGit);
        }
        const prompt = "Investigate the restarting local service without changing storage.";
        const config = { agents: { defaults: { workspace: cwd } } };
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
          { sessionId: "follow-up-source", updatedAt: 1 },
        );
        const created = await call(
          "taskSuggestions.create",
          {
            title: "Investigate a local service",
            prompt,
            tldr: "A local service is restarting repeatedly.",
            cwd,
            sessionKey: SOURCE_SESSION_KEY,
          },
          vi.fn(),
          { config },
        );
        const { taskId } = requirePayload(created) as { taskId: string };
        const accepted = await call("taskSuggestions.accept", { taskId, mode: "local" }, vi.fn(), {
          config,
          context: {
            loadGatewayModelCatalog: async () => [],
            getSessionEventSubscriberConnIds: () => new Set(),
          },
        });
        expect(accepted.response?.[2]).toBeUndefined();
        const { key } = requirePayload(accepted) as { key: string };
        expect(key).not.toBe(SOURCE_SESSION_KEY);
        const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
        expect(entry).toMatchObject({ spawnedCwd: cwd, parentSessionKey: SOURCE_SESSION_KEY });
        expect(entry).not.toHaveProperty("pendingWorktree");
        expect(entry).not.toHaveProperty("worktree");
        expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
        const dispatch = mocks.handleChatSend.mock.calls[0];
        if (!dispatch) {
          throw new Error("expected the follow-up task to reach agent dispatch");
        }
        expect(dispatch[0]).toMatchObject({
          params: { sessionKey: key, message: expect.stringContaining(prompt) },
        });
        const message = dispatch[0].params.message as string;
        expect(message).toContain("ask the user before creating or switching to it");
        expect(message.endsWith(`\n\n${prompt}`)).toBe(true);
        if (scenario === "unavailable Git metadata") {
          expect(await fs.readFile(gitMarker, "utf8")).toBe(brokenGit);
        } else {
          await expect(fs.stat(gitMarker)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );
});
