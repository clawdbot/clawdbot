import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../agents/agent-create.js", () => ({ createAgent: mocks.createAgent }));
vi.mock("../config/config.js", () => ({ readConfigFileSnapshot: mocks.readConfigFileSnapshot }));

const { ensureOnboardingAgent } = await import("./onboard-agent.js");

describe("onboarding main-agent creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgent.mockResolvedValue({
      status: "existing",
      agentId: "main",
      name: "main",
      workspace: "/tmp/work",
      agentDir: "/tmp/agent",
      bootstrapPending: true,
    });
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce({
        exists: false,
        valid: true,
        sourceConfig: { agents: { list: [{ id: "main", default: true }] }, gateway: {} },
        config: { agents: { list: [{ id: "main", default: true }] }, gateway: {} },
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        sourceConfig: {
          agents: { list: [{ id: "main", default: true }] },
          gateway: { controlUi: { enabled: true } },
        },
        config: {
          agents: { list: [{ id: "main", default: true }] },
          gateway: { controlUi: { enabled: true } },
        },
      });
  });

  it("provisions explicit main through createAgent on a fresh install", async () => {
    const result = await ensureOnboardingAgent({
      config: {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        gateway: { mode: "local" },
      },
      workspace: "/tmp/work",
    });

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "main", default: true }),
      }),
    );
    expect(result).toMatchObject({
      agentId: "main",
      config: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          list: [{ id: "main", default: true }],
        },
        gateway: { mode: "local", controlUi: { enabled: true } },
      },
    });
  });

  it("preserves an explicit imported candidate roster", async () => {
    const config = { agents: { list: [{ id: "main", default: true }] } };

    await expect(
      ensureOnboardingAgent({
        config,
        workspace: "/tmp/work",
        preserveCandidateRoster: true,
      }),
    ).resolves.toEqual({ config, agentId: "main", bootstrapPending: false });
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});
