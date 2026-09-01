import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  ProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("anthropic session catalog lazy imports", () => {
  afterEach(() => {
    vi.doUnmock("./session-catalog.js");
    vi.doUnmock("./session-catalog-node-commands.js");
    vi.doUnmock("openclaw/plugin-sdk/provider-auth");
    vi.resetModules();
  });

  it("loads catalog and node handlers only on first use", async () => {
    let catalogImports = 0;
    let nodeCommandImports = 0;
    vi.doMock("./session-catalog.js", () => {
      catalogImports += 1;
      return {
        createClaudeSessionCatalogRuntime: () => ({
          list: async () => [],
          read: async () => ({ hostId: "gateway:local", label: "Local", threadId: "", items: [] }),
          continueSession: async () => ({ sessionKey: "agent:main:test" }),
          startTerminalSession: async () => ({ kind: "local", argv: ["claude"] }),
          openTerminal: async () => ({ kind: "local", argv: ["claude"] }),
          checkUpstreamActivity: async () => [],
        }),
      };
    });
    vi.doMock("./session-catalog-node-commands.js", () => {
      nodeCommandImports += 1;
      return {
        listClaudeSessions: async () => "[]",
        readClaudeSession: async () => "{}",
        resumeClaudeSession: async () => "{}",
      };
    });

    const { default: anthropicPlugin } = await import("./index.js");
    const catalogs: SessionCatalogProvider[] = [];
    const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
    const nodePolicies: OpenClawPluginNodeInvokePolicy[] = [];
    anthropicPlugin.register(
      createTestPluginApi({
        id: "anthropic",
        name: "Anthropic",
        source: "test",
        config: {},
        runtime: createPluginRuntimeMock(),
        registerSessionCatalog: (provider) => catalogs.push(provider),
        registerNodeHostCommand: (command) => nodeCommands.push(command),
        registerNodeInvokePolicy: (policy) => nodePolicies.push(policy),
      }),
    );

    expect(catalogImports).toBe(0);
    expect(nodeCommandImports).toBe(0);
    expect(catalogs).toHaveLength(1);
    expect(nodeCommands).toHaveLength(3);
    expect(nodePolicies).toHaveLength(1);

    await expect(catalogs[0]?.list({ agentId: "main" })).resolves.toEqual([]);
    await expect(catalogs[0]?.list({ agentId: "main" })).resolves.toEqual([]);
    await expect(nodeCommands[0]?.handle()).resolves.toBe("[]");
    await expect(nodeCommands[0]?.handle()).resolves.toBe("[]");
    expect(catalogImports).toBe(1);
    expect(nodeCommandImports).toBe(1);
  });

  it("registers provider hooks before loading auth execution", async () => {
    vi.doMock("openclaw/plugin-sdk/provider-auth", () => {
      throw new Error("auth execution loaded");
    });
    const { default: anthropicPlugin } = await import("./index.js");
    const providers: ProviderPlugin[] = [];
    anthropicPlugin.register(
      createTestPluginApi({
        id: "anthropic",
        name: "Anthropic",
        source: "test",
        config: {},
        runtime: createPluginRuntimeMock(),
        registerProvider: (provider) => providers.push(provider),
      }),
    );
    const provider = providers[0]!;
    expect(provider.auth.map(({ id }) => id)).toEqual(["cli", "setup-token", "api-key"]);
    expect(
      provider.classifyFailoverReason?.({
        provider: "anthropic",
        errorMessage: "",
        code: "API_ERROR",
      }),
    ).toBe("server_error");
    await expect(
      provider.buildAuthDoctorHint!({
        provider: "anthropic",
        store: { version: 1, profiles: {} },
      }),
    ).rejects.toMatchObject({
      cause: { message: "auth execution loaded" },
    });
  });
});
