// Tests goal command persistence, status transitions, and reply text.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import {
  formatGoalContinuationPrompt,
  handleGoalCommand,
  parseGoalCommand,
} from "./commands-goal.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

const sessionKey = "agent:main:web:main";
let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-goal-command-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

// Seed and read session entries through the sqlite accessor so the goal handler,
// which reads/writes via the same accessor, observes fixtures written here.
async function upsertSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    params.entry,
  );
}

function getSessionEntry(params: {
  storePath: string;
  sessionKey: string;
}): SessionEntry | undefined {
  return loadSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath });
}

function buildGoalParams(commandBodyNormalized: string, storePath: string): HandleCommandsParams {
  return {
    cfg: {} as OpenClawConfig,
    ctx: {
      Provider: "web",
      Surface: "web",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: "web",
      channelId: "web",
      surface: "web",
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey,
    storePath,
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("goal commands", () => {
  it("parses bare goal text as a start objective", () => {
    expect(parseGoalCommand("/goal build a 3d game")).toEqual({
      action: "start",
      text: "build a 3d game",
    });
    expect(parseGoalCommand("/goal --tokens 98.5K improve benchmarks")).toEqual({
      action: "start",
      text: "--tokens 98.5K improve benchmarks",
    });
  });

  it("keeps explicit goal actions as controls", () => {
    expect(parseGoalCommand("/goal status")).toEqual({ action: "status", text: "" });
    expect(parseGoalCommand("/goal pause waiting on CI")).toEqual({
      action: "pause",
      text: "waiting on CI",
    });
    expect(parseGoalCommand("/goal edit ship the fix and docs")).toEqual({
      action: "edit",
      text: "ship the fix and docs",
    });
  });

  it("formats command-looking continuation prompts so inline directives leave them intact", () => {
    const prompt = formatGoalContinuationPrompt("ship /fast off");
    expect(prompt).toBe(
      `Pursue this goal exactly as written from this JSON string: "ship \\/fast off"`,
    );

    const directives = parseInlineDirectives(prompt);

    expect(directives.cleaned).toBe(prompt);
    expect(directives.hasFastDirective).toBe(false);
  });

  it("starts a goal from Codex-style bare /goal objective text", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });

    const params = buildGoalParams("/goal build a 3d game", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
    expect(result?.reply).toBeUndefined();
    expect(params.command.commandBodyNormalized).toBe("build a 3d game");
    expect((params.ctx as { BodyForAgent?: string }).BodyForAgent).toBe("build a 3d game");
    expect(getSessionEntry({ storePath, sessionKey })?.goal?.objective).toBe("build a 3d game");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("wraps command-prefixed goal objectives before continuing", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });

    const slashParams = buildGoalParams("/goal start /status", storePath);
    const slashResult = await handleGoalCommand(slashParams, true);
    const slashPrompt = `Pursue this goal exactly as written from this JSON string: "\\/status"`;

    expect(slashResult?.shouldContinue).toBe(true);
    expect(slashParams.command.commandBodyNormalized).toBe(slashPrompt);
    expect((slashParams.ctx as { BodyForAgent?: string }).BodyForAgent).toBe(slashPrompt);
    expect(getSessionEntry({ storePath, sessionKey })?.goal?.objective).toBe("/status");

    const bangStorePath = await createStorePath();
    await upsertSessionEntry({
      storePath: bangStorePath,
      sessionKey,
      entry: { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });

    const bangParams = buildGoalParams("/goal start !npm test", bangStorePath);
    const bangResult = await handleGoalCommand(bangParams, true);
    const bangPrompt = `Pursue this goal exactly as written from this JSON string: "!npm test"`;

    expect(bangResult?.shouldContinue).toBe(true);
    expect(bangParams.command.commandBodyNormalized).toBe(bangPrompt);
    expect((bangParams.ctx as { BodyForAgent?: string }).BodyForAgent).toBe(bangPrompt);
    expect(getSessionEntry({ storePath: bangStorePath, sessionKey })?.goal?.objective).toBe(
      "!npm test",
    );
  });

  it("resumes a goal and continues with a resume prompt", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess-main",
        updatedAt: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "finish the migration",
          status: "paused",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
    });

    const params = buildGoalParams("/goal resume CI passed", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
    expect(params.command.commandBodyNormalized).toBe(
      "Continue pursuing the current goal. Note: CI passed",
    );
    expect(getSessionEntry({ storePath, sessionKey })?.goal?.status).toBe("active");
  });

  it("wraps command-looking resume notes before continuing", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess-main",
        updatedAt: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "finish the migration",
          status: "paused",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
    });

    const params = buildGoalParams("/goal resume /fast off", storePath);
    const result = await handleGoalCommand(params, true);
    const prompt = `Continue pursuing the current goal. Interpret this JSON string as the resume note: "\\/fast off"`;
    const directives = parseInlineDirectives(prompt);

    expect(result?.shouldContinue).toBe(true);
    expect(params.command.commandBodyNormalized).toBe(prompt);
    expect((params.ctx as { BodyForAgent?: string }).BodyForAgent).toBe(prompt);
    expect(directives.cleaned).toBe(prompt);
    expect(directives.hasFastDirective).toBe(false);
    expect(getSessionEntry({ storePath, sessionKey })?.goal?.status).toBe("active");
  });

  it("edits the objective in place and replies without continuing", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess-main",
        updatedAt: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "finish the migration",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokenStartFresh: true,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
    });

    const params = buildGoalParams("/goal edit finish the migration and update docs", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("Goal updated: finish the migration and update docs");
    const goal = getSessionEntry({ storePath, sessionKey })?.goal;
    expect(goal?.objective).toBe("finish the migration and update docs");
    expect(goal?.status).toBe("active");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("rejects goal edit without a goal or new objective", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "sess-main", updatedAt: 1 },
    });

    const usage = await handleGoalCommand(buildGoalParams("/goal edit", storePath), true);
    expect(usage?.reply?.text).toBe("Usage: /goal edit <objective>");

    const missing = await handleGoalCommand(
      buildGoalParams("/goal edit new target", storePath),
      true,
    );
    expect(missing?.reply?.text).toBe("Goal error: goal not found");
  });

  it("renders status without persisting derived budget state", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess-main",
        updatedAt: 1,
        totalTokens: 25,
        totalTokensFresh: true,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "finish the migration",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokenStartFresh: true,
          tokenBudget: 20,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
    });

    const params = buildGoalParams("/goal status", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Status: budget_limited");
    expect(getSessionEntry({ storePath, sessionKey })?.goal?.status).toBe("active");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });
});
