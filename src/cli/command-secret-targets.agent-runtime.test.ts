// Agent runtime target tests cover optional tool credentials without broad command-target fixtures.
import { describe, expect, it, vi } from "vitest";

const firecrawlPath = "plugins.entries.firecrawl.config.webFetch.apiKey";
const exaPath = "plugins.entries.exa.config.webSearch.apiKey";

vi.mock("../secrets/target-registry.js", () => ({
  listSecretTargetRegistryEntries: () => [
    { id: firecrawlPath },
    { id: exaPath },
    { id: "plugins.entries.example.config.other.apiKey" },
  ],
  discoverConfigSecretTargetsByIds: (
    config: {
      plugins?: {
        entries?: Record<string, { config?: Record<string, Record<string, unknown>> }>;
      };
    },
    targetIds: Iterable<string>,
  ) => {
    const ids = new Set(targetIds);
    const firecrawlValue = config.plugins?.entries?.firecrawl?.config?.webFetch?.apiKey;
    const exaValue = config.plugins?.entries?.exa?.config?.webSearch?.apiKey;
    return [
      ...(ids.has(firecrawlPath) && firecrawlValue !== undefined
        ? [
            {
              entry: { id: firecrawlPath },
              path: firecrawlPath,
              pathSegments: firecrawlPath.split("."),
              value: firecrawlValue,
            },
          ]
        : []),
      ...(ids.has(exaPath) && exaValue !== undefined
        ? [
            {
              entry: { id: exaPath },
              path: exaPath,
              pathSegments: exaPath.split("."),
              value: exaValue,
            },
          ]
        : []),
    ];
  },
}));

const { getAgentRuntimeOptionalCommandSecretPaths } = await import("./command-secret-targets.js");

describe("agent runtime command secret targets", () => {
  it("marks only configured web SecretRefs optional for generic agent startup", () => {
    const paths = getAgentRuntimeOptionalCommandSecretPaths({
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
              },
            },
          },
          exa: {
            config: {
              webSearch: { apiKey: "inline-key" },
            },
          },
        },
      },
    } as never);

    expect(paths).toEqual(new Set([firecrawlPath]));
  });
});
