import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const runEmbeddedPiAgentMock = vi.fn();

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

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
}));

import { generateSlugViaLLM } from "./llm-slug-generator.js";

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "test-slug" }],
    });
  });

  it("keeps the helper default timeout when no agent timeout is configured", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {} as OpenClawConfig,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        timeoutMs: 15_000,
        cleanupBundleMcpOnRunEnd: true,
      }),
    );
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

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        timeoutMs: 500_000,
      }),
    );
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
            "openai-codex": {
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

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: "openai-codex",
        model: "gpt-5.5",
      }),
    );
  });
});
