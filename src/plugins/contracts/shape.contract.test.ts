import { describe, expect, it } from "vitest";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../../test/helpers/plugins/contracts-testkit.js";
import { buildPluginShapeSummary } from "../inspect-shape.js";

describe("plugin shape compatibility matrix", () => {
  it("keeps legacy hook-only, plain capability, and hybrid capability shapes explicit", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "lca-legacy",
      name: "LCA Legacy",
      register(api) {
        api.on("before_agent_start", () => ({
          prependContext: "legacy",
        }));
      },
    });

    registerVirtualTestPlugin({
      registry,
      config,
      id: "plain-provider",
      name: "Plain Provider",
      register(api) {
        api.registerProvider({
          id: "plain-provider",
          label: "Plain Provider",
          auth: [],
        });
      },
    });

    registerVirtualTestPlugin({
      registry,
      config,
      id: "hybrid-company",
      name: "Hybrid Company",
      register(api) {
        api.registerProvider({
          id: "hybrid-company",
          label: "Hybrid Company",
          auth: [],
        });
        api.registerWebSearchProvider({
          id: "hybrid-search",
          label: "Hybrid Search",
          hint: "Search the web",
          envVars: ["HYBRID_SEARCH_KEY"],
          placeholder: "hsk_...",
          signupUrl: "https://example.com/signup",
          credentialPath: "tools.web.search.hybrid-search.apiKey",
          getCredentialValue: () => "hsk-test",
          setCredentialValue(searchConfigTarget, value) {
            searchConfigTarget.apiKey = value;
          },
          createTool: () => ({
            description: "Hybrid search",
            parameters: {},
            execute: async () => ({}),
          }),
        });
      },
    });

    registerVirtualTestPlugin({
      registry,
      config,
      id: "channel-demo",
      name: "Channel Demo",
      register(api) {
        api.registerChannel({
          plugin: {
            id: "channel-demo",
            meta: {
              id: "channel-demo",
              label: "Channel Demo",
              selectionLabel: "Channel Demo",
              docsPath: "/channels/channel-demo",
              blurb: "channel demo",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });
      },
    });

    const report = {
      workspaceDir: "/virtual-workspace",
      ...registry.registry,
    };
    const inspect = report.plugins.map((plugin) =>
      Object.assign({ plugin }, buildPluginShapeSummary({ plugin, report })),
    );

    expect(
      inspect.map((entry) => ({
        id: entry.plugin.id,
        shape: entry.shape,
        capabilityMode: entry.capabilityMode,
      })),
    ).toEqual([
      {
        id: "lca-legacy",
        shape: "hook-only",
        capabilityMode: "none",
      },
      {
        id: "plain-provider",
        shape: "plain-capability",
        capabilityMode: "plain",
      },
      {
        id: "hybrid-company",
        shape: "hybrid-capability",
        capabilityMode: "hybrid",
      },
      {
        id: "channel-demo",
        shape: "plain-capability",
        capabilityMode: "plain",
      },
    ]);

    expect(inspect[0]?.usesLegacyBeforeAgentStart).toBe(true);
    expect(inspect.map((entry) => entry.capabilities.map((capability) => capability.kind))).toEqual(
      [[], ["text-inference"], ["text-inference", "web-search"], ["channel"]],
    );
  });
});
