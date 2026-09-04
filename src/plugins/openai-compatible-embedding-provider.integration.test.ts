import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthProfileMigrationRequired } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import {
  closeAuthProfileReadPool,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  resolveApiKeyForProviderCore,
  resolveScopedAuthProfileStore,
} from "../agents/model-auth-provider.js";
import { UnresolvedSecretInputError } from "../config/types.secrets.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getEmbeddingProvider } from "./embedding-provider-runtime.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-provider-types.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

describe("OpenAI-compatible embedding destination credential ownership", () => {
  const vector = [0.25, 0.5, 0.75];
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ url?: string; headers: IncomingHttpHeaders }>;

  beforeEach(async () => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    vi.stubEnv("OPENCLAW_TEST_EMBEDDING_LITERAL_KEY", "ambient-key-bait");
    vi.stubEnv("OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER", "ambient-header-bait");
    requests = [];
    server = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        requests.push({ url: request.url, headers: request.headers });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ index: 0, embedding: vector }] }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("embedding fixture did not expose a TCP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function createOptions(params: {
    providerOwnsDestination?: boolean;
    providerBaseUrl?: string;
    providerApiKey?: NonNullable<EmbeddingProviderCreateOptions["remote"]>["apiKey"];
    remote: NonNullable<EmbeddingProviderCreateOptions["remote"]>;
  }): EmbeddingProviderCreateOptions & { provider: string } {
    return {
      config: {
        models: {
          providers: {
            "tenant-embeddings": {
              api: "openai-completions",
              baseUrl:
                params.providerBaseUrl ??
                (params.providerOwnsDestination ? baseUrl : "https://provider.example.test/v1"),
              apiKey: params.providerApiKey ?? "synthetic-provider-key",
              headers: { "X-Provider-Tenant": "provider-tenant", "X-Shared": "provider-value" },
              models: [],
            },
          },
        },
      },
      provider: "tenant-embeddings",
      model: "tenant-embeddings/fixture-model",
      remote: { baseUrl, ...params.remote },
    };
  }

  it.each<{
    name: string;
    providerOwnsDestination?: boolean;
    queryDistinctDestination?: boolean;
    remote: NonNullable<EmbeddingProviderCreateOptions["remote"]>;
    authorization: string | undefined;
    expectedHeaders: Record<string, string>;
  }>([
    {
      name: "provider-owned destination receives provider credentials and remote precedence",
      providerOwnsDestination: true,
      remote: { headers: { "X-Shared": "remote-value" } },
      authorization: "Bearer synthetic-provider-key",
      expectedHeaders: { "x-provider-tenant": "provider-tenant", "x-shared": "remote-value" },
    },
    {
      name: "destination-owned Authorization takes precedence over the provider API key",
      providerOwnsDestination: true,
      remote: { headers: { Authorization: "Bearer synthetic-remote-header" } },
      authorization: "Bearer synthetic-remote-header",
      expectedHeaders: { "x-provider-tenant": "provider-tenant", "x-shared": "provider-value" },
    },
    {
      name: "different destination receives only remote-owned credentials",
      remote: { apiKey: "synthetic-remote-key", headers: { "X-Remote-Tenant": "remote-tenant" } },
      authorization: "Bearer synthetic-remote-key",
      expectedHeaders: { "x-remote-tenant": "remote-tenant" },
    },
    {
      name: "query-distinct destination preserves its tenant and excludes provider credentials",
      queryDistinctDestination: true,
      remote: { apiKey: "synthetic-remote-key", headers: { "X-Remote-Tenant": "remote-tenant" } },
      authorization: "Bearer synthetic-remote-key",
      expectedHeaders: { "x-remote-tenant": "remote-tenant" },
    },
    {
      name: "different destination accepts its own explicit Authorization header",
      remote: { headers: { Authorization: "Bearer synthetic-remote-header" } },
      authorization: "Bearer synthetic-remote-header",
      expectedHeaders: {},
    },
    {
      name: "different destination accepts its own API key header",
      remote: { headers: { "api-key": "synthetic-destination-key" } },
      authorization: undefined,
      expectedHeaders: { "api-key": "synthetic-destination-key" },
    },
    {
      name: "different destination may be intentionally unauthenticated",
      remote: {},
      authorization: undefined,
      expectedHeaders: {},
    },
    {
      name: "explicit remote Authorization takes precedence over a simultaneous remote API key",
      remote: {
        apiKey: "synthetic-ignored-remote-key",
        headers: { Authorization: "Custom synthetic-remote-header" },
      },
      authorization: "Custom synthetic-remote-header",
      expectedHeaders: {},
    },
    {
      name: "resolved template-looking remote credentials reach HTTP literally",
      remote: {
        apiKey: "${OPENCLAW_TEST_EMBEDDING_LITERAL_KEY}",
        headers: { "X-Literal": "$OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER" },
      },
      authorization: "Bearer ${OPENCLAW_TEST_EMBEDDING_LITERAL_KEY}",
      expectedHeaders: { "x-literal": "$OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER" },
    },
  ])(
    "$name",
    async ({
      providerOwnsDestination,
      queryDistinctDestination,
      remote,
      authorization,
      expectedHeaders,
    }) => {
      const result = await openAICompatibleEmbeddingProviderAdapter.create(
        createOptions({
          providerOwnsDestination,
          ...(queryDistinctDestination ? { providerBaseUrl: `${baseUrl}?tenant=provider` } : {}),
          remote: queryDistinctDestination
            ? { ...remote, baseUrl: `${baseUrl}?tenant=remote` }
            : remote,
        }),
      );

      await expect(result.provider?.embed("hello")).resolves.toEqual(vector);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: `/v1/embeddings${queryDistinctDestination ? "?tenant=remote" : ""}`,
        headers: expectedHeaders,
      });
      expect(requests[0]?.headers.authorization).toBe(authorization);
      if (!providerOwnsDestination) {
        expect(requests[0]?.headers).not.toHaveProperty("x-provider-tenant");
        expect(requests[0]?.headers).not.toHaveProperty("x-shared");
      }
    },
  );

  it("uses a literal provider key without selecting an agent owner", async () => {
    const options = createOptions({ providerOwnsDestination: true, remote: {} });
    options.config.agents = {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
    };
    const result = await openAICompatibleEmbeddingProviderAdapter.create(options);

    await expect(result.provider?.embed("hello")).resolves.toEqual(vector);
    expect(requests[0]?.headers.authorization).toBe("Bearer synthetic-provider-key");
  });

  it.each([false, true])(
    "keeps metadata-only profile names literal with owned store = %s",
    async (ownedStore) => {
      const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-embedding-metadata-"));
      const profileId = "tenant-embeddings:metadata-only";
      try {
        const options = createOptions({
          providerOwnsDestination: true,
          providerApiKey: profileId,
          remote: {},
        });
        options.config.agents = {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        };
        options.config.auth = {
          profiles: { [profileId]: { provider: "tenant-embeddings", mode: "api_key" } },
        };
        if (ownedStore) {
          writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
          options.agentDir = agentDir;
          const authParams = { cfg: options.config, provider: options.provider, agentDir };
          const store = resolveScopedAuthProfileStore(authParams);
          expect(store.profiles[profileId]).toBeUndefined();
          await expect(
            resolveApiKeyForProviderCore({ ...authParams, store }),
          ).resolves.toMatchObject({
            apiKey: profileId,
          });
        }
        const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
        await expect(result.provider?.embed("hello")).resolves.toEqual(vector);
        expect(requests[0]?.headers.authorization).toBe(`Bearer ${profileId}`);
      } finally {
        closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
        closeOpenClawAgentDatabases(agentDir);
        await rm(agentDir, { force: true, recursive: true });
      }
    },
  );

  it.each([
    { cache: "cold", populated: false },
    { cache: "warm", populated: false },
    { cache: "warm", populated: true },
  ])(
    "honors recreated legacy auth with $cache cache and populated SQLite = $populated",
    async ({ cache, populated }) => {
      await withOpenClawTestState(
        { layout: "state-only", label: "embedding-auth-migration" },
        async (state) => {
          const agentDir = state.agentDir("worker");
          const profileId = "tenant-embeddings:restored";
          const credential: AuthProfileCredential = {
            type: "api_key",
            provider: "tenant-embeddings",
            key: "synthetic-canonical-profile-key",
          };
          const store: AuthProfileStore = {
            version: 1,
            profiles: populated ? { [profileId]: credential } : {},
          };
          try {
            writePersistedAuthProfileStoreRaw(store, agentDir);
            clearRuntimeAuthProfileStoreSnapshots();
            if (cache === "warm") {
              setRuntimeAuthProfileStoreSnapshot(store, agentDir);
            }
            await state.writeJson("agents/worker/agent/auth-profiles.json", {
              version: 1,
              profiles: {
                [profileId]: { ...credential, key: "synthetic-restored-profile-key" },
              },
            });
            const options = createOptions({
              providerOwnsDestination: true,
              providerApiKey: profileId,
              remote: {},
            });
            options.agentDir = agentDir;
            const embed = async () => {
              const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
              return await result.provider?.embed("hello");
            };
            if (populated) {
              await expect(embed()).resolves.toEqual(vector);
              expect(requests).toHaveLength(1);
              expect(requests[0]?.headers.authorization).toBe(
                "Bearer synthetic-canonical-profile-key",
              );
            } else {
              await expect.soft(embed()).rejects.toMatchObject({
                code: "AUTH_PROFILE_MIGRATION_REQUIRED",
                action: "openclaw doctor --fix",
              });
              expect(requests).toEqual([]);
            }
          } finally {
            clearAuthProfileMigrationRequired(agentDir);
            clearRuntimeAuthProfileStoreSnapshots();
            closeOpenClawAgentDatabases(agentDir);
          }
        },
      );
    },
  );

  it.each(
    (["openai", "tenant-embeddings"] as const).flatMap((provider) =>
      (["openai-responses", "openai-completions"] as const).flatMap((api) =>
        (["api_key", "token"] as const).map((credentialType) => ({
          provider,
          api,
          credentialType,
        })),
      ),
    ),
  )(
    "enforces $provider/$api $credentialType profile auth with plugins disabled",
    async ({ provider, api, credentialType }) => {
      const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-embedding-auth-mode-"));
      const profileId = `${provider}:bound`;
      const credential: AuthProfileCredential =
        credentialType === "api_key"
          ? { type: credentialType, provider, key: "synthetic-bound-profile-key" }
          : { type: credentialType, provider, token: "synthetic-bound-profile-key" };
      try {
        writePersistedAuthProfileStoreRaw(
          { version: 1, profiles: { [profileId]: credential } },
          agentDir,
        );
        const options: EmbeddingProviderCreateOptions = {
          config: {
            plugins: { enabled: false },
            models: {
              providers: { [provider]: { api, baseUrl, apiKey: profileId, models: [] } },
            },
          },
          agentDir,
          provider,
          model: "fixture-model",
        };
        const adapter = getEmbeddingProvider(provider, options.config);
        expect(adapter).toBe(openAICompatibleEmbeddingProviderAdapter);
        const embed = async () => {
          const result = await adapter!.create(options);
          return await result.provider?.embed("hello");
        };
        if (provider === "openai" && credentialType === "token") {
          await expect.soft(embed()).rejects.toThrow(/requires an OpenAI API key profile/);
          expect(requests).toEqual([]);
        } else {
          await expect(embed()).resolves.toEqual(vector);
          expect(requests).toHaveLength(1);
          expect(requests[0]?.headers.authorization).toBe("Bearer synthetic-bound-profile-key");
        }
      } finally {
        closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
        closeOpenClawAgentDatabases(agentDir);
        await rm(agentDir, { force: true, recursive: true });
      }
    },
  );

  it.each(
    (["bearer control", "AWS override", "AWS order"] as const).flatMap((route) =>
      (["compatible", "incompatible", "unresolved"] as const).map((binding) => ({
        route,
        binding,
      })),
    ),
  )("keeps $binding profile bindings terminal with $route", async ({ route, binding }) => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-embedding-binding-"));
    const profileId = "tenant-embeddings:bound";
    const credential: AuthProfileCredential = {
      type: "api_key",
      provider: binding === "incompatible" ? "other-tenant" : "tenant-embeddings",
      ...(binding === "unresolved" ? {} : { key: "synthetic-bound-profile-key" }),
    };
    try {
      writePersistedAuthProfileStoreRaw(
        { version: 1, profiles: { [profileId]: credential } },
        agentDir,
      );
      const options = createOptions({
        providerOwnsDestination: true,
        providerApiKey: profileId,
        remote: {},
      });
      options.agentDir = agentDir;
      if (route !== "bearer control") {
        options.config.models!.providers![options.provider]!.auth = "aws-sdk";
      }
      if (route === "AWS order") {
        options.config.auth = {
          profiles: { "tenant-embeddings:aws": { provider: options.provider, mode: "aws-sdk" } },
          order: { [options.provider]: ["tenant-embeddings:aws"] },
        };
      }
      const embed = async () => {
        const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
        return await result.provider?.embed("hello");
      };
      if (binding === "compatible") {
        await expect(embed()).resolves.toEqual(vector);
        expect(requests[0]?.headers.authorization).toBe("Bearer synthetic-bound-profile-key");
      } else {
        await expect
          .soft(embed())
          .rejects.toThrow(
            binding === "incompatible"
              ? /not compatible with this provider entry's auth binding/
              : /matched a stored profile but failed to resolve/,
          );
        expect(requests).toEqual([]);
      }
    } finally {
      closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
      closeOpenClawAgentDatabases(agentDir);
      await rm(agentDir, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "profile reference",
      apiKey: "tenant-embeddings:default",
      authorization: "Bearer synthetic-profile-key",
    },
    {
      name: "literal key",
      apiKey: "synthetic-literal-key",
      authorization: "Bearer synthetic-literal-key",
    },
    { name: "empty key", apiKey: "", authorization: undefined },
    { name: "whitespace key", apiKey: "   ", authorization: undefined },
    { name: "omitted key", apiKey: undefined, authorization: undefined },
  ])("preserves configured $name authentication at HTTP", async ({ apiKey, authorization }) => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-embedding-profile-"));
    const profileId = "tenant-embeddings:default";
    try {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "tenant-embeddings",
              key: "synthetic-profile-key",
            },
          },
        },
        agentDir,
      );
      const result = await openAICompatibleEmbeddingProviderAdapter.create({
        config: {
          auth: { profiles: { [profileId]: { provider: "tenant-embeddings", mode: "api_key" } } },
          agents: {
            ownership: "explicit",
            entries: { ops: {}, research: { agentDir } },
          },
          models: {
            providers: {
              "tenant-embeddings": {
                api: "openai-completions",
                baseUrl,
                apiKey,
                models: [],
              },
            },
          },
        },
        agentDir,
        provider: "tenant-embeddings",
        model: "tenant-embeddings/fixture-model",
      });

      await expect(result.provider?.embed("hello")).resolves.toEqual(vector);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe(authorization);
    } finally {
      closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
      closeOpenClawAgentDatabases(agentDir);
      await rm(agentDir, { force: true, recursive: true });
    }
  });

  it.each(["apiKey", "header", "providerApiKey"])(
    "rejects an unresolved %s before egress",
    async (field) => {
      vi.stubEnv("OPENCLAW_TEST_EMBEDDING_UNRESOLVED_SECRET", "ambient-secret-bait");
      const ref = {
        source: "env" as const,
        provider: "default",
        id: "OPENCLAW_TEST_EMBEDDING_UNRESOLVED_SECRET",
      };
      const remote: NonNullable<EmbeddingProviderCreateOptions["remote"]> =
        field === "apiKey"
          ? { apiKey: ref }
          : { apiKey: "synthetic-remote-key", headers: { "X-Remote-Secret": "" } };
      if (field === "header") {
        Object.assign(remote.headers ?? {}, { "X-Remote-Secret": ref });
      }

      const options = createOptions({
        providerOwnsDestination: true,
        providerApiKey: field === "providerApiKey" ? ref : undefined,
        remote: field === "providerApiKey" ? {} : remote,
      });
      await expect
        .soft(async () => {
          const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
          await result.provider?.embed("hello");
        })
        .rejects.toBeInstanceOf(UnresolvedSecretInputError);
      expect(requests).toEqual([]);
    },
  );
});
