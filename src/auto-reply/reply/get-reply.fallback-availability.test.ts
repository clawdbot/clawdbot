// Proves fallback availability survives the shipped reply entry into run preparation.
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import type { FollowupRun } from "./queue.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  preparedRunParams: vi.fn(),
}));

registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

const config: OpenClawConfig = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.4",
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      },
    },
    list: [{ id: "main" }],
  },
};

function prepareSession(sessionEntry: SessionEntry) {
  const sessionKey = "agent:main:telegram:123";
  const storePath = path.join(tempDirs.make("get-reply-fallback-availability"), "sessions.json");
  replaceSessionEntrySync({ sessionKey, storePath }, sessionEntry);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(sessionEntry);
  mocks.initSessionState.mockResolvedValueOnce(
    createGetReplySessionState({
      sessionCtx: {
        agentText: "hello",
        BodyForAgent: "hello",
        Provider: "telegram",
        SessionKey: sessionKey,
      },
      sessionEntry,
      sessionKey,
      sessionStore: { [sessionKey]: sessionEntry },
      storePath,
    }),
  );
  mocks.resolveReplyDirectives.mockResolvedValueOnce(
    createGetReplyContinueDirectivesResult({
      body: "hello",
      abortKey: sessionKey,
      from: "telegram:user:42",
      to: "telegram:123",
      senderId: "telegram:user:42",
      commandSource: "message",
      senderIsOwner: true,
      resetHookTriggered: false,
      provider: "openai",
      model: "gpt-5.4",
    }),
  );
  mocks.handleInlineActions.mockResolvedValueOnce({
    kind: "continue",
    directives: {},
    cleanedBody: "hello",
    abortedLastRun: false,
  });
}

function resolvePreparedFallbackOptions(params: Parameters<typeof runPreparedReplyMock>[0]) {
  const sessionEntry = params.sessionEntry;
  const run = {
    agentId: params.agentId,
    agentDir: params.agentDir,
    sessionId: params.sessionId ?? "session-1",
    sessionKey: params.sessionKey,
    sessionFile: params.sessionKey,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    provider: params.provider,
    model: params.model,
    timeoutMs: params.timeoutMs,
    blockReplyBreak: params.resolvedBlockStreamingBreak,
    modelSelectionLocked: sessionEntry?.modelSelectionLocked,
    hasSessionModelOverride: Boolean(sessionEntry?.modelOverride || sessionEntry?.providerOverride),
    modelOverrideSource: sessionEntry?.modelOverrideSource,
  } satisfies FollowupRun["run"];
  return resolveModelFallbackOptions(run);
}

describe("getReplyFromConfig fallback availability", () => {
  beforeAll(async () => {
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
    ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.preparedRunParams.mockReset();
    vi.mocked(runPreparedReplyMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockImplementation(async (params) => {
      mocks.preparedRunParams(resolvePreparedFallbackOptions(params));
      return { text: "ok" };
    });
  });

  it("prepares a user pin as disabled and an automatic route as active", async () => {
    const sessionKey = "agent:main:telegram:123";
    prepareSession({
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
    });

    await expect(
      getReplyFromConfig(buildGetReplyCtx({ SessionKey: sessionKey }), undefined, config),
    ).resolves.toEqual({ text: "ok" });
    expect(mocks.preparedRunParams).toHaveBeenCalledOnce();
    expect(mocks.preparedRunParams.mock.calls[0]?.[0]).toMatchObject({
      modelFallbackAvailability: { kind: "disabled_by_model_override" },
    });

    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.preparedRunParams.mockReset();
    prepareSession({ sessionId: "session-1", updatedAt: Date.now() });

    await expect(
      getReplyFromConfig(buildGetReplyCtx({ SessionKey: sessionKey }), undefined, config),
    ).resolves.toEqual({ text: "ok" });
    expect(mocks.preparedRunParams).toHaveBeenCalledOnce();
    expect(mocks.preparedRunParams.mock.calls[0]?.[0]).toMatchObject({
      modelFallbackAvailability: {
        kind: "active",
        models: ["anthropic/claude-sonnet-4-6"],
      },
    });
  });
});
