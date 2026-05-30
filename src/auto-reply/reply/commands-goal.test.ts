import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionEntry, upsertSessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { handleGoalCommand, parseGoalCommand } from "./commands-goal.js";
import type { HandleCommandsParams } from "./commands-types.js";

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

  it("starts a goal from Codex-style bare /goal objective text", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });

    const result = await handleGoalCommand(
      buildGoalParams("/goal build a 3d game", storePath),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("Goal started: build a 3d game");
    expect(getSessionEntry({ storePath, sessionKey })?.goal?.objective).toBe("build a 3d game");
  });
});
