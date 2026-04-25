import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePiCredentialMapFromStore } from "./pi-auth-credentials.js";
import {
  addEnvBackedPiCredentials,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
} from "./pi-auth-discovery-core.js";

vi.mock("./model-auth-env-vars.js", () => ({
  resolveProviderEnvApiKeyCandidates: () => ({
    mistral: ["MISTRAL_API_KEY"],
  }),
}));

vi.mock("./model-auth-env.js", () => ({
  resolveEnvApiKey: (provider: string, env: NodeJS.ProcessEnv) => {
    if (provider !== "mistral" || !env.MISTRAL_API_KEY?.trim()) {
      return null;
    }
    return { apiKey: env.MISTRAL_API_KEY, source: "env: MISTRAL_API_KEY" };
  },
}));

async function createAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-auth-storage-"));
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await createAgentDir();
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function writeLegacyAuthJson(
  agentDir: string,
  authEntries: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(authEntries, null, 2));
}

async function readLegacyAuthJson(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("discoverAuthStorage", () => {
  it("converts runtime auth profiles into pi discovery credentials", () => {
    const credentials = resolvePiCredentialMapFromStore({
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-v1-runtime",
        },
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-runtime",
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      },
    });

    expect(credentials.openrouter).toEqual({
      type: "api_key",
      key: "sk-or-v1-runtime",
    });
    expect(credentials.anthropic).toEqual({
      type: "api_key",
      key: "sk-ant-runtime",
    });
    expect(credentials["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
    });
  });

  it("scrubs static api_key entries from legacy auth.json and keeps oauth entries", async () => {
    await withAgentDir(async (agentDir) => {
      await writeLegacyAuthJson(agentDir, {
        openrouter: { type: "api_key", key: "legacy-static-key" },
        "openai-codex": {
          type: "oauth",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });

      scrubLegacyStaticAuthJsonEntriesForDiscovery(path.join(agentDir, "auth.json"));

      const parsed = await readLegacyAuthJson(agentDir);
      expect(parsed.openrouter).toBeUndefined();
      expect(parsed["openai-codex"]).toMatchObject({
        type: "oauth",
        access: "oauth-access",
      });
    });
  });

  it("preserves legacy auth.json when auth store is forced read-only", async () => {
    await withAgentDir(async (agentDir) => {
      const previous = process.env.OPENCLAW_AUTH_STORE_READONLY;
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
      try {
        await writeLegacyAuthJson(agentDir, {
          openrouter: { type: "api_key", key: "legacy-static-key" },
        });

        scrubLegacyStaticAuthJsonEntriesForDiscovery(path.join(agentDir, "auth.json"));

        const parsed = await readLegacyAuthJson(agentDir);
        expect(parsed.openrouter).toMatchObject({ type: "api_key", key: "legacy-static-key" });
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_AUTH_STORE_READONLY;
        } else {
          process.env.OPENCLAW_AUTH_STORE_READONLY = previous;
        }
      }
    });
  });

  it("includes env-backed provider auth when no auth profile exists", async () => {
    const previousMistral = process.env.MISTRAL_API_KEY;
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const previousDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.MISTRAL_API_KEY = "mistral-env-test-key";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    try {
      const credentials = addEnvBackedPiCredentials({}, process.env);

      expect(credentials.mistral).toEqual({
        type: "api_key",
        key: "mistral-env-test-key",
      });
    } finally {
      if (previousMistral === undefined) {
        delete process.env.MISTRAL_API_KEY;
      } else {
        process.env.MISTRAL_API_KEY = previousMistral;
      }
      if (previousBundledPluginsDir === undefined) {
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      } else {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
      }
      if (previousDisableBundledPlugins === undefined) {
        delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      } else {
        process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundledPlugins;
      }
    }
  });
});
