// Sessions ACP runtime metadata tests cover session-owned runtime overlays.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCurrentSessionAgentRuntimeMetadata,
  resolveModelAgentRuntimeMetadata,
} from "../agents/agent-runtime-metadata.js";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const ACP_SESSION_KEY = "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9";
const NON_ACP_SESSION_KEY = "agent:main:main";

function buildConfigWithoutAgentRuntimePolicy(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "copilot" }, { id: "main", default: true }],
      defaults: {},
    },
  } as OpenClawConfig;
}

function computeSessionAgentRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  fallbackAgentId: string;
  acpRuntime?: boolean;
  acpBackend?: string;
}): ReturnType<typeof resolveModelAgentRuntimeMetadata> {
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId ?? params.fallbackAgentId;
  return resolveModelAgentRuntimeMetadata({
    cfg: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
    acpRuntime: params.acpRuntime,
    acpBackend: params.acpBackend,
  });
}

const registeredHarnesses = listRegisteredAgentHarnesses();
beforeEach(() => clearAgentHarnesses());
afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

describe("session ACP runtime metadata", () => {
  it.each(["model", "provider", "session-key", "implicit"] as const)(
    "projects a declared fallback for the next turn while retaining %s attribution",
    (source) => {
      const supports = vi.fn((_context: unknown) => ({
        supported: false as const,
        fallbackRuntime: "openclaw" as const,
      }));
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports,
        runAttempt: async () => {
          throw new Error("projection must not execute");
        },
      });
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              ...(source === "provider" ? { agentRuntime: { id: "codex" } } : {}),
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "Sol",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8192,
                  compat: { supportsStore: false },
                },
              ],
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-sol": source === "model" ? { agentRuntime: { id: "codex" } } : {},
            },
          },
        },
      };
      const params = {
        cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionKey: NON_ACP_SESSION_KEY,
        sessionEntry: {
          agentHarnessId: "codex",
          ...(source === "session-key" ? { agentRuntimeOverride: "codex" } : {}),
        },
      };
      expect(resolveCurrentSessionAgentRuntimeMetadata(params)).toEqual({ id: "openclaw", source });
      expect(
        resolveCurrentSessionAgentRuntimeMetadata({
          ...params,
          sessionEntry: { ...params.sessionEntry, modelSelectionLocked: true },
        }),
      ).toEqual({ id: "codex", source: "session" });
      expect(
        resolveCurrentSessionAgentRuntimeMetadata({
          ...params,
          sessionKey: "agent:main:acp:runtime-test",
          acpRuntime: true,
        }),
      ).toEqual({ id: "acpx", source: "session-key" });
      // Projection consumes registered support only; it never discovers provider ownership.
      for (const [context] of supports.mock.calls) {
        expect(context).not.toHaveProperty("providerOwnerStatus");
      }
    },
  );
  it("prefers an explicit ACP backend", () => {
    const agentRuntime = computeSessionAgentRuntime({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: true,
      acpBackend: "custom-backend",
    });

    expect(agentRuntime).toEqual({ id: "custom-backend", source: "session-key" });
  });

  it("falls back to acpx when ACP metadata has no backend", () => {
    const agentRuntime = computeSessionAgentRuntime({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: true,
    });

    expect(agentRuntime).toEqual({ id: "acpx", source: "session-key" });
  });

  it("does not overlay ACP-shaped bridge sessions without ACP metadata", () => {
    const agentRuntime = computeSessionAgentRuntime({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: false,
    });

    expect(agentRuntime.id).not.toBe("acpx");
    expect(agentRuntime.source).not.toBe("session-key");
  });

  it("preserves locked Codex ownership ahead of stale OpenClaw session metadata", () => {
    const agentRuntime = resolveModelAgentRuntimeMetadata({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: NON_ACP_SESSION_KEY,
      sessionEntry: {
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
        modelSelectionLocked: true,
      },
    });

    expect(agentRuntime).toEqual({ id: "codex", source: "session" });
  });

  it.each([undefined, "codex"])(
    "reports current %s policy instead of an unlocked historical producer",
    (runtime) => {
      const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-sol": runtime ? { agentRuntime: { id: runtime } } : {},
              },
            },
          },
        } as OpenClawConfig,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionKey: NON_ACP_SESSION_KEY,
        sessionEntry: {
          agentHarnessId: "openclaw",
        },
      });

      expect(agentRuntime).toEqual({ id: "codex", source: runtime ? "model" : "implicit" });
    },
  );

  it("keeps an explicit compatible runtime override", () => {
    const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      agentId: "main",
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionKey: NON_ACP_SESSION_KEY,
      sessionEntry: {
        agentHarnessId: "openclaw",
        agentRuntimeOverride: "codex",
      },
    });

    expect(agentRuntime).toEqual({ id: "codex", source: "session-key" });
  });
});
