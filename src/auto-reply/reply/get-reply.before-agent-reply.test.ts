import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function createContinueDirectivesResult() {
  return createGetReplyContinueDirectivesResult({
    body: "hello world",
    abortKey: "agent:main:telegram:-100123",
    from: "telegram:user:42",
    to: "telegram:-100123",
    senderId: "42",
    commandSource: "text",
    senderIsOwner: false,
    resetHookTriggered: false,
  });
}

describe("getReplyFromConfig before_agent_reply wiring", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.hasHooks.mockReset();
    mocks.runBeforeAgentReply.mockReset();

    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildGetReplyGroupCtx({ OriginatingChannel: "Telegram", Provider: "telegram" }),
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
    });
    mocks.hasHooks.mockImplementation((hookName) => hookName === "before_agent_reply");
  });

  it("returns a plugin reply and invokes the hook after inline actions", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "plugin reply" },
    });

    const result = await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    expect(result).toEqual({ text: "plugin reply" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledWith(
      { cleanedBody: "hello world" },
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:telegram:-100123",
        sessionId: "session-1",
        workspaceDir: "/tmp/workspace",
        messageProvider: "telegram",
        trigger: "user",
        channelId: "telegram",
      }),
    );
    expect(mocks.handleInlineActions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runBeforeAgentReply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("falls back to NO_REPLY when the hook claims without a reply payload", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: true });

    const result = await getReplyFromConfig(buildGetReplyGroupCtx(), undefined, {});

    expect(result).toEqual({ text: SILENT_REPLY_TOKEN });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
