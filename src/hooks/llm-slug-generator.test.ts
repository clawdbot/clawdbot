import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const runEmbeddedAgentMock = vi.fn();

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-agent"),
  resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent/.openclaw-agent"),
  resolveAgentEffectiveModelPrimary: vi.fn((cfg: OpenClawConfig) => {
    const model = cfg.agents?.defaults?.model;
    if (typeof model === "string") {
      return model;
    }
    return model?.primary;
  }),
}));

vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: (...args: unknown[]) => runEmbeddedAgentMock(...args),
}));

import { generateSlugViaLLM } from "./llm-slug-generator.js";

function requireFirstRunOptions(): Record<string, unknown> {
  const [call] = runEmbeddedAgentMock.mock.calls;
  if (!call) {
    throw new Error("expected embedded OpenClaw agent run");
  }
  const [options] = call;
  if (!options || typeof options !== "object") {
    throw new Error("expected embedded OpenClaw agent run options");
  }
  return options as Record<string, unknown>;
}

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    runEmbeddedAgentMock.mockReset();
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "test-slug" }],
    });
  });

  it("keeps the helper default timeout when no agent timeout is configured", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {} as OpenClawConfig,
    });

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const options = requireFirstRunOptions();
    expect(options.timeoutMs).toBe(15_000);
    expect(options.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("honors configured agent timeoutSeconds for slow local providers", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {
        agents: {
          defaults: {
            timeoutSeconds: 500,
          },
        },
      } as OpenClawConfig,
    });

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(requireFirstRunOptions().timeoutMs).toBe(500_000);
  });

  it("infers provider metadata for bare configured agent models", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {
        agents: {
          defaults: {
            model: { primary: "gpt-5.5" },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [
                {
                  id: "gpt-5.5",
                  name: "GPT 5.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const options = requireFirstRunOptions();
    expect(options.provider).toBe("openai");
    expect(options.model).toBe("gpt-5.5");
  });
});
