// Verifies package transports consume the route generation prepared on the model.
import { getAiTransportHost } from "@openclaw/ai";
import { describe, expect, it } from "vitest";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import "./ai-transport-runtime-host.js";
import {
  attachModelProviderRequestRouteFacts,
  getModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

function buildOwners(): PluginMetadataSnapshotOwnerMaps {
  const empty = new Map<string, readonly string[]>();
  return {
    channels: empty,
    channelConfigs: empty,
    providers: empty,
    modelCatalogProviders: empty,
    cliBackends: empty,
    setupProviders: empty,
    commandAliases: empty,
    contracts: empty,
    providerEndpoints: [
      { endpointClass: "openai-public", hosts: ["prepared.example"] },
      { endpointClass: "anthropic-public", hosts: ["projected.example"] },
    ],
    providerRequests: new Map([["openai", { family: "prepared-openai-family" }]]),
  };
}

describe("AI transport prepared provider routes", () => {
  it("keeps headers, capabilities, and SSRF posture on the prepared metadata generation", () => {
    const model = attachModelProviderRequestRouteFacts(
      makeProviderModelFixture<"openai-responses">({
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://prepared.example/v1",
      }),
      buildOwners(),
    );
    const host = getAiTransportHost();
    const headers = host.resolveProviderRequestHeaders({
      model,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
    });
    const capabilities = host.resolveProviderRequestCapabilities({
      model,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      capability: "llm",
      transport: "stream",
    });
    const requestPolicy = resolveProviderRequestPolicyConfig({
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      routeFacts: getModelProviderRequestRouteFacts(model),
      capability: "llm",
      transport: "stream",
    });

    expect(headers).toMatchObject({ originator: "openclaw" });
    expect(capabilities).toMatchObject({
      endpointClass: "openai-public",
      knownProviderFamily: "prepared-openai-family",
    });
    expect(requestPolicy.trustConfiguredBaseUrlOrigin).toBe(false);
  });

  it("re-resolves projected transport routes against the same metadata generation", () => {
    const owners = buildOwners();
    const source = attachModelProviderRequestRouteFacts(
      makeProviderModelFixture<"openai-responses">({
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://prepared.example/v1",
      }),
      owners,
    );
    const projected = getAiTransportHost().inheritManagedTransport(source, {
      ...source,
      baseUrl: "https://projected.example/v1",
    });
    const routeFacts = getModelProviderRequestRouteFacts(projected);

    expect(routeFacts?.providerMetadataOwners).toBe(owners);
    expect(routeFacts?.capabilities.endpointClass).toBe("anthropic-public");
    expect(routeFacts?.providerOwner).toBe("anthropic-public");
  });
});
