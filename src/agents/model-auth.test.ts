import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

const oauthFixture = {
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  accountId: "acct_123",
};

describe("getApiKeyForModel", () => {
  it("migrates legacy oauth.json into auth-profiles.json", async () => {
    const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
    const previousAgentDir = process.env.CLAWDBOT_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-oauth-"));

    try {
      process.env.CLAWDBOT_STATE_DIR = tempDir;
      process.env.CLAWDBOT_AGENT_DIR = path.join(tempDir, "agent");
      process.env.PI_CODING_AGENT_DIR = process.env.CLAWDBOT_AGENT_DIR;

      const oauthDir = path.join(tempDir, "credentials");
      await fs.mkdir(oauthDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(oauthDir, "oauth.json"),
        `${JSON.stringify({ "openai-codex": oauthFixture }, null, 2)}\n`,
        "utf8",
      );

      vi.resetModules();
      const { getApiKeyForModel } = await import("./model-auth.js");

      const model = {
        id: "codex-mini-latest",
        provider: "openai-codex",
        api: "openai-codex-responses",
      } as Model<Api>;

      const apiKey = await getApiKeyForModel({
        model,
        cfg: {
          auth: {
            profiles: {
              "openai-codex:default": {
                provider: "openai-codex",
                mode: "oauth",
              },
            },
          },
        },
      });
      expect(apiKey.apiKey).toBe(oauthFixture.access);

      const authProfiles = await fs.readFile(
        path.join(tempDir, "agent", "auth-profiles.json"),
        "utf8",
      );
      const authData = JSON.parse(authProfiles) as Record<string, unknown>;
      expect(authData.profiles).toMatchObject({
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: oauthFixture.access,
          refresh: oauthFixture.refresh,
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.CLAWDBOT_STATE_DIR;
      } else {
        process.env.CLAWDBOT_STATE_DIR = previousStateDir;
      }
      if (previousAgentDir === undefined) {
        delete process.env.CLAWDBOT_AGENT_DIR;
      } else {
        process.env.CLAWDBOT_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("suggests openai-codex when only Codex OAuth is configured", async () => {
    const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
    const previousAgentDir = process.env.CLAWDBOT_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-auth-"));

    try {
      delete process.env.OPENAI_API_KEY;
      process.env.CLAWDBOT_STATE_DIR = tempDir;
      process.env.CLAWDBOT_AGENT_DIR = path.join(tempDir, "agent");
      process.env.PI_CODING_AGENT_DIR = process.env.CLAWDBOT_AGENT_DIR;

      const authProfilesPath = path.join(
        tempDir,
        "agent",
        "auth-profiles.json",
      );
      await fs.mkdir(path.dirname(authProfilesPath), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(
        authProfilesPath,
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                ...oauthFixture,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      let error: unknown = null;
      try {
        await resolveApiKeyForProvider({ provider: "openai" });
      } catch (err) {
        error = err;
      }
      expect(String(error)).toContain("openai-codex/gpt-5.2");
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousStateDir === undefined) {
        delete process.env.CLAWDBOT_STATE_DIR;
      } else {
        process.env.CLAWDBOT_STATE_DIR = previousStateDir;
      }
      if (previousAgentDir === undefined) {
        delete process.env.CLAWDBOT_AGENT_DIR;
      } else {
        process.env.CLAWDBOT_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when ZAI API key is missing", async () => {
    const previousZai = process.env.ZAI_API_KEY;
    const previousLegacy = process.env.Z_AI_API_KEY;

    try {
      delete process.env.ZAI_API_KEY;
      delete process.env.Z_AI_API_KEY;

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      let error: unknown = null;
      try {
        await resolveApiKeyForProvider({
          provider: "zai",
          store: { version: 1, profiles: {} },
        });
      } catch (err) {
        error = err;
      }

      expect(String(error)).toContain('No API key found for provider "zai".');
    } finally {
      if (previousZai === undefined) {
        delete process.env.ZAI_API_KEY;
      } else {
        process.env.ZAI_API_KEY = previousZai;
      }
      if (previousLegacy === undefined) {
        delete process.env.Z_AI_API_KEY;
      } else {
        process.env.Z_AI_API_KEY = previousLegacy;
      }
    }
  });

  it("resolves MINIMAX_API_KEY from environment variable", async () => {
    const previousMinimaxKey = process.env.MINIMAX_API_KEY;

    try {
      process.env.MINIMAX_API_KEY = "test-minimax-key-12345";
      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const result = await resolveApiKeyForProvider({
        provider: "minimax",
        store: { version: 1, profiles: {} },
      });

      expect(result.apiKey).toBe("test-minimax-key-12345");
      expect(result.source).toBe("env: MINIMAX_API_KEY");
    } finally {
      if (previousMinimaxKey === undefined) {
        delete process.env.MINIMAX_API_KEY;
      } else {
        process.env.MINIMAX_API_KEY = previousMinimaxKey;
      }
    }
  });

  it("resolves MiniMax from auth profile with explicit profileId", async () => {
    const previousMinimaxKey = process.env.MINIMAX_API_KEY;

    try {
      delete process.env.MINIMAX_API_KEY;

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      // Use explicit profileId parameter to bypass order resolution
      // Note: auth profile store uses `key` for api_key type, not `apiKey`
      const result = await resolveApiKeyForProvider({
        provider: "minimax",
        profileId: "minimax:default",
        store: {
          version: 1,
          profiles: {
            "minimax:default": {
              type: "api_key",
              provider: "minimax",
              key: "profile-minimax-key",
            },
          },
        },
      });

      expect(result.apiKey).toBe("profile-minimax-key");
      expect(result.source).toBe("profile:minimax:default");
    } finally {
      if (previousMinimaxKey === undefined) {
        delete process.env.MINIMAX_API_KEY;
      } else {
        process.env.MINIMAX_API_KEY = previousMinimaxKey;
      }
    }
  });

  it("throws when MiniMax API key is missing (no env, no profile)", async () => {
    const previousMinimaxKey = process.env.MINIMAX_API_KEY;

    try {
      delete process.env.MINIMAX_API_KEY;

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      let error: unknown = null;
      try {
        await resolveApiKeyForProvider({
          provider: "minimax",
          store: { version: 1, profiles: {} },
        });
      } catch (err) {
        error = err;
      }

      expect(String(error)).toContain(
        'No API key found for provider "minimax".',
      );
    } finally {
      if (previousMinimaxKey === undefined) {
        delete process.env.MINIMAX_API_KEY;
      } else {
        process.env.MINIMAX_API_KEY = previousMinimaxKey;
      }
    }
  });
});
