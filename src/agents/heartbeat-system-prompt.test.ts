// Verifies when heartbeat guidance is injected into the default agent prompt.
import { describe, expect, it } from "vitest";
import { resolveHeartbeatPromptForSystemPrompt } from "./heartbeat-system-prompt.js";

describe("resolveHeartbeatPromptForSystemPrompt", () => {
  it("includes the heartbeat section for the default enabled cadence", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: { heartbeat: {} },
            entries: { main: { default: true } },
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeDefined();
  });

  it.each([
    {
      name: "explicit fleet",
      config: {
        agents: {
          ownership: "explicit" as const,
          defaults: { systemAgent: { agentId: "beta" } },
          entries: { alpha: {}, beta: {} },
        },
      },
    },
    {
      name: "legacy-marked fleet",
      config: {
        agents: {
          defaults: { systemAgent: { agentId: "beta" } },
          entries: { alpha: { default: true }, beta: {} },
        },
      },
    },
  ])("includes ambient heartbeat guidance only for the system owner in an $name", ({ config }) => {
    expect(resolveHeartbeatPromptForSystemPrompt({ config, agentId: "beta" })).toBeDefined();
    expect(resolveHeartbeatPromptForSystemPrompt({ config, agentId: "alpha" })).toBeUndefined();
  });

  it("omits the heartbeat section when the default cadence is disabled", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                every: "0m",
              },
            },
            entries: { main: { default: true } },
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("omits the heartbeat section when the default-agent override disables cadence", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                every: "30m",
              },
            },
            list: [
              {
                id: "main",
                heartbeat: {
                  every: "0m",
                },
              },
            ],
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("omits the heartbeat section when only a non-default agent has explicit heartbeat config", () => {
    // The system prompt section is only for the default active agent; sibling
    // agent heartbeat settings should not leak into the default prompt.
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            list: [
              { id: "main", default: true },
              {
                id: "ops",
                heartbeat: {
                  every: "30m",
                },
              },
            ],
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("includes the heartbeat section for every agent enrolled by shared defaults", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: { heartbeat: { every: "30m" } },
            list: [{ id: "ops" }, { id: "research" }],
          },
        },
        agentId: "research",
      }),
    ).toBeDefined();
  });

  it("includes the heartbeat section only for explicitly enrolled agents", () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        list: [{ id: "ops" }, { id: "research", heartbeat: { every: "30m" } }],
      },
    };

    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config,
        agentId: "research",
      }),
    ).toBeDefined();
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config,
        agentId: "ops",
      }),
    ).toBeUndefined();
  });

  it("honors default-agent overrides for the prompt text", () => {
    // Defaults establish cadence/shape, but the default agent can override the
    // final visible prompt text.
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                prompt: "Default prompt",
              },
            },
            list: [
              {
                id: "main",
                heartbeat: {
                  prompt: "  Ops check  ",
                },
              },
            ],
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toContain("Ops check");
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: { heartbeat: { every: "30m" } },
            list: [{ id: "main", heartbeat: { prompt: "Ops check" } }],
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toContain("Recurring tasks are automations");
  });

  it("includes the heartbeat section for explicitly enrolled non-default agents", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                prompt: "Default prompt",
              },
            },
            list: [
              {
                id: "ops",
                heartbeat: {
                  prompt: "Ops prompt",
                },
              },
            ],
          },
        },
        agentId: "ops",
        defaultAgentId: "main",
      }),
    ).toContain("Ops prompt");
  });
});
