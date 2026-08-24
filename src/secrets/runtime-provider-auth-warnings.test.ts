/** Tests provider-auth warning projection during scoped credential refreshes. */
import { describe, expect, it } from "vitest";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import type { DegradedSecretOwner } from "./runtime-degraded-state.js";
import { mergeProviderAuthRuntimeWarnings } from "./runtime-provider-auth-warnings.js";
import type { SecretResolverWarning } from "./runtime-shared.js";

describe("provider-auth runtime warning projection", () => {
  const agentDir = "/tmp/agent";
  const profileId = "openai:default";
  const authPath = `${agentDir}.auth-profiles.${profileId}.key`;
  const providerPath = "models.providers.openai.apiKey";

  const warning = (
    path: string,
    message = "redacted fixture warning",
    code: SecretResolverWarning["code"] = "SECRETS_OWNER_UNAVAILABLE",
  ): SecretResolverWarning => ({ code, path, message });

  const owner = (
    ownerKind: DegradedSecretOwner["ownerKind"],
    ownerId: string,
    path: string,
  ): DegradedSecretOwner => ({
    ownerKind,
    ownerId,
    paths: [path],
    state: "unavailable",
    degradationState: "cold",
    refKeys: [],
    reason: "synthetic unavailable owner",
  });

  const snapshot = (warnings: SecretResolverWarning[], degradedOwners: DegradedSecretOwner[]) => ({
    sourceConfig: {
      models: {
        providers: {
          openai: { baseUrl: "https://provider.example.invalid/v1", models: [] },
        },
      },
    },
    authStores: [
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            [profileId]: { type: "api_key" as const, provider: "openai" },
          },
        },
      },
    ],
    degradedOwners,
    warnings,
  });

  it("replaces only provider-auth-owned warnings while preserving all plugin owner domains", () => {
    const pluginOwners = [
      {
        ownerKind: "plugin-route" as const,
        ownerId: "audit.auth-profiles.route:routes.main.token",
        path: "plugins.entries.audit.auth-profiles.route.config.routes.main.token",
      },
      {
        ownerKind: "plugin-capability" as const,
        ownerId: "audit:auth-profiles.capability",
        path: "plugins.entries.audit.config.auth-profiles.capability.token",
      },
      {
        ownerKind: "plugin-provider" as const,
        ownerId: "audit.auth-profiles.provider:provider",
        path: 'plugins.entries.audit.auth-profiles.provider.config.headers["X.Trace"]',
      },
    ];
    const pluginWarnings = pluginOwners.map(({ path, ownerKind }) =>
      warning(path, `active ${ownerKind} warning`),
    );
    const authOwnerId = resolveAuthProfileSecretOwnerId({ agentDir, profileId });

    expect(
      mergeProviderAuthRuntimeWarnings(
        snapshot(
          [
            warning(providerPath, "old provider warning"),
            warning(authPath, "old auth warning"),
            warning("channels.discord.accounts.ops.token", "active transport warning"),
            warning("plugins.entries.brave.config.webSearch.apiKey", "active web warning"),
            ...pluginWarnings,
          ],
          [
            owner("provider", "openai", providerPath),
            owner("account", authOwnerId, authPath),
            ...pluginOwners.map(({ ownerKind, ownerId, path }) => owner(ownerKind, ownerId, path)),
          ],
        ),
        snapshot(
          [
            warning(providerPath, "current provider warning"),
            warning(authPath, "current auth warning"),
            warning("channels.discord.accounts.ops.token", "discarded candidate warning"),
            warning(pluginOwners[0]!.path, "discarded candidate plugin warning"),
          ],
          [
            owner("provider", "openai", providerPath),
            owner("account", authOwnerId, authPath),
            owner(pluginOwners[0]!.ownerKind, pluginOwners[0]!.ownerId, pluginOwners[0]!.path),
          ],
        ),
      ),
    ).toEqual([
      warning("channels.discord.accounts.ops.token", "active transport warning"),
      warning("plugins.entries.brave.config.webSearch.apiKey", "active web warning"),
      ...pluginWarnings,
      warning(providerPath, "current provider warning"),
      warning(authPath, "current auth warning"),
    ]);
  });

  it("refreshes inactive and plaintext warnings using configured provider and auth facts", () => {
    const providerWarning = warning(
      "models.providers.openai.headers.X.Trace",
      "provider is disabled",
      "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
    );
    const authWarning = warning(
      authPath,
      "auth profile ignores plaintext",
      "SECRETS_REF_OVERRIDES_PLAINTEXT",
    );

    expect(
      mergeProviderAuthRuntimeWarnings(
        snapshot([providerWarning, authWarning], []),
        snapshot([providerWarning, authWarning], []),
      ),
    ).toEqual([providerWarning, authWarning]);
  });
});
