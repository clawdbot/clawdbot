/** Tests synthetic auth fallback during agent model discovery. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveManifestNativeHarness } from "./prepared-model-runtime.synthetic-auth.js";

const resolveRuntimeSyntheticAuthProviderRefs = vi.hoisted(() => vi.fn(() => ["claude-cli"]));

const resolveProviderSyntheticAuthWithPlugin = vi.hoisted(() =>
  vi.fn((params: { provider: string }) =>
    params.provider === "claude-cli"
      ? {
          apiKey: "claude-cli-access-token",
          source: "Claude CLI native auth",
          mode: "oauth" as const,
        }
      : undefined,
  ),
);

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin,
}));

vi.mock("./auth-profiles/store.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
  ensureAuthProfileStoreWithoutExternalProfiles: () => ({ version: 1, profiles: {} }),
}));

vi.mock("./agent-auth-discovery-core.js", () => ({
  addEnvBackedAgentCredentials: (credentials: Record<string, unknown>) => ({ ...credentials }),
}));

let resolveAgentDiscoveryAuthFacts: typeof import("./agent-auth-discovery.js").resolveAgentDiscoveryAuthFacts;

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-synthetic-auth-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("agent model discovery synthetic auth", () => {
  beforeAll(async () => {
    ({ resolveAgentDiscoveryAuthFacts } = await import("./agent-auth-discovery.js"));
  });

  beforeEach(() => {
    resolveRuntimeSyntheticAuthProviderRefs.mockClear();
    resolveProviderSyntheticAuthWithPlugin.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mirrors plugin-owned synthetic cli auth into credential discovery", async () => {
    await withAgentDir(async (agentDir) => {
      const { credentials } = resolveAgentDiscoveryAuthFacts(agentDir, { readOnly: true });

      expect(resolveRuntimeSyntheticAuthProviderRefs).toHaveBeenCalledTimes(1);
      expect(resolveRuntimeSyntheticAuthProviderRefs).toHaveBeenCalledWith();
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledTimes(1);
      expect(resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith({
        provider: "claude-cli",
        config: undefined,
        workspaceDir: undefined,
        env: undefined,
        context: {
          config: undefined,
          provider: "claude-cli",
          providerConfig: undefined,
        },
      });
      expect(credentials.anthropic).toEqual({
        type: "api_key",
        key: "claude-cli-access-token",
      });
    });
  });

  it("does not enumerate synthetic auth for plugins that are not startup-active", () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "anthropic",
          providers: ["anthropic"],
          syntheticAuthRefs: ["anthropic"],
          activation: { onStartup: true },
        },
        {
          id: "llama-cpp",
          providers: ["llama-cpp"],
          syntheticAuthRefs: ["llama-cpp"],
          activation: { onStartup: false },
        },
      ],
    });

    expect(
      resolveManifestNativeHarness({
        config: {},
        env: {},
        metadataSnapshot,
        resolveRuntimes: false,
      }).providerIds,
    ).toEqual(["anthropic"]);
  });
});
