import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionEntry, upsertSessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
});
