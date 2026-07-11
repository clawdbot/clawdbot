// Tests applying parsed directives to get-reply execution options.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import {
  applyInlineDirectiveOverrides,
  formatModelOverrideResetEvent,
} from "./get-reply-directives-apply.js";
import { createFastTestModelSelectionState } from "./model-selection.js";
import { buildTestCtx } from "./test-ctx.js";

const mocks = vi.hoisted(() => ({
  fastLane: vi.fn(),
  persist: vi.fn(),
}));

vi.mock("./directive-handling.fast-lane.js", () => ({
  applyInlineDirectivesFastLane: (...args: unknown[]) => mocks.fastLane(...args),
}));

vi.mock("./directive-handling.persist.runtime.js", () => ({
  persistInlineDirectives: (...args: unknown[]) => mocks.persist(...args),
}));

beforeEach(() => {
  mocks.fastLane.mockReset();
  mocks.persist.mockReset();
});

describe("formatModelOverrideResetEvent", () => {
  it("names the rejected model override and allowlist recovery path", () => {
    expect(
      formatModelOverrideResetEvent({
        rejectedRef: "ollama/Gemma4-26b-a4-it-gguf",
        initialModelLabel: "github-copilot/gpt-4o",
      }),
    ).toBe(
      "Model override ollama/Gemma4-26b-a4-it-gguf is not allowed for this agent; reverted to github-copilot/gpt-4o. Add ollama/Gemma4-26b-a4-it-gguf to agents.defaults.models or pick an allowed model with /model list.",
    );
  });

  it("keeps the legacy generic message when the rejected ref is unknown", () => {
    expect(
      formatModelOverrideResetEvent({
        initialModelLabel: "github-copilot/gpt-4o",
      }),
    ).toBe("Model override not allowed for this agent; reverted to github-copilot/gpt-4o.");
  });

  it("does not tell users to edit the allowlist for stale session overrides", () => {
    expect(
      formatModelOverrideResetEvent({
        rejectedRef: "openai/gpt-5.5",
        initialModelLabel: "openai/gpt-5.4",
        reason: "stale",
      }),
    ).toBe(
      "Stored model override openai/gpt-5.5 is stale for this session; reverted to openai/gpt-5.4. Pick a model again with /model if you still want to override the default.",
    );
  });
});

describe("applyInlineDirectiveOverrides", () => {
  it("rejects a mixed inline model and runtime change when model selection is locked", async () => {
    const directives = parseInlineDirectives("hello /model openai/gpt-5.4 --runtime openclaw");
    const typing = {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: vi.fn(),
    };
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelSelectionLocked: true,
    };

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
      modelState: createFastTestModelSelectionState({
        agentCfg: {},
        provider: "openai",
        model: "gpt-5.5",
      }),
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
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(mocks.fastLane).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(sessionEntry).toEqual({
      sessionId: "session-1",
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelSelectionLocked: true,
    });
  });

  it("stops a mixed inline turn when final directive persistence loses", async () => {
    const directives = parseInlineDirectives("hello /elevated full");
    mocks.fastLane.mockResolvedValue({
      directiveAck: { text: "Elevated FULL enabled." },
      provider: "openai",
      model: "gpt-5.5",
      sessionChangesApplied: true,
    });
    mocks.persist.mockResolvedValue({
      provider: "openai",
      model: "gpt-5.5",
      contextTokens: 8192,
      sessionChangesApplied: false,
    });
    const typing = {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: vi.fn(),
    };
    const sessionEntry = { sessionId: "session-1", updatedAt: 1 };

    const result = await applyInlineDirectiveOverrides({
      ctx: buildTestCtx({ Body: "hello /elevated full", CommandAuthorized: true }),
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
        rawBodyNormalized: "hello /elevated full",
        commandBodyNormalized: "hello /elevated full",
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
      modelState: createFastTestModelSelectionState({
        agentCfg: {},
        provider: "openai",
        model: "gpt-5.5",
      }),
      initialModelLabel: "openai/gpt-5.5",
      formatModelSwitchEvent: (label) => label,
      resolvedElevatedLevel: "full",
      defaultActivation: () => "always",
      contextTokens: 8192,
      typing,
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "Session settings were not applied because the session changed. Retry." },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
  });

  it("stops a mixed inline turn when final thinking validation fails", async () => {
    const errorText =
      'Thinking level "ultra" is not supported for openai/gpt-5.6-luna. Use one of: off, low, medium, high, max.';
    const directives = parseInlineDirectives("/think ultra please solve");
    mocks.fastLane.mockResolvedValue({
      directiveAck: { text: errorText },
      provider: "openai",
      model: "gpt-5.6-luna",
      sessionChangesApplied: true,
    });
    mocks.persist.mockResolvedValue({
      provider: "openai",
      model: "gpt-5.6-luna",
      contextTokens: 372_000,
      sessionChangesApplied: true,
      errorText,
    });
    const typing = {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: vi.fn(),
    };
    const sessionEntry = { sessionId: "session-1", updatedAt: 1 };

    const result = await applyInlineDirectiveOverrides({
      ctx: buildTestCtx({ Body: "/think ultra please solve", CommandAuthorized: true }),
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
        rawBodyNormalized: "/think ultra please solve",
        commandBodyNormalized: "/think ultra please solve",
      },
      directives,
      messageProviderKey: "webchat",
      elevatedEnabled: true,
      elevatedAllowed: true,
      elevatedFailures: [],
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-luna",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      provider: "openai",
      model: "gpt-5.6-luna",
      modelState: createFastTestModelSelectionState({
        agentCfg: {},
        provider: "openai",
        model: "gpt-5.6-luna",
      }),
      initialModelLabel: "openai/gpt-5.6-luna",
      formatModelSwitchEvent: (label) => label,
      resolvedElevatedLevel: "off",
      defaultActivation: () => "always",
      contextTokens: 372_000,
      typing,
    });

    expect(result).toEqual({ kind: "reply", reply: { text: errorText } });
    expect(typing.cleanup).toHaveBeenCalledOnce();
  });
});
