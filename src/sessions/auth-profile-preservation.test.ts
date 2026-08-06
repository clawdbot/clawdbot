import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { shouldPreserveSessionAuthProfileOverride } from "./auth-profile-preservation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const workspaceAliasPlugin = {
  id: "fixture-provider",
  channels: [],
  providers: ["fixture-provider", "fixture-provider-plan"],
  cliBackends: [],
  skills: [],
  hooks: [],
  origin: "workspace",
  rootDir: "/plugins/fixture-provider",
  source: "test",
  manifestPath: "/plugins/fixture-provider/openclaw.plugin.json",
  providerAuthAliases: { "fixture-provider-plan": "fixture-provider" },
} satisfies PluginManifestRecord;

const metadataSnapshot = {
  plugins: [workspaceAliasPlugin],
} satisfies Pick<PluginMetadataSnapshot, "plugins">;

const entry = {
  sessionId: "session-auth-profile-preservation",
  updatedAt: 1,
  authProfileOverride: "fixture-provider:work",
} satisfies SessionEntry;

describe("shouldPreserveSessionAuthProfileOverride", () => {
  it("uses config trust when resolving workspace provider aliases", () => {
    const allowedConfig = {
      plugins: { entries: { "fixture-provider": { enabled: true } } },
    } satisfies OpenClawConfig;

    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: allowedConfig,
        agentDir: "/tmp/openclaw-auth-profile-preservation-allowed",
        entry,
        currentProvider: "fixture-provider",
        provider: "fixture-provider-plan",
        metadataSnapshot,
      }),
    ).toBe(true);
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        agentDir: "/tmp/openclaw-auth-profile-preservation-denied",
        entry,
        currentProvider: "fixture-provider",
        provider: "fixture-provider-plan",
        metadataSnapshot,
      }),
    ).toBe(false);
  });

  it("uses the recorded provider for an arbitrary stored profile id", () => {
    const agentDir = tempDirs.make("openclaw-auth-profile-preservation-");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "team:prod": { type: "api_key", provider: "openai", key: "test" },
        },
      },
      agentDir,
    );

    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        agentDir,
        entry: { ...entry, authProfileOverride: "team:prod" },
        currentProvider: "openai",
        provider: "openai",
      }),
    ).toBe(true);
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {},
        agentDir,
        entry: { ...entry, authProfileOverride: "team:prod" },
        currentProvider: "openai",
        provider: "anthropic",
      }),
    ).toBe(false);
  });

  it("uses the configured provider for an arbitrary profile id", () => {
    expect(
      shouldPreserveSessionAuthProfileOverride({
        cfg: {
          auth: { profiles: { "team:prod": { provider: "openai", mode: "api_key" } } },
        },
        agentDir: tempDirs.make("openclaw-auth-profile-config-"),
        entry: { ...entry, authProfileOverride: "team:prod" },
        currentProvider: "openai",
        provider: "openai",
      }),
    ).toBe(true);
  });
});
