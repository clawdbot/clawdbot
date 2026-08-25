/** Selected Google web-search headers share their provider's SecretRef owner. */
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWebSearchTool } from "../agents/tools/web-search.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
} from "./runtime-state.js";
import { prepareSecretsRuntimeSnapshot } from "./runtime.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const origins = new Map([
  ["brave", "bundled"],
  ["google", "bundled"],
] as const);

function createConfig(params: {
  provider?: "brave" | "gemini";
  enabled?: boolean;
  headers?: Record<string, unknown>;
  googleBaseUrl?: string;
  otherBaseUrl?: string;
  searchBaseUrl?: string;
}): OpenClawConfig {
  return {
    agents: { list: [{ id: "main", default: true }] },
    ...(params.googleBaseUrl || params.otherBaseUrl
      ? {
          models: {
            providers: {
              ...(params.googleBaseUrl
                ? { google: { baseUrl: params.googleBaseUrl, models: [] } }
                : {}),
              ...(params.otherBaseUrl
                ? { openai: { baseUrl: params.otherBaseUrl, models: [] } }
                : {}),
            },
          },
        }
      : {}),
    tools: {
      web: {
        search: {
          ...(params.provider ? { provider: params.provider } : {}),
          ...(params.enabled === false ? { enabled: false } : {}),
        },
      },
    },
    plugins: {
      entries: {
        brave: { enabled: true, config: { webSearch: { apiKey: "brave-fixture-key" } } },
        google: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: envRef("GOOGLE_SEARCH_API_REF"),
              headers: params.headers ?? { "X.Routing.Token": envRef("GOOGLE_ROUTING_REF") },
              ...(params.searchBaseUrl ? { baseUrl: params.searchBaseUrl } : {}),
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function prepare(config: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  return prepareSecretsRuntimeSnapshot({
    config,
    env,
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: origins,
  });
}

function readGoogleConfig(config: OpenClawConfig) {
  return config.plugins?.entries?.google?.config as {
    webSearch: { apiKey: unknown; headers: Record<string, unknown> };
  };
}

afterEach(() => clearSecretsRuntimeSnapshotState());

describe("Google web-search supplemental SecretRefs", () => {
  it("resolves dotted headers into the selected API-key owner's single ref set", async () => {
    const headerValue = "google-routing-secret-value";
    const snapshot = await prepare(createConfig({ provider: "gemini" }), {
      GOOGLE_SEARCH_API_REF: "google-api-secret-value",
      GOOGLE_ROUTING_REF: headerValue,
    });

    expect(snapshot.webTools.search.selectedProvider).toBe("gemini");
    expect(readGoogleConfig(snapshot.config).webSearch).toEqual({
      apiKey: "google-api-secret-value",
      headers: { "X.Routing.Token": headerValue },
    });
    expect(snapshot.secretOwners?.filter((owner) => owner.ownerId === "web-search:gemini")).toEqual(
      [
        expect.objectContaining({
          ownerKind: "capability",
          refKeys: ["env:default:GOOGLE_ROUTING_REF", "env:default:GOOGLE_SEARCH_API_REF"],
          resolvedValues: expect.arrayContaining([
            { refKey: "env:default:GOOGLE_ROUTING_REF", value: headerValue },
            { refKey: "env:default:GOOGLE_SEARCH_API_REF", value: "google-api-secret-value" },
          ]),
        }),
      ],
    );
    expect(isSecretValueRegisteredForRedaction(headerValue)).toBe(true);
  });

  it.each([
    { label: "explicit Brave", provider: "brave" as const, selected: "brave" },
    { label: "auto-detected Brave", provider: undefined, selected: "brave" },
    { label: "disabled search", provider: "gemini" as const, enabled: false, selected: undefined },
  ])(
    "does not resolve inactive Google headers for $label",
    async ({ provider, enabled, selected }) => {
      const snapshot = await prepare(createConfig({ provider, enabled }));

      expect(snapshot.webTools.search.selectedProvider).toBe(selected);
      expect(snapshot.degradedOwners).toEqual([]);
      expect(readGoogleConfig(snapshot.config).webSearch.headers["X.Routing.Token"]).toEqual(
        envRef("GOOGLE_ROUTING_REF"),
      );
    },
  );

  it("ignores missing provider-owned header refs before resolution", async () => {
    const snapshot = await prepare(
      createConfig({
        provider: "gemini",
        headers: {
          "X-Goog-Api-Key": envRef("MISSING_IGNORED_GOOGLE_API_KEY"),
          "x-GOOG-api-client": envRef("MISSING_IGNORED_GOOGLE_API_CLIENT"),
          "Content-Type": envRef("MISSING_IGNORED_CONTENT_TYPE"),
        },
      }),
      { GOOGLE_SEARCH_API_REF: "google-api-secret-value" },
    );

    expect(snapshot.webTools.search.selectedProvider).toBe("gemini");
    expect(snapshot.degradedOwners).toEqual([]);
    expect(snapshot.secretOwners).toEqual([
      expect.objectContaining({
        ownerId: "web-search:gemini",
        refKeys: ["env:default:GOOGLE_SEARCH_API_REF"],
      }),
    ]);
  });

  it("isolates an unavailable selected header without credential fallback", async () => {
    const snapshot = await prepare(createConfig({ provider: "gemini" }), {
      GOOGLE_SEARCH_API_REF: "google-api-secret-value",
      GEMINI_API_KEY: "must-not-bypass-missing-header",
    });

    expect(snapshot.webTools.search.selectedProvider).toBeUndefined();
    expect(snapshot.degradedOwners).toEqual([
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "web-search:gemini",
        degradationState: "cold",
        paths: ['plugins.entries.google.config.webSearch.headers["X.Routing.Token"]'],
        refKeys: ["env:default:GOOGLE_ROUTING_REF", "env:default:GOOGLE_SEARCH_API_REF"],
        reason: "secret reference was not found",
      }),
    ]);
    expect(snapshot.warnings.map((warning) => warning.message).join("\n")).not.toContain(
      "GOOGLE_ROUTING_REF",
    );
    expect(
      snapshot.secretOwners?.filter((owner) => owner.ownerId === "web-search:gemini"),
    ).toHaveLength(1);
  });

  it("never restores or sends stale credentials to a changed inherited destination", async () => {
    const authenticatedRequests: string[] = [];
    const previousHost = createServer((_request, response) => response.end("previous"));
    const changedHost = createServer((request, response) => {
      if (request.headers["x-goog-api-key"] || request.headers["x-gateway-token"]) {
        authenticatedRequests.push(request.url ?? "");
      }
      response.end("changed");
    });
    const hosts = [previousHost, changedHost];
    await Promise.all(
      hosts.map(
        (host) =>
          new Promise<void>((resolve, reject) => {
            host.once("error", reject);
            host.listen(0, "127.0.0.1", resolve);
          }),
      ),
    );

    try {
      const urls = hosts.map((host) => {
        const address = host.address();
        if (!address || typeof address === "string") {
          throw new Error("security proof host did not bind");
        }
        return `http://127.0.0.1:${address.port}/v1beta`;
      });
      const headers = { "X-Gateway-Token": envRef("GOOGLE_ROUTING_REF") };
      const active = await prepare(
        createConfig({ provider: "gemini", googleBaseUrl: urls[0], headers }),
        {
          GOOGLE_SEARCH_API_REF: "previous-api-key",
          GOOGLE_ROUTING_REF: "previous-gateway-token",
        },
      );
      activateSecretsRuntimeSnapshotState({
        snapshot: active,
        refreshContext: null,
        refreshHandler: null,
      });

      const candidate = await prepare(
        createConfig({ provider: "gemini", googleBaseUrl: urls[1], headers }),
        { GOOGLE_SEARCH_API_REF: "candidate-api-key" },
      );
      expect(candidate.degradedOwners).toEqual([
        expect.objectContaining({ ownerId: "web-search:gemini", degradationState: "cold" }),
      ]);
      expect(candidate.webTools.search.selectedProvider).toBeUndefined();
      expect(readGoogleConfig(candidate.config).webSearch).toEqual({
        apiKey: "candidate-api-key",
        headers,
      });

      activateSecretsRuntimeSnapshotState({
        snapshot: candidate,
        refreshContext: null,
        refreshHandler: null,
      });
      const tool = createWebSearchTool({
        config: candidate.config,
        runtimeWebSearch: candidate.webTools.search,
      });
      await expect(
        tool?.execute("security-proof", { query: "blocked" }, undefined),
      ).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerId: "web-search:gemini",
      });
      expect(authenticatedRequests).toEqual([]);
    } finally {
      await Promise.all(
        hosts.map(
          (host) =>
            new Promise<void>((resolve) => {
              host.close(() => resolve());
            }),
        ),
      );
    }
  });

  it.each([
    {
      label: "normalized unchanged inherited destination",
      initial: { googleBaseUrl: "https://google.example.invalid/v1beta/" },
      candidate: { googleBaseUrl: "https://google.example.invalid/v1beta" },
      state: "stale",
    },
    {
      label: "unrelated provider destination change",
      initial: {
        googleBaseUrl: "https://google.example.invalid/v1beta",
        otherBaseUrl: "https://old.example.invalid/v1",
      },
      candidate: {
        googleBaseUrl: "https://google.example.invalid/v1beta",
        otherBaseUrl: "https://new.example.invalid/v1",
      },
      state: "stale",
    },
    {
      label: "changed plugin-owned destination",
      initial: { searchBaseUrl: "https://old.example.invalid/v1beta" },
      candidate: { searchBaseUrl: "https://new.example.invalid/v1beta" },
      state: "cold",
    },
    {
      label: "inherited destination shadowed by plugin override",
      initial: {
        googleBaseUrl: "https://old.example.invalid/v1beta",
        searchBaseUrl: "https://fixed.example.invalid/v1beta",
      },
      candidate: {
        googleBaseUrl: "https://changed.example.invalid/v1beta",
        searchBaseUrl: "https://fixed.example.invalid/v1beta",
      },
      state: "stale",
    },
  ] as const)("classifies $label as $state", async ({ initial, candidate, state }) => {
    const active = await prepare(createConfig({ provider: "gemini", ...initial }), {
      GOOGLE_SEARCH_API_REF: "original-google-api-key",
      GOOGLE_ROUTING_REF: "original-routing-header",
    });
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: null,
      refreshHandler: null,
    });

    const failed = await prepare(createConfig({ provider: "gemini", ...candidate }), {
      GOOGLE_SEARCH_API_REF: "rotated-google-api-key",
    });
    expect(failed.degradedOwners).toEqual([
      expect.objectContaining({ ownerId: "web-search:gemini", degradationState: state }),
    ]);
    expect(failed.webTools.search.selectedProvider).toBe(state === "stale" ? "gemini" : undefined);
  });

  it.each([
    { label: "unchanged owner", changed: false, state: "stale" },
    { label: "changed header ref", changed: true, state: "cold" },
    { label: "incomplete previous owner", changed: false, state: "cold" },
  ] as const)(
    "keeps $label $state when a header becomes unavailable",
    async ({ changed, label, state }) => {
      const config = createConfig({ provider: "gemini" });
      const active = await prepare(config, {
        GOOGLE_SEARCH_API_REF: "original-google-api-key",
        GOOGLE_ROUTING_REF: "original-routing-header",
      });
      if (label === "incomplete previous owner") {
        active.secretOwners![0]!.resolvedValues = active.secretOwners![0]!.resolvedValues?.filter(
          ({ refKey }) => refKey !== "env:default:GOOGLE_ROUTING_REF",
        );
      }
      activateSecretsRuntimeSnapshotState({
        snapshot: active,
        refreshContext: null,
        refreshHandler: null,
      });

      const candidate = changed
        ? createConfig({
            provider: "gemini",
            headers: { "X.Routing.Token": envRef("CHANGED_GOOGLE_ROUTING_REF") },
          })
        : config;
      const failed = await prepare(candidate, {
        GOOGLE_SEARCH_API_REF: "rotated-google-api-key",
      });

      expect(failed.degradedOwners).toEqual([
        expect.objectContaining({ ownerId: "web-search:gemini", degradationState: state }),
      ]);
      if (state === "stale") {
        expect(readGoogleConfig(failed.config).webSearch).toEqual({
          apiKey: "original-google-api-key",
          headers: { "X.Routing.Token": "original-routing-header" },
        });
        expect(failed.webTools.search.selectedProvider).toBe("gemini");
      } else if (!changed) {
        expect(readGoogleConfig(failed.config).webSearch.apiKey).toBe("rotated-google-api-key");
      }
    },
  );
});
