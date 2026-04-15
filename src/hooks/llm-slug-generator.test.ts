import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-agent"),
  resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent/.openclaw-agent"),
  resolveAgentEffectiveModelPrimary: vi.fn(() => null),
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
});
