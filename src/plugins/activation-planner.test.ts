import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

vi.mock("./plugin-registry-contributions.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForPluginRegistry(...args),
}));

let resolveManifestActivationPluginIds: typeof import("./activation-planner.js").resolveManifestActivationPluginIds;
let resolveManifestActivationPlan: typeof import("./activation-planner.js").resolveManifestActivationPlan;

describe("activation planner", () => {
  beforeAll(async () => {
    ({ resolveManifestActivationPlan, resolveManifestActivationPluginIds } =
      await import("./activation-planner.js"));
  });

  beforeEach(() => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "memory-core",
          commandAliases: [{ name: "dreaming", kind: "runtime-slash", cliCommand: "memory" }],
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "device-pair",
          commandAliases: [{ name: "pair", kind: "runtime-slash" }],
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "browser",
          commandAliases: [{ name: "browser" }],
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "openai",
          providers: ["openai"],
          activation: {
            onAgentHarnesses: ["codex"],
          },
          setup: {
            providers: [{ id: "openai-codex" }],
          },
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
        },
        {
          id: "demo-channel",
          channels: ["telegram"],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: ["before-agent-start"],
          contracts: {
            tools: ["web-search"],
          },
          activation: {
            onRoutes: ["webhook"],
            onCommands: ["demo-tools"],
          },
          origin: "workspace",
        },
      ],
      diagnostics: [],
    });
  });

  it("keeps ids-only command planning stable", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "memory",
        },
      }),
    ).toEqual(["memory-core"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "browser",
        },
      }),
    ).toEqual(["browser"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "pair",
        },
      }),
    ).toEqual(["device-pair"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "command",
          command: "demo-tools",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("keeps ids-only provider, agent harness, channel, and route planning stable", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai-codex",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "agentHarness",
          runtime: "codex",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "channel",
          channel: "telegram",
        },
      }),
    ).toEqual(["demo-channel"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "route",
          route: "webhook",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("keeps ids-only capability planning stable", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "provider",
        },
      }),
    ).toEqual(["openai"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "tool",
        },
      }),
    ).toEqual(["demo-channel"]);

    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "capability",
          capability: "hook",
        },
      }),
    ).toEqual(["demo-channel"]);
  });

  it("returns a richer activation plan with planner-hint reasons", () => {
    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "command",
          command: "demo-tools",
        },
      }),
    ).toEqual({
      trigger: {
        kind: "command",
        command: "demo-tools",
      },
      pluginIds: ["demo-channel"],
      entries: [
        {
          pluginId: "demo-channel",
          origin: "workspace",
          reasons: ["activation-command-hint"],
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "agentHarness",
          runtime: "codex",
        },
      }).entries,
    ).toEqual([
      {
        pluginId: "openai",
        origin: "bundled",
        reasons: ["activation-agent-harness-hint"],
      },
    ]);

    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "route",
          route: "webhook",
        },
      }).entries,
    ).toEqual([
      {
        pluginId: "demo-channel",
        origin: "workspace",
        reasons: ["activation-route-hint"],
      },
    ]);
  });

  it("returns manifest-owner reasons when activation hints are absent", () => {
    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
      }).entries,
    ).toEqual([
      {
        pluginId: "openai",
        origin: "bundled",
        reasons: ["manifest-provider-owner"],
      },
    ]);

    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "provider",
          provider: "openai-codex",
        },
      }).entries,
    ).toEqual([
      {
        pluginId: "openai",
        origin: "bundled",
        reasons: ["manifest-setup-provider-owner"],
      },
    ]);

    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "channel",
          channel: "telegram",
        },
      }).entries,
    ).toEqual([
      {
        pluginId: "demo-channel",
        origin: "workspace",
        reasons: ["manifest-channel-owner"],
      },
    ]);
  });

  it("returns capability reasons from explicit hints and manifest ownership", () => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "explicit-provider",
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          activation: {
            onCapabilities: ["provider"],
            onProviders: ["custom-provider"],
          },
          origin: "workspace",
        },
        {
          id: "owned-tool",
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          contracts: {
            tools: ["custom-tool"],
          },
          origin: "workspace",
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "capability",
          capability: "provider",
        },
      }).entries,
    ).toEqual([
      {
        pluginId: "explicit-provider",
        origin: "workspace",
        reasons: ["activation-capability-hint", "activation-provider-hint"],
      },
    ]);

    expect(
      resolveManifestActivationPlan({
        trigger: {
          kind: "capability",
          capability: "tool",
        },
      }).entries,
    ).toEqual([
      {
        pluginId: "owned-tool",
        origin: "workspace",
        reasons: ["manifest-tool-contract"],
      },
    ]);
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
        onlyPluginIds: [],
      }),
    ).toStrictEqual([]);
  });
});
