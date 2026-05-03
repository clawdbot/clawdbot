import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";

const {
  loadModelCatalogMock,
  getModelRefStatusMock,
  normalizeModelSelectionMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveHooksGmailModelMock,
} = vi.hoisted(() => ({
  loadModelCatalogMock: vi.fn(),
  getModelRefStatusMock: vi.fn(),
  normalizeModelSelectionMock: vi.fn((value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { primary?: unknown }).primary === "string" &&
      (value as { primary: string }).primary.trim()
    ) {
      return (value as { primary: string }).primary.trim();
    }
    return undefined;
  }),
  resolveAllowedModelRefMock: vi.fn(),
  resolveConfiguredModelRefMock: vi.fn(),
  resolveHooksGmailModelMock: vi.fn(),
}));

vi.mock("./isolated-agent/run-model-selection.runtime.js", () => ({
  DEFAULT_MODEL: "claude-opus-4-6",
  DEFAULT_PROVIDER: "anthropic",
  getModelRefStatus: getModelRefStatusMock,
  loadModelCatalog: loadModelCatalogMock,
  normalizeModelSelection: normalizeModelSelectionMock,
  resolveAllowedModelRef: resolveAllowedModelRefMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
}));

import { resolveCronModelSelection } from "./isolated-agent/model-selection.js";

const DEFAULT_MESSAGE = "do it";

type AgentTurnPayload = {
  kind: "agentTurn";
  message: string;
  model?: string;
};

type SelectModelOptions = {
  cfg?: Record<string, unknown>;
  agentConfigOverride?: {
    model?: unknown;
    subagents?: {
      model?: unknown;
    };
  };
  payload?: AgentTurnPayload;
  sessionEntry?: {
    modelOverride?: string;
    providerOverride?: string;
  };
  isGmailHook?: boolean;
  agentId?: string;
};

function parseModelRef(raw: string): { provider: string; model: string } | { error: string } {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { error: "invalid model" };
  }

  const providerRaw = trimmed.slice(0, slash).trim().toLowerCase();
  const modelRaw = trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return { error: "invalid model" };
  }

  const provider = providerRaw === "bedrock" ? "amazon-bedrock" : providerRaw;
  const model = provider === "anthropic" && modelRaw === "opus-4.5" ? "claude-opus-4-5" : modelRaw;
  return { provider, model };
}

function resolveConfiguredModelForTest(cfg: Record<string, unknown>): {
  provider: string;
  model: string;
} {
  const modelValue = (cfg.agents as { defaults?: { model?: unknown } } | undefined)?.defaults
    ?.model;
  const rawModel =
    typeof modelValue === "string"
      ? modelValue
      : typeof modelValue === "object" &&
          modelValue &&
          typeof (modelValue as { primary?: unknown }).primary === "string"
        ? (modelValue as { primary: string }).primary
        : undefined;

  if (typeof rawModel === "string") {
    const parsed = parseModelRef(rawModel);
    if (!("error" in parsed)) {
      return parsed;
    }
  }

  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

function defaultPayload(): AgentTurnPayload {
  return {
    kind: "agentTurn",
    message: DEFAULT_MESSAGE,
  };
}

async function selectModel(options: SelectModelOptions = {}) {
  const cfg = options.cfg ?? {};
  return resolveCronModelSelection({
    cfg: cfg as never,
    cfgWithAgentDefaults: cfg as never,
    agentConfigOverride: options.agentConfigOverride,
    sessionEntry: options.sessionEntry ?? {},
    payload: options.payload ?? defaultPayload(),
    isGmailHook: options.isGmailHook ?? false,
    agentId: options.agentId,
  });
}

async function expectSelectedModel(
  options: SelectModelOptions,
  expected: { provider: string; model: string },
) {
  const result = await selectModel(options);
  expect(result).toEqual({ ok: true, ...expected });
}

async function expectDefaultSelectedModel(options: SelectModelOptions = {}) {
  await expectSelectedModel(options, { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL });
}

describe("cron model formatting and precedence edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadModelCatalogMock.mockResolvedValue([]);
    getModelRefStatusMock.mockReturnValue({ allowed: false });
    resolveHooksGmailModelMock.mockReturnValue(null);
    resolveConfiguredModelRefMock.mockImplementation(({ cfg }: { cfg?: Record<string, unknown> }) =>
      resolveConfiguredModelForTest(cfg ?? {}),
    );
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const parsed = parseModelRef(raw);
      return "error" in parsed ? parsed : { ref: parsed };
    });
  });

  describe("parseModelRef formatting", () => {
    it("splits standard provider/model", async () => {
      await expectSelectedModel(
        {
          payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "openai/gpt-4.1-mini" },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
    });

    it("handles leading/trailing whitespace in model string", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "  openai/gpt-4.1-mini  ",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
    });

    it("handles openrouter nested provider paths", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openrouter/meta-llama/llama-3.3-70b:free",
          },
        },
        { provider: "openrouter", model: "meta-llama/llama-3.3-70b:free" },
      );
    });

    it("rejects model with trailing slash (empty model name)", async () => {
      await expect(
        selectModel({
          payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "openai/" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: "cron payload.model 'openai/' rejected: invalid model",
      });
    });

    it("rejects model with leading slash (empty provider)", async () => {
      await expect(
        selectModel({
          payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "/gpt-4.1-mini" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: "cron payload.model '/gpt-4.1-mini' rejected: invalid model",
      });
    });

    it("reports the cron allowlist path when payload.model is not allowed", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        error: "model not allowed: anthropic/claude-sonnet-4-6",
      });

      await expect(
        selectModel({
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/claude-sonnet-4-6",
          },
        }),
      ).resolves.toEqual({
        ok: false,
        error:
          "cron payload.model 'anthropic/claude-sonnet-4-6' rejected by agents.defaults.models allowlist: anthropic/claude-sonnet-4-6",
      });
    });

    it("normalizes provider casing", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "OpenAI/gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
    });

    it("normalizes anthropic model aliases", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/opus-4.5",
          },
        },
        { provider: "anthropic", model: "claude-opus-4-5" },
      );
    });

    it("normalizes bedrock provider alias", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "bedrock/claude-sonnet-4-6",
          },
        },
        { provider: "amazon-bedrock", model: "claude-sonnet-4-6" },
      );
    });
  });

  describe("model precedence isolation", () => {
    it("job payload model overrides default (anthropic -> openai)", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
    });

    it("session override applies when no job payload model is present", async () => {
      await expectSelectedModel(
        {
          sessionEntry: {
            providerOverride: "openai",
            modelOverride: "gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
    });

    it("job payload model wins over conflicting session override", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/claude-sonnet-4-6",
          },
          sessionEntry: {
            providerOverride: "openai",
            modelOverride: "gpt-4.1-mini",
          },
        },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
      );
    });

    it("falls through to default when no override is present", async () => {
      await expectDefaultSelectedModel();
    });

    it("does not treat another chat session /model override as a global cron default", async () => {
      const chatSessionAfterModelDirective = {
        providerOverride: "openai",
        modelOverride: "gpt-4.1-mini",
      };

      await expectSelectedModel(
        { sessionEntry: chatSessionAfterModelDirective },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
      await expectDefaultSelectedModel({ sessionEntry: {} });
      await expectSelectedModel(
        {
          sessionEntry: {},
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/claude-sonnet-4-6",
          },
        },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
      );
    });
  });

  describe("sequential model switches (CI failure regression)", () => {
    it("openai override -> session openai -> job anthropic: each step resolves correctly", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );

      await expectSelectedModel(
        {
          sessionEntry: {
            providerOverride: "openai",
            modelOverride: "gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );

      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/claude-opus-4-6",
          },
          sessionEntry: {
            providerOverride: "openai",
            modelOverride: "gpt-4.1-mini",
          },
        },
        { provider: "anthropic", model: "claude-opus-4-6" },
      );
    });

    it("provider does not leak between isolated sequential runs", async () => {
      await expectSelectedModel(
        {
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );

      await expectDefaultSelectedModel();
    });
  });

  describe("CLI runtime compatibility", () => {
    it("keeps the canonical Anthropic provider when a per-agent Claude CLI runtime is configured", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-opus-4-6",
              },
              list: [
                {
                  id: "scheduler",
                  agentRuntime: { id: "claude-cli" },
                },
              ],
            },
          },
          agentId: "scheduler",
        },
        { provider: "anthropic", model: "claude-opus-4-6" },
      );
    });

    it("keeps an OpenAI payload override on OpenAI when per-agent Claude CLI is configured", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-opus-4-6",
              },
              list: [
                {
                  id: "scheduler",
                  agentRuntime: { id: "claude-cli" },
                },
              ],
            },
          },
          agentId: "scheduler",
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
    });

    it("keeps the canonical Anthropic provider when a default Claude CLI runtime is configured", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-opus-4-6",
                agentRuntime: { id: "claude-cli" },
              },
            },
          },
        },
        { provider: "anthropic", model: "claude-opus-4-6" },
      );
    });

    it("keeps an OpenAI payload override on OpenAI when default Claude CLI is configured", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-opus-4-6",
                agentRuntime: { id: "claude-cli" },
              },
            },
          },
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
    });
  });

  describe("stored session overrides", () => {
    it("stored modelOverride/providerOverride are applied", async () => {
      await expectSelectedModel(
        {
          sessionEntry: {
            providerOverride: "openai",
            modelOverride: "gpt-4.1-mini",
          },
        },
        { provider: "openai", model: "gpt-4.1-mini" },
      );
    });

    it("default remains when store has no override", async () => {
      await expectDefaultSelectedModel({ sessionEntry: {} });
    });
  });

  describe("whitespace and empty model strings", () => {
    it("whitespace-only model treated as unset (falls to default)", async () => {
      await expectDefaultSelectedModel({
        payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "   " },
      });
    });

    it("empty string model treated as unset", async () => {
      await expectDefaultSelectedModel({
        payload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "" },
      });
    });

    it("whitespace-only session modelOverride is ignored", async () => {
      await expectDefaultSelectedModel({
        sessionEntry: {
          providerOverride: "openai",
          modelOverride: "   ",
        },
      });
    });
  });

  describe("config model format variations", () => {
    it("default model as string 'provider/model'", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "openai/gpt-4.1",
              },
            },
          },
        },
        { provider: "openai", model: "gpt-4.1" },
      );
    });

    it("default model as object with primary field", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: { primary: "openai/gpt-4.1" },
              },
            },
          },
        },
        { provider: "openai", model: "gpt-4.1" },
      );
    });

    it("job override switches away from object default", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: { primary: "openai/gpt-4.1" },
              },
            },
          },
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "anthropic/claude-sonnet-4-6",
          },
        },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
      );
    });

    it("uses agents.defaults.subagents.model when set", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
                subagents: { model: "ollama/llama3.2:3b" },
              },
            },
          },
        },
        { provider: "ollama", model: "llama3.2:3b" },
      );
    });

    it("supports subagents.model with {primary} object format", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
                subagents: { model: { primary: "google/gemini-2.5-flash" } },
              },
            },
          },
        },
        { provider: "google", model: "gemini-2.5-flash" },
      );
    });

    it("job payload model override takes precedence over subagents.model", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
                subagents: { model: "ollama/llama3.2:3b" },
              },
            },
          },
          payload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4o",
          },
        },
        { provider: "openai", model: "gpt-4o" },
      );
    });

    it("prefers the agent model over agents.defaults.subagents.model", async () => {
      await expectSelectedModel(
        {
          cfg: {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
                subagents: { model: "ollama/llama3.2:3b" },
              },
            },
          },
          agentConfigOverride: {
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        },
        { provider: "anthropic", model: "claude-opus-4-6" },
      );
    });
  });
});
