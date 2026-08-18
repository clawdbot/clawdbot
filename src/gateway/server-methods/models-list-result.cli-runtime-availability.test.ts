import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

const mocks = vi.hoisted(() => ({
  readClaudeCliCredentialsCached: vi.fn<() => unknown>(() => null),
  readCodexCliCredentialsCached: vi.fn<() => unknown>(() => null),
  readMiniMaxCliCredentialsCached: vi.fn<() => unknown>(() => null),
}));

vi.mock("../../agents/cli-credentials.js", () => mocks);

const config = {
  agents: {
    defaults: { model: { primary: "anthropic/claude-opus-5" } },
    list: [
      {
        id: "main",
        default: true,
        models: {
          "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
        },
      },
    ],
  },
} satisfies OpenClawConfig;

async function listClaudeCliModel() {
  return await listModels({
    catalog: [],
    staticEntries: [providerCatalogEntry("anthropic", "claude-opus-5")],
    cfg: config,
    view: "configured",
  });
}

describe("models.list CLI runtime availability", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mocks.readClaudeCliCredentialsCached.mockReset();
    mocks.readClaudeCliCredentialsCached.mockReturnValue(null);
    mocks.readCodexCliCredentialsCached.mockReset();
    mocks.readCodexCliCredentialsCached.mockReturnValue(null);
    mocks.readMiniMaxCliCredentialsCached.mockReset();
    mocks.readMiniMaxCliCredentialsCached.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks a Claude CLI runtime model available with ambient CLI OAuth", async () => {
    mocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });

    await expect(listClaudeCliModel()).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: true })],
    });
  });

  it("marks a Claude CLI runtime model unavailable without ambient CLI OAuth", async () => {
    await expect(listClaudeCliModel()).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: false })],
    });
  });
});
