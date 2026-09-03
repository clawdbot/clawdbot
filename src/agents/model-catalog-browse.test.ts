import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildProviderConfigModelCatalogForBrowse } from "./model-catalog-browse.js";

describe("buildProviderConfigModelCatalogForBrowse", () => {
  it("builds provider-config inventory independently of picker allowlists", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/allowlisted": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            models: [
              { id: "two", name: "Two" },
              { id: "one", name: "One" },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(buildProviderConfigModelCatalogForBrowse({ cfg })).toMatchObject([
      { provider: "openai", id: "one", name: "One" },
      { provider: "openai", id: "two", name: "Two" },
    ]);
  });
});
