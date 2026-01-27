import { describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import { createModelSelectionState } from "./model-selection.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  ]),
}));

const defaultProvider = "openai";
const defaultModel = "gpt-4o-mini";

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  ...overrides,
});

async function resolveState(params: {
  cfg: MoltbotConfig;
  sessionEntry: ReturnType<typeof makeEntry>;
  sessionStore: Record<string, ReturnType<typeof makeEntry>>;
  sessionKey: string;
  parentSessionKey?: string;
}) {
  return createModelSelectionState({
    cfg: params.cfg,
    agentCfg: params.cfg.agents?.defaults,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
    defaultProvider,
    defaultModel,
    provider: defaultProvider,
    model: defaultModel,
    hasModelDirective: false,
  });
}

describe("createModelSelectionState parent inheritance", () => {
  it("inherits parent override from explicit parentSessionKey", async () => {
    const cfg = {} as MoltbotConfig;
    const parentKey = "agent:main:discord:channel:c1";
    const sessionKey = "agent:main:discord:channel:c1:thread:123";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionEntry = makeEntry();
    const sessionStore = {
      [parentKey]: parentEntry,
      [sessionKey]: sessionEntry,
    };

    const state = await resolveState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey: parentKey,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("derives parent key from topic session suffix", async () => {
    const cfg = {} as MoltbotConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionEntry = makeEntry();
    const sessionStore = {
      [parentKey]: parentEntry,
      [sessionKey]: sessionEntry,
    };

    const state = await resolveState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("prefers child override over parent", async () => {
    const cfg = {} as MoltbotConfig;
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    const sessionEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-5",
    });
    const sessionStore = {
      [parentKey]: parentEntry,
      [sessionKey]: sessionEntry,
    };

    const state = await resolveState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
  });

  it("ignores parent override when disallowed", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o-mini": {},
          },
        },
      },
    } as MoltbotConfig;
    const parentKey = "agent:main:slack:channel:c1";
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const parentEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-5",
    });
    const sessionEntry = makeEntry();
    const sessionStore = {
      [parentKey]: parentEntry,
      [sessionKey]: sessionEntry,
    };

    const state = await resolveState({
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
    });

    expect(state.provider).toBe(defaultProvider);
    expect(state.model).toBe(defaultModel);
  });
});
