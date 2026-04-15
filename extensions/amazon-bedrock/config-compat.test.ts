import { describe, expect, it } from "vitest";
import { migrateAmazonBedrockLegacyConfig } from "./config-compat.js";

describe("amazon-bedrock config migration", () => {
  it("moves legacy models.bedrockDiscovery into plugin-owned discovery config", () => {
    const result = migrateAmazonBedrockLegacyConfig({
      models: {
        mode: "merge",
        bedrockDiscovery: {
          enabled: true,
          region: "us-east-1",
          refreshInterval: 3600,
        },
      },
    });

    expect(result.config).toEqual({
      models: {
        mode: "merge",
      },
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                enabled: true,
                region: "us-east-1",
                refreshInterval: 3600,
              },
            },
          },
        },
      },
    });
    expect(result.changes).toEqual([
      "Moved models.bedrockDiscovery → plugins.entries.amazon-bedrock.config.discovery.",
    ]);
  });

  it("merges missing fields into existing plugin discovery config", () => {
    const result = migrateAmazonBedrockLegacyConfig({
      models: {
        bedrockDiscovery: {
          enabled: true,
          region: "us-east-1",
          providerFilter: ["anthropic"],
        },
      },
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                region: "us-west-2",
              },
            },
          },
        },
      },
    });

    expect(result.config).toEqual({
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                enabled: true,
                region: "us-west-2",
                providerFilter: ["anthropic"],
              },
            },
          },
        },
      },
    });
    expect(result.changes).toEqual([
      "Merged models.bedrockDiscovery → plugins.entries.amazon-bedrock.config.discovery (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });
});
