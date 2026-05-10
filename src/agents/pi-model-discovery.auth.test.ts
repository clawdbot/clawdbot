import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import { resolvePiCredentialMapFromStore } from "./pi-auth-credentials.js";
import {
  addEnvBackedPiCredentials,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
} from "./pi-auth-discovery-core.js";
import { discoverAuthStorage } from "./pi-model-discovery.js";

vi.mock("./model-auth-env-vars.js", () => ({
  listProviderEnvAuthLookupKeys: () => ["mistral", "workspace-cloud"],
  resolveProviderEnvApiKeyCandidates: () => ({
    mistral: ["MISTRAL_API_KEY"],
  }),
  resolveProviderEnvAuthEvidence: () => ({
    "workspace-cloud": [
      {
        type: "local-file-with-env",
        credentialMarker: "workspace-cloud-local-credentials",
        source: "workspace cloud credentials",
      },
    ],
  }),
}));

vi.mock("./model-auth-env.js", () => ({
  resolveEnvApiKey: (
    provider: string,
    env: NodeJS.ProcessEnv,
    options?: { workspaceDir?: string },
  ) => {
    if (provider === "mistral" && env.MISTRAL_API_KEY?.trim()) {
      return { apiKey: env.MISTRAL_API_KEY, source: "env: MISTRAL_API_KEY" };
    }
    if (provider === "workspace-cloud" && options?.workspaceDir === "/tmp/workspace") {
      return {
        apiKey: "workspace-cloud-local-credentials",
        source: "workspace cloud credentials",
      };
    }
    return null;
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

async function writeAuthProfilesJson(agentDir: string, store: AuthProfileStore): Promise<void> {
  await fs.writeFile(path.join(agentDir, "auth-profiles.json"), JSON.stringify(store, null, 2));
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
    const codexCredential = credentials["openai-codex"] as
      | { type?: string; access?: string; refresh?: string }
      | undefined;
    expect(codexCredential?.type).toBe("oauth");
    expect(codexCredential?.access).toBe("oauth-access");
    expect(codexCredential?.refresh).toBe("oauth-refresh");
  });

  it("keeps keyRef and tokenRef profiles visible only for read-only pi discovery", () => {
    const credentials = resolvePiCredentialMapFromStore({
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          keyRef: { source: "exec", provider: "keychain", id: "OPENROUTER_API_KEY" },
        },
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_AUTH_TOKEN" },
        },
        "expired:default": {
          type: "token",
          provider: "expired",
          tokenRef: { source: "env", provider: "default", id: "EXPIRED_AUTH_TOKEN" },
          expires: Date.now() - 1_000,
        },
      },
    });
    const discoveryCredentials = resolvePiCredentialMapFromStore(
      {
        version: 1,
        profiles: {
          "openrouter:default": {
            type: "api_key",
            provider: "openrouter",
            keyRef: { source: "exec", provider: "keychain", id: "OPENROUTER_API_KEY" },
          },
          "anthropic:default": {
            type: "token",
            provider: "anthropic",
            tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_AUTH_TOKEN" },
          },
          "expired:default": {
            type: "token",
            provider: "expired",
            tokenRef: { source: "env", provider: "default", id: "EXPIRED_AUTH_TOKEN" },
            expires: Date.now() - 1_000,
          },
        },
      },
      { includeSecretRefPlaceholders: true },
    );

    expect(credentials.openrouter).toBeUndefined();
    expect(credentials.anthropic).toBeUndefined();
    expect(discoveryCredentials.openrouter?.type).toBe("api_key");
    expect(discoveryCredentials.anthropic?.type).toBe("api_key");
    expect(discoveryCredentials.expired).toBeUndefined();
  });

  it("marks keyRef-only auth profiles configured for read-only model discovery", async () => {
    await withAgentDir(async (agentDir) => {
      await writeAuthProfilesJson(agentDir, {
        version: 1,
        profiles: {
          "fixture-ref-provider:default": {
            type: "api_key",
            provider: "fixture-ref-provider",
            keyRef: { source: "exec", provider: "keychain", id: "FIXTURE_API_KEY" },
          },
        },
      });

      const readOnlyStorage = discoverAuthStorage(agentDir, {
        readOnly: true,
        skipExternalAuthProfiles: true,
        env: {},
      });
      const runtimeStorage = discoverAuthStorage(agentDir, {
        skipExternalAuthProfiles: true,
        env: {},
      });

      expect(readOnlyStorage.hasAuth("fixture-ref-provider")).toBe(true);
      expect(runtimeStorage.hasAuth("fixture-ref-provider")).toBe(false);
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
      const codexEntry = parsed["openai-codex"] as { type?: string; access?: string } | undefined;
      expect(codexEntry?.type).toBe("oauth");
      expect(codexEntry?.access).toBe("oauth-access");
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
        const openrouterEntry = parsed.openrouter as { type?: string; key?: string } | undefined;
        expect(openrouterEntry?.type).toBe("api_key");
        expect(openrouterEntry?.key).toBe("legacy-static-key");
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_AUTH_STORE_READONLY;
        } else {
          process.env.OPENCLAW_AUTH_STORE_READONLY = previous;
        }
      }
    });
  });

  it("includes env-backed provider auth when no auth profile exists", () => {
    const previousMistral = process.env.MISTRAL_API_KEY;
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const previousDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.MISTRAL_API_KEY = "mistral-env-test-key";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    try {
      const credentials = addEnvBackedPiCredentials({}, { env: process.env });

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

  it("includes workspace-scoped auth evidence in pi discovery credentials", () => {
    const credentials = addEnvBackedPiCredentials(
      {},
      {
        env: {},
        workspaceDir: "/tmp/workspace",
      },
    );

    expect(credentials["workspace-cloud"]).toEqual({
      type: "api_key",
      key: "workspace-cloud-local-credentials",
    });
  });
});
