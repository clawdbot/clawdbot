import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks a Claude CLI runtime model available with ambient CLI OAuth", async () => {
    const homeDir = tempDirs.make("models-list-claude-cli-");
    const credentialDir = path.join(homeDir, ".claude");
    fs.mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(credentialDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-access",
          refreshToken: "test-refresh",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      { mode: 0o600 },
    );
    vi.stubEnv("HOME", homeDir);

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
