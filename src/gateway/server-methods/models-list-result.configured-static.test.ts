import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { catalogEntry, listModels } from "./models-list-result.openai-routes.test-support.js";

describe("models.list configured static entries", () => {
  it("projects a configured runtime model from prepared static facts", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol" } },
        list: [
          {
            id: "main",
            default: true,
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } as OpenClawConfig;

    await expect(
      listModels({
        catalog: [],
        staticEntries: [
          catalogEntry("gpt-5.6-sol", "openai-responses"),
          catalogEntry("gpt-unconfigured", "openai-responses"),
        ],
        cfg: config,
        view: "configured",
      }),
    ).resolves.toEqual({
      models: [
        expect.objectContaining({
          id: "gpt-5.6-sol",
          provider: "openai",
          agentRuntime: {
            id: "codex",
            cloudPlacementSupported: false,
            devicePlacementSupported: false,
            source: "model",
          },
        }),
      ],
    });
  });
});
