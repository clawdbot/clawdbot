import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createEnterpriseIdentityProviderAuthorityRegistry,
  resolveEnterpriseIdentityProviderAllowlist,
} from "./enterprise-identity-provider-authority-registry.js";
import type { EnterpriseIdentityProviderAdapter } from "./enterprise-identity-provider-types.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry(enterpriseIdentityProviderAllowlist: readonly string[]) {
  const enterpriseIdentityProviderAuthorityRegistry =
    createEnterpriseIdentityProviderAuthorityRegistry({
      operatorAllowlist: enterpriseIdentityProviderAllowlist,
    });
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
    enterpriseIdentityProviderAuthorityRegistry,
  });
}

function createRecord(id: string, enterpriseIdentityProviders?: readonly string[]) {
  return createPluginRecord({
    id,
    source: `/plugins/${id}/index.ts`,
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: enterpriseIdentityProviders
      ? { enterpriseIdentityProviders: [...enterpriseIdentityProviders] }
      : undefined,
  });
}

function createProvider(
  providerPrefix: string,
  authority = {
    issuer: `https://${providerPrefix}.example`,
    tenantId: `${providerPrefix}-tenant`,
  },
): EnterpriseIdentityProviderAdapter {
  return {
    providerPrefix,
    resolveAuthorizationCodeClientSecret: async () => "test-client-secret",
    authorities: [
      {
        ...authority,
        audiences: ["openclaw-memory-test"],
        jwksUri: `https://${providerPrefix}.example/keys`,
        algorithm: "RS256",
        tenantBinding: { kind: "claim", claim: "tid", value: authority.tenantId },
        assurance: { maxAuthenticationAgeMs: 60_000 },
        authorizationCodeFlow: {
          clientId: "openclaw-memory-test",
          authorizationEndpoint: `https://${providerPrefix}.example/authorize`,
          tokenEndpoint: `https://${providerPrefix}.example/token`,
          redirectUri: "https://gateway.example/memory/oidc/callback",
          scopes: ["openid"],
        },
        membership: {
          kind: "oidc-claim",
          claim: "groups",
          required: true,
          roleGroupIds: ["writers"],
          maxGroups: 200,
        },
        maxSnapshotAgeMs: 60_000,
      },
    ],
  };
}

describe("enterprise identity provider registry", () => {
  it("reads the dedicated operator allowlist from configuration", () => {
    expect(
      resolveEnterpriseIdentityProviderAllowlist({
        plugins: { enterpriseIdentityProviders: { allow: ["entra"] } },
      }),
    ).toEqual(["entra"]);
    expect(resolveEnterpriseIdentityProviderAllowlist({ plugins: {} })).toEqual([]);
  });

  it("requires the exact manifest declaration and operator allowlist", () => {
    const registry = createTestRegistry(["entra"]);

    registry.registerEnterpriseIdentityProvider(
      createRecord("undeclared"),
      createProvider("entra"),
    );
    registry.registerEnterpriseIdentityProvider(
      createRecord("mismatch", ["okta"]),
      createProvider("entra"),
    );
    registry.registerEnterpriseIdentityProvider(
      createRecord("unlisted", ["okta"]),
      createProvider("okta"),
    );

    expect(registry.registry.enterpriseIdentityProviders).toEqual([]);
    expect(registry.registry.diagnostics.map((entry) => entry.message)).toEqual([
      "plugin must declare contracts.enterpriseIdentityProviders for provider: entra",
      "plugin must declare contracts.enterpriseIdentityProviders for provider: entra",
      "enterprise identity provider is not operator-allowlisted: okta",
    ]);
  });

  it("accepts only HTTPS endpoints and the Gateway-owned OIDC callback path", () => {
    const registry = createTestRegistry(["entra"]);
    const provider = createProvider("entra");
    const authority = provider.authorities[0]!;
    const invalidCallbackProvider: EnterpriseIdentityProviderAdapter = {
      ...provider,
      authorities: [
        {
          ...authority,
          authorizationCodeFlow: {
            ...authority.authorizationCodeFlow,
            redirectUri: "https://gateway.example/other/callback",
          },
        },
      ],
    };

    registry.registerEnterpriseIdentityProvider(
      createRecord("entra-plugin", ["entra"]),
      invalidCallbackProvider,
    );

    expect(registry.registry.enterpriseIdentityProviders).toEqual([]);
    expect(registry.registry.diagnostics.at(-1)?.message).toBe(
      "enterprise identity provider has an invalid issuer or tenant authority: entra",
    );
  });

  it("rejects providers that cannot authenticate the confidential code exchange", () => {
    const registry = createTestRegistry(["entra"]);
    registry.registerEnterpriseIdentityProvider(createRecord("entra-plugin", ["entra"]), {
      ...createProvider("entra"),
      resolveAuthorizationCodeClientSecret: undefined,
    });

    expect(registry.registry.enterpriseIdentityProviders).toEqual([]);
    expect(registry.registry.diagnostics.at(-1)?.message).toBe(
      "enterprise identity provider has an invalid issuer or tenant authority: entra",
    );
  });

  it("retains provenance while refusing duplicate prefixes and issuer-tenant authorities", () => {
    const registry = createTestRegistry(["entra", "okta"]);
    const first = createRecord("entra-plugin", ["entra"]);
    registry.registerEnterpriseIdentityProvider(first, createProvider("entra"));

    registry.registerEnterpriseIdentityProvider(
      createRecord("duplicate-prefix", ["entra"]),
      createProvider("entra", { issuer: "https://other.example", tenantId: "other" }),
    );
    registry.registerEnterpriseIdentityProvider(
      createRecord("duplicate-authority", ["okta"]),
      createProvider("okta", { issuer: "https://entra.example", tenantId: "entra-tenant" }),
    );

    expect(registry.registry.enterpriseIdentityProviders).toHaveLength(1);
    expect(registry.registry.enterpriseIdentityProviders[0]).toMatchObject({
      pluginId: "entra-plugin",
      source: "/plugins/entra-plugin/index.ts",
      provider: { providerPrefix: "entra" },
    });
    expect(registry.registry.diagnostics.map((entry) => entry.message)).toEqual([
      "enterprise identity provider already registered: entra",
      "enterprise identity authority already registered: https://entra.example (entra-tenant) by entra-plugin",
    ]);
  });

  it("is exposed through the plugin API, but seals before a later registration", () => {
    const registry = createTestRegistry(["entra", "okta"]);
    const record = createRecord("entra-plugin", ["entra"]);
    registry
      .createApi(record, { config: {} as OpenClawConfig })
      .registerEnterpriseIdentityProvider(createProvider("entra"));
    registry.sealEnterpriseIdentityProviderRegistry();
    registry.registerEnterpriseIdentityProvider(
      createRecord("okta-plugin", ["okta"]),
      createProvider("okta"),
    );

    expect(registry.registry.enterpriseIdentityProviders).toHaveLength(1);
    expect(registry.registry.enterpriseIdentityProviders[0]?.provider).not.toHaveProperty(
      "createPrincipal",
    );
    expect(registry.registry.enterpriseIdentityProviderAuthorityRegistry.isSealed()).toBe(true);
    expect(registry.registry.diagnostics.at(-1)?.message).toBe(
      "enterprise identity provider registry is sealed after startup",
    );
  });

  it("keeps the core-owned authority snapshot sealed across registry replacement", () => {
    const authorityRegistry = createEnterpriseIdentityProviderAuthorityRegistry({
      operatorAllowlist: ["entra"],
    });
    const previous = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
      enterpriseIdentityProviderAuthorityRegistry: authorityRegistry,
    });
    previous.registerEnterpriseIdentityProvider(
      createRecord("entra-plugin", ["entra"]),
      createProvider("entra"),
    );
    previous.sealEnterpriseIdentityProviderRegistry();

    const replacement = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
      enterpriseIdentityProviderAuthorityRegistry: authorityRegistry,
    });
    replacement.registerEnterpriseIdentityProvider(
      createRecord("replacement-entra-plugin", ["entra"]),
      createProvider("entra"),
    );

    expect(previous.registry.enterpriseIdentityProviders).toHaveLength(1);
    expect(replacement.registry.enterpriseIdentityProviders).toHaveLength(1);
    expect(replacement.registry.enterpriseIdentityProviders[0]?.pluginId).toBe("entra-plugin");
    expect(replacement.registry.diagnostics.at(-1)?.message).toBe(
      "enterprise identity provider registry is sealed after startup",
    );
  });

  it("publishes a frozen copy so generic reload rollback cannot erase authority", () => {
    const authorityRegistry = createEnterpriseIdentityProviderAuthorityRegistry({
      operatorAllowlist: ["entra"],
    });
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
      enterpriseIdentityProviderAuthorityRegistry: authorityRegistry,
    });
    registry.registerEnterpriseIdentityProvider(
      createRecord("entra-plugin", ["entra"]),
      createProvider("entra"),
    );
    registry.sealEnterpriseIdentityProviderRegistry();
    registry.registry.enterpriseIdentityProviders.splice(0);

    expect(authorityRegistry.providers).toHaveLength(1);
    expect(Object.isFrozen(authorityRegistry.providers)).toBe(true);
  });

  it("deep-copies nested authority policy so a plugin cannot mutate the sealed trust boundary", () => {
    const authorityRegistry = createEnterpriseIdentityProviderAuthorityRegistry({
      operatorAllowlist: ["entra"],
    });
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
      enterpriseIdentityProviderAuthorityRegistry: authorityRegistry,
    });
    const provider = createProvider("entra");
    registry.registerEnterpriseIdentityProvider(createRecord("entra-plugin", ["entra"]), provider);
    registry.sealEnterpriseIdentityProviderRegistry();

    (provider.authorities[0]!.authorizationCodeFlow.scopes as string[]).push("profile");
    const sealed = authorityRegistry.providers[0]!.provider.authorities[0]!;
    expect(sealed.authorizationCodeFlow.scopes).toEqual(["openid"]);
    expect(Object.isFrozen(sealed.authorizationCodeFlow.scopes)).toBe(true);
    expect(Object.isFrozen(sealed.membership)).toBe(true);
  });
});
