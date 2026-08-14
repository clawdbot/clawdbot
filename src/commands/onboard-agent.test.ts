import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  migrateLegacyMainSessionKeys: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../agents/agent-create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-create.js")>()),
  createAgent: mocks.createAgent,
}));
vi.mock("../config/config.js", () => ({ readConfigFileSnapshot: mocks.readConfigFileSnapshot }));
vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: mocks.migrateLegacyMainSessionKeys,
}));

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
    mocks.migrateLegacyMainSessionKeys.mockResolvedValue({});
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
        hash: "hash-after-create",
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
        entry: expect.objectContaining({ id: "main" }),
        bootstrapMain: true,
      }),
    );
    expect(mocks.createAgent.mock.calls[0]?.[0]?.entry).not.toHaveProperty("default");
    expect(result).toMatchObject({
      agentId: "main",
      config: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          entries: { main: { default: true } },
        },
        gateway: { mode: "local", controlUi: { enabled: true } },
      },
    });
  });

  it("stages a normalized named first agent and runs legacy-session convergence", async () => {
    mocks.createAgent.mockResolvedValueOnce({
      status: "created",
      agentId: "robby",
      name: "Robby!",
      workspace: "/tmp/work",
      agentDir: "/tmp/agent",
      bootstrapPending: true,
    });

    await ensureOnboardingAgent({
      config: {},
      workspace: "/tmp/work",
      firstAgent: { name: "Robby!" },
    });

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ entry: { id: "robby", name: "Robby!", workspace: "/tmp/work" } }),
    );
    expect(mocks.migrateLegacyMainSessionKeys).toHaveBeenCalledWith({
      cfg: expect.objectContaining({ agents: expect.any(Object) }),
      mode: "automatic",
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
  it("reports the post-create config hash so callers can rebase their commit", async () => {
    // Regression (#112678): creating the first roster agent writes the config
    // file, so a caller holding a pre-create hash would fail its own optimistic
    // write with ConfigMutationConflictError and leave onboarding half-applied.
    const result = await ensureOnboardingAgent({
      config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      workspace: "/tmp/work",
    });

    expect(result.configHash).toBe("hash-after-create");
  });

  it("omits the config hash when no agent had to be created", async () => {
    const config = { agents: { list: [{ id: "main", default: true }] } };

    const result = await ensureOnboardingAgent({
      config,
      workspace: "/tmp/work",
      preserveCandidateRoster: true,
    });

    expect(result.configHash).toBeUndefined();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});
