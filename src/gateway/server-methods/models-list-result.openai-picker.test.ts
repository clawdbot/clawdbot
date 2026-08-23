import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../../commands/doctor/shared/legacy-config-migrate.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  catalogEntry,
  listModels,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

describe("models.list OpenAI picker", () => {
  it("does not expose a configured GPT-5.6 alias beside named variants after doctor normalization", async () => {
    const staleConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6" },
          models: {
            "openai/gpt-5.6": { alias: "GPT" },
            "openai/gpt-5.6-sol": {},
            "openai/gpt-5.6-terra": {},
            "openai/gpt-5.6-luna": {},
          },
        },
      },
    } as OpenClawConfig;
    const cfg = migrateLegacyConfig(staleConfig).config ?? staleConfig;
    const catalog = [
      { ...catalogEntry("gpt-5.6-sol", "openai-responses"), providerOrder: 0 },
      { ...catalogEntry("gpt-5.6-terra", "openai-responses"), providerOrder: 1 },
      { ...catalogEntry("gpt-5.6-luna", "openai-responses"), providerOrder: 2 },
    ];

    await withEnvAsync({ ...WITHOUT_OPENAI_ENV_AUTH, OPENAI_API_KEY: "test-key" }, async () => {
      const result = await listModels({ catalog, cfg, view: "configured" });
      expect(result.models.map((entry) => entry.id)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]);
    });
  });
});
