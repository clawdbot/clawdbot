// Tests /learn prompt rewriting, defaults, standards, and availability gating.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_LEARN_REQUEST } from "../../skills/workshop/learn-prompt.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleLearnCommand } from "./commands-learn.js";
import type { HandleCommandsParams } from "./commands-types.js";

const DEFAULT_TEST_MODELS: NonNullable<OpenClawConfig["models"]> = {
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
          compat: { supportsTools: true },
        },
      ],
    },
  },
};

function buildLearnParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = {},
): HandleCommandsParams {
  return {
    cfg: { ...cfg, models: cfg.models ?? DEFAULT_TEST_MODELS },
    ctx: {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      CommandSource: "text",
      Body: commandBodyNormalized,
      RawBody: commandBodyNormalized,
      CommandBody: commandBodyNormalized,
      BodyForCommands: commandBodyNormalized,
      BodyForAgent: commandBodyNormalized,
      BodyStripped: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: INTERNAL_MESSAGE_CHANNEL,
      channelId: INTERNAL_MESSAGE_CHANNEL,
      surface: INTERNAL_MESSAGE_CHANNEL,
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:webchat:test",
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

describe("learn command", () => {
  it("rewrites the agent and normalized command bodies and continues", async () => {
    const params = buildLearnParams("/learn docs/runbook.md and https://example.com/guide");

    const result = await handleLearnCommand(params, true);
    const instruction = (params.ctx as { BodyForAgent?: string }).BodyForAgent;

    expect(result).toEqual({ shouldContinue: true });
    expect(instruction).toContain("docs/runbook.md and https://example.com/guide");
    expect(params.command.rawBodyNormalized).toBe(instruction);
    expect(params.command.commandBodyNormalized).toBe(instruction);
  });

  it("uses the current-conversation default for bare /learn", async () => {
    const params = buildLearnParams("/learn");

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
    expect((params.ctx as { BodyForAgent?: string }).BodyForAgent).toContain(DEFAULT_LEARN_REQUEST);
  });

  it("includes the load-bearing skill authoring standards", async () => {
    const params = buildLearnParams("/learn what we just did");

    await handleLearnCommand(params, true);
    const instruction = (params.ctx as { BodyForAgent?: string }).BodyForAgent ?? "";

    expect(instruction).toContain('`skill_workshop` with action `"create"`');
    expect(instruction).toContain("ONE short generic trigger phrase in double quotes");
    expect(instruction).toContain("NEVER invent flags, commands, paths, APIs");
  });

  it("replies without continuing when the workshop is unavailable", async () => {
    const params = buildLearnParams("/learn", {
      agents: { defaults: { sandbox: { mode: "all" } } },
    });

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
    expect((params.ctx as { BodyForAgent?: string }).BodyForAgent).toBe("/learn");
  });

  it("replies without continuing when tool policy denies the workshop", async () => {
    const params = buildLearnParams("/learn", {
      tools: { deny: ["skill_workshop"] },
    });

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
  });

  it("keeps the workshop available for owner WebChat under a wildcard sender policy", async () => {
    const params = buildLearnParams("/learn", {
      tools: { toolsBySender: { "*": { deny: ["skill_workshop"] } } },
    });

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
  });

  it("keeps the wildcard sender policy for non-owner WebChat", async () => {
    const params = buildLearnParams("/learn", {
      tools: { toolsBySender: { "*": { deny: ["skill_workshop"] } } },
    });
    params.command.senderIsOwner = false;

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
  });

  it("replies without continuing when the runtime tool allowlist is empty", async () => {
    const params = buildLearnParams("/learn");
    params.opts = { toolsAllow: [] };

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
  });

  it("replies without continuing when the selected model disables tools", async () => {
    const params = buildLearnParams("/learn", {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
                compat: { supportsTools: false },
              },
            ],
          },
        },
      },
    });

    const result = await handleLearnCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Skill workshop is not available on this agent");
  });
});
