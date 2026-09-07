import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applyModelOverrideWithAuthProfileCompatibility,
  shouldPreserveSessionAuthProfileOverride,
} from "./auth-profile-preservation.js";

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
  it.each([
    { credentialProvider: "arcee", expected: false },
    { credentialProvider: "openrouter", expected: true },
  ])(
    "checks a pin's stored $credentialProvider realm against the configured endpoint",
    ({ credentialProvider, expected }) => {
      const plugin: PluginManifestRecord = {
        ...workspaceAliasPlugin,
        id: "arcee",
        origin: "bundled",
        providers: ["arcee"],
        providerAuthAliases: {
          arcee: { provider: "openrouter", baseUrls: ["https://openrouter.ai/api/v1"] },
        },
      };
      expect(
        shouldPreserveSessionAuthProfileOverride({
          cfg: {
            models: {
              providers: { arcee: { baseUrl: "https://openrouter.ai/api/v1", models: [] } },
            },
            auth: { profiles: { "team:prod": { provider: credentialProvider, mode: "api_key" } } },
          },
          agentDir: tempDirs.make("openclaw-endpoint-profile-pin-"),
          entry: { ...entry, authProfileOverride: "team:prod" },
          currentProvider: "arcee",
          provider: "arcee",
          metadataSnapshot: { plugins: [plugin] },
        }),
      ).toBe(expected);
    },
  );

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

  it.each(["openai", "anthropic"])(
    "retains a missing personal pin only when the selected provider %s is compatible",
    async (provider) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const personalId = `personal:${randomUUID()}:${randomUUID()}`;
        const sessionEntry: SessionEntry = {
          ...entry,
          authProfileOverride: personalId,
          authProfileOverrideSource: "user-link",
        };

        applyModelOverrideWithAuthProfileCompatibility({
          cfg: {},
          agentDir: state.agentDir(),
          entry: sessionEntry,
          currentProvider: "openai",
          selection: { provider, model: "another-model" },
        });

        expect(sessionEntry.authProfileOverride).toBe(
          provider === "openai" ? personalId : undefined,
        );
        expect(sessionEntry.authProfileOverrideSource).toBe(
          provider === "openai" ? "user-link" : undefined,
        );
      });
    },
  );

  it.each([
    {
      name: "retains a compatible auth profile when resetting to a same-provider default",
      provider: "openai",
      model: "gpt-5",
      expectedProfile: "team:prod",
      expectedSource: "user" as const,
      expectedCompactionCount: 2,
    },
    {
      name: "clears an incompatible auth profile when resetting to a cross-provider default",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expectedProfile: undefined,
      expectedSource: undefined,
      expectedCompactionCount: undefined,
    },
  ])("$name", ({ provider, model, expectedProfile, expectedSource, expectedCompactionCount }) => {
    const sessionEntry = {
      ...entry,
      providerOverride: "openai",
      modelOverride: "gpt-4.1",
      modelOverrideSource: "user" as const,
      authProfileOverride: "team:prod",
      authProfileOverrideSource: "user" as const,
      authProfileOverrideCompactionCount: 2,
    };

    const result = applyModelOverrideWithAuthProfileCompatibility({
      cfg: {
        auth: { profiles: { "team:prod": { provider: "openai", mode: "api_key" } } },
      },
      agentDir: tempDirs.make("openclaw-auth-profile-default-"),
      entry: sessionEntry,
      currentProvider: "openai",
      selection: { provider, model, isDefault: true },
    });

    expect(result.updated).toBe(true);
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverride).toBe(expectedProfile);
    expect(sessionEntry.authProfileOverrideSource).toBe(expectedSource);
    expect(sessionEntry.authProfileOverrideCompactionCount).toBe(expectedCompactionCount);
  });
});
