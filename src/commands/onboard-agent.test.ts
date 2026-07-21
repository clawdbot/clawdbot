import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../agents/agent-create.js", () => ({
  createAgent: mocks.createAgent,
  hasValidRawAgentIdCharacters: (value: string) => /[a-z0-9]/iu.test(value),
}));
vi.mock("../config/config.js", () => ({ readConfigFileSnapshot: mocks.readConfigFileSnapshot }));

const { ensureOnboardingAgent, stageOnboardingAgent } = await import("./onboard-agent.js");

describe("onboarding agent creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgent.mockResolvedValue({
      status: "created",
      agentId: "main",
      name: "main",
      workspace: "/tmp/work",
      agentDir: "/tmp/agent",
      bootstrapPending: true,
    });
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        sourceConfig: { gateway: { port: 18789 } },
        config: { gateway: { port: 18789 } },
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        sourceConfig: {
          agents: { list: [{ id: "main", default: true }] },
          gateway: { port: 18789, bind: "lan" },
        },
        config: {
          agents: { list: [{ id: "main", default: true }] },
          gateway: { port: 18789, bind: "lan" },
        },
      });
  });

  it("merges the persisted roster into the supplied setup candidate", async () => {
    const candidate = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      gateway: { port: 19000 },
      wizard: { accessMode: "guarded" as const },
    } satisfies OpenClawConfig;

    const result = await ensureOnboardingAgent({
      config: candidate,
      name: "main",
      workspace: "/tmp/work",
    });

    expect(result.config).toMatchObject({
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        list: [{ id: "main", default: true }],
      },
      gateway: { port: 19000 },
      wizard: { accessMode: "guarded" },
    });
    expect(result.config.gateway?.bind).toBe("lan");
  });

  it("stages a first agent without writing config", () => {
    const result = stageOnboardingAgent({
      config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      name: "Research Buddy",
      workspace: "/tmp/research",
      agentDir: "/tmp/research-agent",
    });

    expect(result.config.agents?.list).toEqual([
      expect.objectContaining({
        id: "research-buddy",
        default: true,
        workspace: "/tmp/research",
        agentDir: "/tmp/research-agent",
      }),
    ]);
    expect(result.agent).toMatchObject({ agentId: "research-buddy" });
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("rejects a staged name with no valid id characters", () => {
    expect(() => stageOnboardingAgent({ config: {}, name: "###", workspace: "/tmp/work" })).toThrow(
      "no valid id characters",
    );
  });

  it("accepts main when legacy repair materialized it before duplicate detection", async () => {
    const repaired = {
      exists: true,
      valid: true,
      sourceConfig: { agents: { list: [{ id: "main", default: true }] } },
      config: { agents: { list: [{ id: "main", default: true }] } },
    };
    mocks.createAgent.mockResolvedValue({
      status: "existing",
      agentId: "main",
      name: "main",
      workspace: "/tmp/work",
      agentDir: "/tmp/agent",
      bootstrapPending: false,
    });
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce({ exists: true, valid: true, sourceConfig: {}, config: {} })
      .mockResolvedValueOnce(repaired);

    await expect(
      ensureOnboardingAgent({ config: {}, name: "main", workspace: "/tmp/work" }),
    ).resolves.toMatchObject({ agentId: "main", config: repaired.config });
  });
});
