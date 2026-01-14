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
      const { ensureAuthProfileStore } = await import("./auth-profiles.js");
      const { getApiKeyForModel } = await import("./model-auth.js");

      const model = {
        id: "codex-mini-latest",
        provider: "openai-codex",
        api: "openai-codex-responses",
      } as Model<Api>;

      const store = ensureAuthProfileStore(process.env.CLAWDBOT_AGENT_DIR, {
        allowKeychainPrompt: false,
      });
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
        store,
        agentDir: process.env.CLAWDBOT_AGENT_DIR,
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

  it("accepts legacy Z_AI_API_KEY for zai", async () => {
    const previousZai = process.env.ZAI_API_KEY;
    const previousLegacy = process.env.Z_AI_API_KEY;

    try {
      delete process.env.ZAI_API_KEY;
      process.env.Z_AI_API_KEY = "zai-test-key";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const resolved = await resolveApiKeyForProvider({
        provider: "zai",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("zai-test-key");
      expect(resolved.source).toContain("Z_AI_API_KEY");
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

  it("resolves Synthetic API key from env", async () => {
    const previousSynthetic = process.env.SYNTHETIC_API_KEY;

    try {
      process.env.SYNTHETIC_API_KEY = "synthetic-test-key";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const resolved = await resolveApiKeyForProvider({
        provider: "synthetic",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("synthetic-test-key");
      expect(resolved.source).toContain("SYNTHETIC_API_KEY");
    } finally {
      if (previousSynthetic === undefined) {
        delete process.env.SYNTHETIC_API_KEY;
      } else {
        process.env.SYNTHETIC_API_KEY = previousSynthetic;
      }
    }
  });
});
