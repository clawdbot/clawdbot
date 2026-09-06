import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "./harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "./harness/registry.test-support.js";
import type { AgentHarness } from "./harness/types.js";
import {
  hasResolvedThinkingCatalogEntry,
  resolveCandidateThinkingLevel,
  resolveEffectiveAgentRuntime,
} from "./thinking-runtime.js";

describe("hasResolvedThinkingCatalogEntry", () => {
  it("requires authoritative reasoning metadata for the selected model", () => {
    const catalog = [
      { provider: "ollama", id: "unknown", reasoning: true },
      { provider: "OLLAMA", id: "minimax-m3:cloud" },
    ];

    expect(
      hasResolvedThinkingCatalogEntry({
        catalog,
        provider: "ollama",
        model: "minimax-m3:cloud",
      }),
    ).toBe(false);
    expect(
      hasResolvedThinkingCatalogEntry({
        catalog: [{ provider: "OLLAMA", id: "minimax-m3:cloud", reasoning: false }],
        provider: "ollama",
        model: "minimax-m3:cloud",
      }),
    ).toBe(true);
  });
});

function openAIConfig(runtime: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: runtime } },
        },
      },
    },
  };
}

describe("resolveEffectiveAgentRuntime", () => {
  let registeredHarnesses: ReturnType<typeof listRegisteredAgentHarnesses>;

  beforeAll(() => {
    registeredHarnesses = listRegisteredAgentHarnesses();
  });

  beforeEach(() => {
    clearAgentHarnesses();
  });

  afterAll(() => {
    restoreRegisteredAgentHarnesses(registeredHarnesses);
  });

  it.each([false, true])(
    "retains prepared owner request parameters through implicit and registered support (explicit=%s)",
    (explicit) => {
      const supports = vi.fn<AgentHarness["supports"]>(({ modelProvider }) =>
        modelProvider?.requestTransportOverrides === "present"
          ? { supported: false, fallbackRuntime: "openclaw" }
          : { supported: true },
      );
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports,
        runAttempt: async () => {
          throw new Error("projection must not execute");
        },
      });
      const cfg: OpenClawConfig = {
        session: { store: "/synthetic/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: {
            sessionStore: { agentId: "ops" },
            ...(explicit
              ? { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } } }
              : {}),
          },
          entries: { main: { params: { temperature: 0.2 } }, ops: {} },
        },
      };
      expect(
        resolveEffectiveAgentRuntime({
          cfg,
          provider: "openai",
          modelId: "gpt-5.6-luna",
          sessionKey: "global",
          agentScope: { kind: "prepared", agentId: "main" },
        }),
      ).toBe("openclaw");
      if (explicit) {
        expect(supports).toHaveBeenCalledWith(
          expect.objectContaining({
            modelProvider: expect.objectContaining({ requestTransportOverrides: "present" }),
          }),
        );
      } else {
        expect(supports).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps cold-start official OpenAI Luna on implicit Codex policy", () => {
    expect(
      resolveEffectiveAgentRuntime({
        cfg: {},
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toBe("codex");
  });

  it("resolves residual auto to OpenClaw when no plugin harness is registered", () => {
    expect(
      resolveEffectiveAgentRuntime({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        },
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toBe("openclaw");
  });

  it("uses static auto-selection facts before resolving provider routes", () => {
    const supports = vi.fn<AgentHarness["supports"]>(() => ({ supported: true, priority: 100 }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      autoSelection: { providerIds: ["openai", "codex"] },
      supports,
      runAttempt: async () => {
        throw new Error("not exercised");
      },
    });

    expect(
      resolveEffectiveAgentRuntime({
        cfg: {},
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
      }),
    ).toBe("openclaw");
    expect(supports).not.toHaveBeenCalled();
  });

  it("keeps an authored custom route on OpenClaw before registered harness selection", () => {
    const supports = vi.fn<AgentHarness["supports"]>(({ provider }) =>
      provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
    );
    const codexHarness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: async () => {
        throw new Error("not exercised");
      },
    };
    registerAgentHarness(codexHarness);

    expect(
      resolveEffectiveAgentRuntime({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        },
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toBe("openclaw");
    expect(supports).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "projects explicit session overrides with declared fallback=%s",
    (fallback) => {
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports: () =>
          fallback ? { supported: false, fallbackRuntime: "openclaw" } : { supported: true },
        runAttempt: async () => {
          throw new Error("projection must not execute");
        },
      });
      const cfg = openAIConfig("openclaw");
      expect(
        resolveEffectiveAgentRuntime({
          cfg,
          provider: "openai",
          modelId: "gpt-5.6-luna",
          sessionEntry: { agentRuntimeOverride: "codex", agentHarnessId: "openclaw" },
        }),
      ).toBe(fallback ? "openclaw" : "codex");
    },
  );

  it("ignores legacy harness ids when choosing a runtime", () => {
    const cfg = openAIConfig("openclaw");
    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-luna",
        sessionEntry: { agentHarnessId: "codex" },
      }),
    ).toBe("openclaw");
  });

  it("uses configured runtime policy without session hints", () => {
    const cfg = openAIConfig("openclaw");
    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toBe("openclaw");
  });

  it("lets an explicit OpenClaw override replace configured Codex policy", () => {
    expect(
      resolveEffectiveAgentRuntime({
        cfg: openAIConfig("codex"),
        provider: "openai",
        modelId: "gpt-5.6-luna",
        sessionEntry: { agentRuntimeOverride: "openclaw", agentHarnessId: "codex" },
      }),
    ).toBe("openclaw");
  });

  it("keeps a supported candidate level unchanged", () => {
    expect(
      resolveCandidateThinkingLevel({
        cfg: {},
        provider: "demo",
        modelId: "demo-model",
        level: "medium",
      }),
    ).toBe("medium");
  });

  it("clamps an unsupported candidate level without changing the requested value", () => {
    const requested = "ultra" as const;

    expect(
      resolveCandidateThinkingLevel({
        cfg: {},
        provider: "demo",
        modelId: "demo-model",
        level: requested,
      }),
    ).toBe("high");
    expect(requested).toBe("ultra");
  });

  it("re-evaluates every candidate from the immutable request so later support can upgrade", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    const requested = "ultra" as const;

    expect(
      resolveCandidateThinkingLevel({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-luna",
        level: requested,
      }),
    ).toBe("max");
    expect(
      resolveCandidateThinkingLevel({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-sol",
        level: requested,
      }),
    ).toBe("ultra");
  });
});
