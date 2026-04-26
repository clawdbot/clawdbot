import { describe, expect, it } from "vitest";
import { planProviderIndexModelCatalogRows } from "./index.js";

describe("provider index model catalog planner", () => {
  it("builds preview rows from installable provider metadata", () => {
    const plan = planProviderIndexModelCatalogRows({
      providerFilter: "Moonshot",
      index: {
        version: 1,
        providers: {
          moonshot: {
            id: "moonshot",
            name: "Moonshot AI",
            plugin: {
              id: "moonshot",
              package: "@openclaw/plugin-moonshot",
            },
            previewCatalog: {
              models: [{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 262144 }],
            },
          },
          deepseek: {
            id: "deepseek",
            name: "DeepSeek",
            plugin: { id: "deepseek" },
            previewCatalog: {
              models: [{ id: "deepseek-chat" }],
            },
          },
        },
      },
    });

    expect(plan.entries).toEqual([
      {
        provider: "moonshot",
        pluginId: "moonshot",
        rows: [
          {
            provider: "moonshot",
            id: "kimi-k2.6",
            ref: "moonshot/kimi-k2.6",
            mergeKey: "moonshot::kimi-k2.6",
            name: "Kimi K2.6",
            source: "provider-index",
            input: ["text"],
            reasoning: false,
            status: "preview",
            contextWindow: 262144,
          },
        ],
      },
    ]);
    expect(plan.rows.map((row) => row.ref)).toEqual(["moonshot/kimi-k2.6"]);
  });
});
