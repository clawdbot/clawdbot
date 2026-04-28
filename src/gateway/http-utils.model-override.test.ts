import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const loadConfigMock = vi.fn();
const loadGatewayModelCatalogMock = vi.fn();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("./server-model-catalog.js", () => ({
  loadGatewayModelCatalog: () => loadGatewayModelCatalogMock(),
}));

import { resolveOpenAiCompatModelOverride } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("resolveOpenAiCompatModelOverride", () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies OpenClawConfig);
    loadGatewayModelCatalogMock
      .mockReset()
      .mockResolvedValue([{ id: "gpt-5.4", name: "GPT 5.4", provider: "openai" }]);
  });

  it("rejects CLI model overrides outside the configured allowlist", async () => {
    await expect(
      resolveOpenAiCompatModelOverride({
        req: createReq({ "x-openclaw-model": "claude-cli/opus" }),
        agentId: "main",
        model: "openclaw",
      }),
    ).resolves.toEqual({
      errorMessage: "Model 'claude-cli/opus' is not allowed for agent 'main'.",
    });
  });
});
