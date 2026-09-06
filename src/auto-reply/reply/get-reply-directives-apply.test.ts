// Tests applying parsed directives to get-reply execution options.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import { applyMixedDirectives } from "./directive-handling.mixed-inline.test-helpers.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { resolveDirectiveRuntimeContext } from "./directive-runtime-context.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingController } from "./typing.js";

const mocks = vi.hoisted(() => ({
  handleDirective:
    vi.fn<
      (params: HandleDirectiveOnlyParams) => Promise<import("../types.js").ReplyPayload | undefined>
    >(),
  applyModelSelection: vi.fn(),
  systemEvent: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => mocks.systemEvent(...args),
}));

vi.mock("./directive-handling.impl.js", () => ({
  handleDirectiveOnly: (params: HandleDirectiveOnlyParams) => mocks.handleDirective(params),
}));

vi.mock("./directive-handling.persist.runtime.js", () => ({
  applySessionModelSelection: (...args: unknown[]) => mocks.applyModelSelection(...args),
}));

beforeEach(() => {
  mocks.handleDirective.mockReset();
  mocks.applyModelSelection.mockReset();
  mocks.systemEvent.mockReset();
});

describe("applyInlineDirectiveOverrides", () => {
  it("returns the elevated denial for a prepared global owner", async () => {
    const ctx = buildTestCtx({
      Body: "/elevated on",
      CommandBody: "/elevated on",
      CommandAuthorized: true,
      SessionKey: "global",
      Provider: "webchat",
      Surface: "webchat",
    });
    const sessionEntry = { sessionId: "global-session", updatedAt: 1 };
    const runState: ReplyOperationRunState = {};
    const opts = { [REPLY_OPERATION_RUN_STATE]: runState, suppressTyping: true };
    const result = await resolveReplyDirectives({
      ctx,
      cfg: {
        agents: { ownership: "explicit", entries: { target: {}, other: {} } },
        tools: { elevated: { enabled: false } },
      },
      agentId: "target",
      agentDir: "/tmp/target-agent",
      workspaceDir: "/tmp/workspace",
      agentCfg: {},
      sessionCtx: ctx,
      sessionEntry,
      sessionStore: {},
      sessionKey: "global",
      sessionScope: "global",
      conversation: prepareReplyConversation({ ctx, sessionEntry }),
      isGroup: false,
      triggerBodyNormalized: "/elevated on",
      resetTriggered: false,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      hasResolvedHeartbeatModelOverride: false,
      typing: createTypingController({}),
      opts,
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: expect.stringContaining("elevated is not available") },
    });
    expect(runState.preRunRejection).toBe("session-directive-rejected");
    expect(mocks.handleDirective).not.toHaveBeenCalled();
  });

  it("keeps the prepared global owner through directive application and context budgeting", async () => {
    const { result } = await applyMixedDirectives({
      body: "hello /verbose on",
      cfg: { agents: { ownership: "explicit", entries: { main: {}, other: {} } } },
      sessionKey: "global",
    });

    expect(result.kind).toBe("continue");
    expect(mocks.handleDirective).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("uses the prepared global owner for directive runtime policy", () => {
    const params = {
      cfg: {
        session: { scope: "global" as const },
        agents: { ownership: "explicit" as const, entries: { target: {}, other: {} } },
      },
      agentId: "target",
      sessionKey: "global",
      ctx: buildTestCtx({
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "sender",
        AccountId: "default",
      }),
    };

    const result = resolveDirectiveRuntimeContext(params);

    expect(result.activeAgentId).toBe("target");
    expect(result.runtimePolicySessionKey).toBe("agent:target:telegram:default:direct:sender");
  });

  it("keeps the active agent when an independent directive policy belongs to another agent", () => {
    const result = resolveDirectiveRuntimeContext({
      cfg: {
        agents: {
          ownership: "explicit",
          entries: {
            target: { sandbox: { mode: "off" } },
            main: { sandbox: { mode: "all" } },
          },
        },
      },
      agentId: "target",
      sessionKey: "agent:target:main",
      ctx: buildTestCtx({ RuntimePolicySessionKey: "agent:main:group" }),
    });

    expect(result.activeAgentId).toBe("target");
    expect(result.runtimePolicySessionKey).toBe("agent:main:group");
    expect(result.runtimeIsSandboxed).toBe(true);
  });

  it.each([
    {
      rejectedRef: "ollama/Gemma4-26b-a4-it-gguf",
      reason: "disallowed" as const,
      modelPolicyConfigPath: undefined,
      modelPolicyRepairConfigPath: undefined,
      expected:
        "Model override ollama/Gemma4-26b-a4-it-gguf is not allowed for this agent by modelPolicy.allow; reverted to openai/gpt-5.5. Add ollama/Gemma4-26b-a4-it-gguf to modelPolicy.allow or pick an allowed model with /model list.",
    },
    {
      rejectedRef: undefined,
      reason: "disallowed" as const,
      modelPolicyConfigPath: undefined,
      modelPolicyRepairConfigPath: undefined,
      expected: "Model override not allowed for this agent; reverted to openai/gpt-5.5.",
    },
    {
      rejectedRef: "openai/gpt-4o",
      reason: "stale" as const,
      modelPolicyConfigPath: undefined,
      modelPolicyRepairConfigPath: undefined,
      expected:
        "Stored model override openai/gpt-4o is stale for this session; reverted to openai/gpt-5.5. Pick a model again with /model if you still want to override the default.",
    },
    {
      rejectedRef: "external/sensitive",
      reason: "disallowed" as const,
      modelPolicyConfigPath: "agents.defaults.models",
      modelPolicyRepairConfigPath: "agents.defaults.modelPolicy.allow",
      expected:
        "Model override external/sensitive is not allowed for this agent by agents.defaults.models; reverted to openai/gpt-5.5. Add external/sensitive to agents.defaults.modelPolicy.allow or pick an allowed model with /model list.",
    },
  ])(
    "emits the $reason reset event before rejecting a locked mixed directive",
    async ({
      rejectedRef,
      reason,
      modelPolicyConfigPath,
      modelPolicyRepairConfigPath,
      expected,
    }) => {
      const directives = parseInlineSessionDirectives(
        "hello /model openai/gpt-5.4 --runtime openclaw",
      );
      const typing = createMockTypingController();
      const sessionEntry = {
        sessionId: "session-1",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        modelSelectionLocked: true,
      };
      const modelState = createModelSelectionStateFixture({
        agentCfg: {},
        provider: "openai",
        model: "gpt-5.5",
      });
      Object.assign(modelState, {
        resetModelOverride: true,
        resetModelOverrideRef: rejectedRef,
        resetModelOverrideReason: reason,
        modelPolicyConfigPath,
        modelPolicyRepairConfigPath,
      });

      const result = await applyInlineDirectiveOverrides({
        ctx: buildTestCtx({
          Body: "hello /model openai/gpt-5.4 --runtime openclaw",
          CommandAuthorized: true,
        }),
        cfg: {},
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        agentCfg: {},
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        sessionKey: "agent:main:main",
        sessionScope: undefined,
        isGroup: false,
        allowTextCommands: true,
        command: {
          surface: "webchat",
          channel: "webchat",
          ownerList: [],
          senderIsOwner: true,
          isAuthorizedSender: true,
          rawBodyNormalized: "hello /model openai/gpt-5.4 --runtime openclaw",
          commandBodyNormalized: "hello /model openai/gpt-5.4 --runtime openclaw",
        },
        directives,
        messageProviderKey: "webchat",
        elevatedEnabled: true,
        elevatedAllowed: true,
        elevatedFailures: [],
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        aliasIndex: { byAlias: new Map(), byKey: new Map() },
        provider: "openai",
        model: "gpt-5.5",
        modelState,
        initialModelLabel: "openai/gpt-5.5",
        formatModelSwitchEvent: (label) => label,
        resolvedElevatedLevel: "off",
        defaultActivation: () => "always",
        contextTokens: 8192,
        effectiveModelDirective: directives.rawModelDirective,
        typing,
      });

      expect(result).toEqual({
        kind: "reply",
        reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
        preRunRejection: "model-selection-locked",
      });
      expect(typing.cleanup).toHaveBeenCalledOnce();
      expect(mocks.handleDirective).not.toHaveBeenCalled();
      expect(mocks.applyModelSelection).not.toHaveBeenCalled();
      expect(mocks.systemEvent).toHaveBeenCalledWith(expected, {
        sessionKey: "agent:main:main",
        contextKey: "model:reset:openai/gpt-5.5",
      });
      expect(sessionEntry).toEqual({
        sessionId: "session-1",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        modelSelectionLocked: true,
      });
    },
  );

  it.each([
    {
      reason: "its single directive transaction loses",
      body: "hello /elevated full",
      errorText: "Session settings were not applied because the session changed. Retry.",
      model: "gpt-5.5",
      contextTokens: 8192,
      resolvedElevatedLevel: "full" as const,
    },
    {
      reason: "its transaction rejects unsupported thinking",
      body: "/think ultra please solve",
      errorText:
        'Thinking level "ultra" is not supported for openai/gpt-5.6-luna. Use one of: off, low, medium, high, max.',
      model: "gpt-5.6-luna",
      contextTokens: 372_000,
      resolvedElevatedLevel: "off" as const,
    },
  ])(
    "stops a mixed inline turn when $reason",
    async ({ body, errorText, model, contextTokens, resolvedElevatedLevel }) => {
      const directives = parseInlineSessionDirectives(body);
      mocks.handleDirective.mockImplementation(async (params) => {
        if (!params.persistenceState) {
          throw new Error("Expected a mixed-message transaction");
        }
        params.persistenceState.outcome = { kind: "rejected", errorText };
        params.onRejection?.();
        return { text: errorText };
      });
      const typing = createMockTypingController();
      const sessionEntry = { sessionId: "session-1", updatedAt: 1 };

      const result = await applyInlineDirectiveOverrides({
        ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
        cfg: {},
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        agentCfg: {},
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        sessionKey: "agent:main:main",
        sessionScope: undefined,
        isGroup: false,
        allowTextCommands: true,
        command: {
          surface: "webchat",
          channel: "webchat",
          ownerList: [],
          senderIsOwner: true,
          isAuthorizedSender: true,
          rawBodyNormalized: body,
          commandBodyNormalized: body,
        },
        directives,
        messageProviderKey: "webchat",
        elevatedEnabled: true,
        elevatedAllowed: true,
        elevatedFailures: [],
        defaultProvider: "openai",
        defaultModel: model,
        aliasIndex: { byAlias: new Map(), byKey: new Map() },
        provider: "openai",
        model,
        modelState: createModelSelectionStateFixture({
          agentCfg: {},
          provider: "openai",
          model,
        }),
        initialModelLabel: `openai/${model}`,
        formatModelSwitchEvent: (label) => label,
        resolvedElevatedLevel,
        defaultActivation: () => "always",
        contextTokens,
        typing,
      });

      expect(result).toEqual({
        kind: "reply",
        reply: { text: errorText, isError: true },
        preRunRejection: "session-directive-rejected",
      });
      expect(typing.cleanup).toHaveBeenCalledOnce();
      expect(mocks.handleDirective).toHaveBeenCalledOnce();
    },
  );

  it("rejects unexpected native model arguments before model selection", async () => {
    const body = "/model openai/gpt-5.5 extra";
    const directives = parseInlineSessionDirectives(body, {
      command: { kind: "native", name: "model" },
    });
    const { result, typing } = await applyMixedDirectives({
      body,
      directives,
      provider: "openai",
      model: "gpt-5.5",
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: 'Unexpected argument "extra" for /model.' },
      preRunRejection: "session-directive-rejected",
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(mocks.applyModelSelection).not.toHaveBeenCalled();
    expect(mocks.handleDirective).not.toHaveBeenCalled();
  });
});
