// Tests before-agent-reply hooks in the get-reply pipeline.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DETERMINISTIC_GATEWAY_REPLY } from "../../agents/deterministic-gateway-model.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildGetReplyGroupCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeAgentReply: vi.fn<HookRunner["runBeforeAgentReply"]>(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: mocks.hasHooks,
      runBeforeAgentReply: mocks.runBeforeAgentReply,
    }) as unknown as HookRunner,
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
}

function createContinueDirectivesResult(overrides: { provider?: string; model?: string } = {}) {
  return createGetReplyContinueDirectivesResult({
    body: "hello world",
    abortKey: "agent:main:telegram:-100123",
    from: "telegram:user:42",
    to: "telegram:-100123",
    senderId: "42",
    commandSource: "text",
    senderIsOwner: false,
    resetHookTriggered: false,
    ...overrides,
  });
}

describe("getReplyFromConfig before_agent_reply wiring", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.hasHooks.mockReset();
    mocks.runBeforeAgentReply.mockReset();

    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildGetReplyGroupCtx({
          OriginatingChannel: "Telegram",
          Provider: "telegram",
          SenderId: "42",
          ChatId: "-100123-native",
        }),
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
        triggerBodyNormalized: "hello world",
        bodyStripped: "hello world",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
      cleanedBody: "hello world",
    });
    mocks.hasHooks.mockImplementation((hookName) => hookName === "before_agent_reply");
  });

  it("returns a plugin reply and invokes the hook after inline actions", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "plugin reply" },
    });

    const result = await getReplyFromConfig(
      buildGetReplyGroupCtx({ SenderId: "telegram-user-42" }),
      undefined,
      {},
    );

    expect(result).toEqual({ text: "plugin reply" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    const [[body, hookCtx]] = mocks.runBeforeAgentReply.mock.calls as unknown as Array<
      [
        { cleanedBody?: string },
        {
          agentId?: string;
          sessionKey?: string;
          sessionId?: string;
          workspaceDir?: string;
          modelProviderId?: string;
          modelId?: string;
          messageProvider?: string;
          trigger?: string;
          channelId?: string;
          senderId?: string;
          chatId?: string;
          channel?: string;
          channelContext?: {
            sender?: { id?: string };
            chat?: { id?: string };
          };
        },
      ]
    >;
    expect(body.cleanedBody).toBe("hello world");
    expect(hookCtx.agentId).toBe("main");
    expect(hookCtx.sessionKey).toBe("agent:main:telegram:-100123");
    expect(hookCtx.sessionId).toBe("session-1");
    expect(hookCtx.workspaceDir).toBe("/tmp/workspace");
    expect(hookCtx.modelProviderId).toBeTruthy();
    expect(hookCtx.modelId).toBeTruthy();
    expect(hookCtx.messageProvider).toBe("telegram");
    expect(hookCtx.trigger).toBe("user");
    expect(hookCtx.channel).toBe("telegram");
    expect(hookCtx.channelId).toBe("-100123");
    expect(hookCtx.senderId).toBe("42");
    expect(hookCtx.chatId).toBe("-100123-native");
    expect(hookCtx.channelContext?.sender?.id).toBe("42");
    expect(hookCtx.channelContext?.chat?.id).toBe("-100123-native");
    expect(mocks.handleInlineActions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runBeforeAgentReply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("falls back to NO_REPLY when the hook claims without a reply payload", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: true });

    const result = await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    expect(result).toEqual({ text: SILENT_REPLY_TOKEN });
  });

  it("returns a deterministic reply instead of running the agent harness", async () => {
    mocks.resolveReplyDirectives.mockResolvedValue(
      createContinueDirectivesResult({ provider: "dummy", model: "dummy" }),
    );
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: false });

    const result = await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    expect(result).toEqual({ text: DETERMINISTIC_GATEWAY_REPLY });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledTimes(1);
  });

  it("passes the deterministic NOTE model to plugin hooks", async () => {
    mocks.resolveReplyDirectives.mockResolvedValue(
      createContinueDirectivesResult({ provider: "dummy", model: "note" }),
    );
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: true, reply: { text: "saved" } });

    const result = await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    expect(result).toEqual({ text: "saved" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelProviderId: "dummy", modelId: "note" }),
    );
  });

  it("passes inbound media and location data to plugin hooks", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: true, reply: { text: "saved" } });
    const ctx = buildGetReplyGroupCtx({
      BodyForCommands: "photo caption",
      MediaPaths: ["/tmp/photo.jpg"],
      MediaTypes: ["image/jpeg"],
      MediaWorkspaceDir: "/tmp/workspace",
      LocationLat: 48.2,
      LocationLon: 16.37,
      LocationName: "Vienna",
    });

    await getReplyFromConfig(ctx, undefined, {});

    expect(mocks.runBeforeAgentReply).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: "photo caption",
        mediaPaths: ["/tmp/photo.jpg"],
        mediaTypes: ["image/jpeg"],
        mediaWorkspaceDir: "/tmp/workspace",
        location: expect.objectContaining({ latitude: 48.2, longitude: 16.37, name: "Vienna" }),
      }),
      expect.anything(),
    );
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
