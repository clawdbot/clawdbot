import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateSystemAgentChatParams,
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupActivateParams,
  validateSystemAgentSetupActivateStartParams,
  validateSystemAgentSetupAuthStartParams,
  validateSystemAgentSetupDetectParams,
  validateSystemAgentSetupVerifyParams,
} from "../index.js";
import {
  SystemAgentChatQuestionSchema,
  SystemAgentChatHistoryResultSchema,
  SystemAgentSetupDetectResultSchema,
  SystemAgentSetupActivateResultSchema,
  SystemAgentSetupVerifyResultSchema,
} from "./openclaw.js";

describe("OpenClaw chat params protocol", () => {
  const base = { sessionId: "session-1", message: "What about this page?" };

  it("accepts the additive page context and remains backward compatible", () => {
    expect(validateSystemAgentChatParams(base)).toBe(true);
    expect(validateSystemAgentChatParams({ ...base, context: { page: "channels" } })).toBe(true);
    expect(
      validateSystemAgentChatParams({ ...base, context: { page: "/settings/channels" } }),
    ).toBe(true);
  });

  it("accepts a typed wizard answer and rejects unknown answer fields", () => {
    expect(
      validateSystemAgentChatParams({
        sessionId: "session-1",
        wizardAnswer: { stepId: "channel", value: "twitch" },
      }),
    ).toBe(true);
    expect(
      validateSystemAgentChatParams({
        sessionId: "session-1",
        wizardAnswer: { stepId: "channel", value: "twitch", display: "Twitch" },
      }),
    ).toBe(false);
  });

  it("accepts a typed wizard cancel and rejects unknown cancel fields", () => {
    expect(
      validateSystemAgentChatParams({
        sessionId: "session-1",
        wizardCancel: { stepId: "channel" },
      }),
    ).toBe(true);
    expect(
      validateSystemAgentChatParams({
        sessionId: "session-1",
        wizardCancel: { stepId: "channel", reason: "user" },
      }),
    ).toBe(false);
  });

  it("rejects unsafe page ids and unknown context fields", () => {
    expect(validateSystemAgentChatParams({ ...base, context: { page: "channels?tab=all" } })).toBe(
      false,
    );
    expect(validateSystemAgentChatParams({ ...base, context: { page: "a".repeat(65) } })).toBe(
      false,
    );
    expect(
      validateSystemAgentChatParams({
        ...base,
        context: { page: "channels", source: "client" },
      }),
    ).toBe(false);
  });
});

describe("OpenClaw chat question protocol", () => {
  const question = {
    id: "onboarding-next-step",
    header: "Next step",
    question: "What would you like to do first?",
    options: [{ label: "Talk to my agent" }, { label: "Connect a channel" }],
  };

  it("accepts the additive exit skip action and rejects unknown actions", () => {
    expect(Value.Check(SystemAgentChatQuestionSchema, question)).toBe(true);
    expect(Value.Check(SystemAgentChatQuestionSchema, { ...question, skipAction: "exit" })).toBe(
      true,
    );
    expect(Value.Check(SystemAgentChatQuestionSchema, { ...question, skipAction: "dismiss" })).toBe(
      false,
    );
  });
});

describe("OpenClaw chat history protocol", () => {
  it("accepts the default request and bounds explicit limits", () => {
    expect(validateSystemAgentChatHistoryParams({})).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 1 })).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 500 })).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 0 })).toBe(false);
    expect(validateSystemAgentChatHistoryParams({ limit: 501 })).toBe(false);
  });

  it("accepts ordered role, text, and timestamp turns only", () => {
    expect(
      Value.Check(SystemAgentChatHistoryResultSchema, {
        turns: [
          { role: "user", text: "status", at: 1 },
          { role: "assistant", text: "healthy", at: 2 },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentChatHistoryResultSchema, {
        turns: [{ role: "tool", text: "hidden", at: 1 }],
      }),
    ).toBe(false);
  });
});

describe("OpenClaw interactive activation protocol", () => {
  it("preserves optional owner-recorded rejection on the direct activation result", () => {
    const failure = { ok: false, status: "auth", error: "The candidate login failed." };
    expect(Value.Check(SystemAgentSetupActivateResultSchema, failure)).toBe(true);
    expect(
      Value.Check(SystemAgentSetupActivateResultSchema, {
        ...failure,
        disposition: "rejected-before-promotion",
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupActivateResultSchema, { ...failure, disposition: "no-mutation" }),
    ).toBe(false);
  });

  it("requires a session id and does not accept client capability acknowledgments", () => {
    const activation = { kind: "codex-cli", modelRef: "openai/gpt-5.6-luna" };
    expect(validateSystemAgentSetupActivateParams(activation)).toBe(true);
    expect(validateSystemAgentSetupActivateStartParams(activation)).toBe(false);
    expect(
      validateSystemAgentSetupActivateStartParams({ ...activation, sessionId: "activation" }),
    ).toBe(true);
    expect(
      validateSystemAgentSetupActivateStartParams({
        ...activation,
        sessionId: "activation",
        reviewToken: "client-token",
      }),
    ).toBe(false);
    expect(
      validateSystemAgentSetupActivateStartParams({
        ...activation,
        sessionId: "activation",
        acceptCapabilities: true,
      }),
    ).toBe(false);
  });
});

describe("OpenClaw setup detection protocol", () => {
  it("accepts an explicit owner across the structured setup family", () => {
    expect(validateSystemAgentSetupDetectParams({ agentId: "research" })).toBe(true);
    expect(validateSystemAgentSetupVerifyParams({ agentId: "research" })).toBe(true);
    expect(
      validateSystemAgentSetupActivateParams({
        agentId: "research",
        kind: "existing-model",
        nativeSessionCatalogsEnabled: false,
      }),
    ).toBe(true);
    expect(
      validateSystemAgentSetupAuthStartParams({
        sessionId: "setup-1",
        agentId: "research",
        authChoice: "openai-api-key",
        nativeSessionCatalogsEnabled: false,
      }),
    ).toBe(true);
    expect(validateSystemAgentSetupDetectParams({ agentId: "research", unknown: true })).toBe(
      false,
    );
  });

  it("accepts additive presentation metadata and older results without installs", () => {
    const result = {
      candidates: [
        {
          kind: "provider-auto:ollama",
          brandId: "ollama",
          label: "Ollama",
          detail: "available locally",
          modelRef: "ollama/qwen3",
          recommended: false,
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      unavailableCandidates: [
        {
          id: "gemini-cli",
          brandId: "google-gemini-cli",
          label: "Gemini CLI",
          detail: "installed; login status unavailable",
          reason: "Reconnect through OpenClaw or use a Gemini API key.",
          authOptionId: "google-gemini-cli",
          manualProviderId: "gemini-api-key",
        },
      ],
      manualProviders: [
        {
          id: "ollama",
          brandId: "ollama",
          groupLabel: "Ollama",
          label: "Ollama",
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      authOptions: [
        {
          id: "meta-api-key",
          brandId: "meta",
          label: "Meta API key",
          kind: "install",
          featured: false,
        },
        {
          id: "custom-api-key",
          brandId: "custom",
          label: "Custom OpenAI/Anthropic-compatible endpoint",
          kind: "custom",
          featured: false,
        },
      ],
      prepareOptions: [
        {
          id: "lmstudio",
          brandId: "lmstudio",
          label: "LM Studio",
          hint: "Local/self-hosted LM Studio server",
          actionLabel: "Connect server",
          icon: "https://cdn.simpleicons.org/lmstudio",
          website: "https://lmstudio.ai/download",
        },
      ],
      recommendedInstalls: [
        {
          id: "ollama",
          brandId: "ollama",
          label: "Ollama",
          hint: "Run open models locally",
          website: "https://ollama.com/download",
          icon: "https://cdn.simpleicons.org/ollama",
        },
      ],
      nativeSessionCatalogs: [
        {
          pluginId: "codex",
          label: "Discover Codex Sessions",
          detail: "List existing Codex conversations without copying them.",
        },
      ],
      nativeSessionCatalogPreferenceRequired: true,
      workspace: "/tmp/work",
      setupComplete: false,
    };

    expect(Value.Check(SystemAgentSetupDetectResultSchema, result)).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        candidates: result.candidates.map(({ brandId: _brandId, ...candidate }) => candidate),
        unavailableCandidates: result.unavailableCandidates.map(
          ({ brandId: _brandId, ...candidate }) => candidate,
        ),
        manualProviders: result.manualProviders.map(
          ({ brandId: _brandId, groupLabel: _groupLabel, ...provider }) => provider,
        ),
        prepareOptions: result.prepareOptions.map(({ brandId: _brandId, ...option }) => option),
        recommendedInstalls: result.recommendedInstalls.map(
          ({ brandId: _brandId, ...install }) => install,
        ),
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        recommendedInstalls: undefined,
        prepareOptions: undefined,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        recommendedInstalls: [{ ...result.recommendedInstalls[0], website: "http://example.test" }],
      }),
    ).toBe(false);
  });
});

describe("OpenClaw setup verification protocol", () => {
  it("accepts only an empty request", () => {
    expect(validateSystemAgentSetupVerifyParams({})).toBe(true);
    expect(validateSystemAgentSetupVerifyParams({ modelRef: "openai/gpt-5.5" })).toBe(false);
  });

  it("accepts the structured success and failure results", () => {
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
        error: "no configured model",
      }),
    ).toBe(true);
  });

  it("rejects mixed or incomplete results", () => {
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
        error: "stale failure",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "ok",
        error: "contradictory result",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
      }),
    ).toBe(false);
  });
});
