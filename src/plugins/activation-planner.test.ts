import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mocks.loadPluginManifestRegistry(...args),
}));

let resolveManifestActivationPluginIds: typeof import("./activation-planner.js").resolveManifestActivationPluginIds;

describe("resolveManifestActivationPluginIds", () => {
  beforeAll(async () => {
    ({ resolveManifestActivationPluginIds } = await import("./activation-planner.js"));
  });

  beforeEach(() => {
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue({
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
          id: "openai",
          providers: ["openai"],
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

  it("matches command triggers from activation metadata and legacy command aliases", () => {
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

  it("matches provider, channel, and route triggers from manifest-owned metadata", () => {
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

  it("matches capability triggers from explicit hints or existing manifest ownership", () => {
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

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider: "openai",
        },
        onlyPluginIds: [],
      }),
    ).toEqual([]);
  });
});
