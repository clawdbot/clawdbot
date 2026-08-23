import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import {
  findModelCatalogRouteDonor,
  type ModelCatalogRoutePolicy,
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const matchesRoute = (entry: ModelCatalogEntry, route: ProviderModelRouteCandidate) =>
  entry.api === route.api && entry.baseUrl === route.baseUrl;
const routePolicy: ModelCatalogRoutePolicy = {
  resolveIdentity: (entry) => ({ id: entry.id, key: `${entry.provider}/${entry.id}` }),
  matchesRoute,
};

const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const satisfies ProviderModelRouteCandidate;

const chatGPTRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const satisfies ProviderModelRouteCandidate;

const platformEntry: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 1_000_000,
  contextTokens: 272_000,
  reasoning: true,
  input: ["text", "image"],
  params: { platformOnly: true },
  compat: { supportsTools: false },
};

const chatGPTEntry: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  contextWindow: 400_000,
  contextTokens: 300_000,
  reasoning: true,
  input: ["text"],
  params: { chatGPTOnly: true },
  compat: { supportsTools: true },
};

describe("projectModelCatalogEntryForRoute", () => {
  it("finds the exact selected-route donor regardless of catalog order", () => {
    expect(
      findModelCatalogRouteDonor({
        entry: platformEntry,
        route: chatGPTRoute,
        policy: routePolicy,
        catalog: [platformEntry, chatGPTEntry],
      }),
    ).toBe(chatGPTEntry);
  });

  it("prefers the physical route donor over a matching merged logical row", () => {
    const logicalEntry: ModelCatalogEntry = {
      ...chatGPTEntry,
      compat: { supportsTools: false },
      params: { logicalOnly: true },
    };

    expect(
      findModelCatalogRouteDonor({
        entry: logicalEntry,
        route: chatGPTRoute,
        policy: routePolicy,
        catalog: [platformEntry, chatGPTEntry],
      }),
    ).toBe(chatGPTEntry);
  });

  it("projects one physical row onto the selected route capabilities", () => {
    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: platformRoute, policy: routePolicy },
        catalog: [platformEntry, chatGPTEntry],
      }),
    ).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      reasoning: true,
      input: ["text", "image"],
    });

    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
        catalog: [platformEntry, chatGPTEntry],
      }),
    ).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 400_000,
      contextTokens: 300_000,
      reasoning: true,
      input: ["text"],
    });
  });

  it("omits sibling-route capabilities when no selected-route row exists", () => {
    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
        catalog: [platformEntry],
      }),
    ).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("returns the physical row unchanged for unmanaged models", () => {
    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "unmanaged" },
      }),
    ).toBe(platformEntry);
  });

  it("removes physical route facts while managed selection is unresolved", () => {
    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "unresolved", policy: routePolicy },
      }),
    ).toEqual({ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" });
  });

  it("does not copy private route policy facts into the catalog row", () => {
    const projected = projectModelCatalogEntryForRoute({
      entry: platformEntry,
      projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
      catalog: [chatGPTEntry],
    });
    expect(projected).not.toHaveProperty("authRequirement");
    expect(projected).not.toHaveProperty("requestTransportOverrides");
    expect(projected).not.toHaveProperty("params");
    expect(projected).not.toHaveProperty("compat");
  });

  it("applies explicit logical context overrides after physical route selection", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5.5", contextTokens: 160_000 }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const overrides = resolveConfiguredModelCatalogOverrides({ cfg, entry: platformEntry });

    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
        catalog: [platformEntry],
        ...(overrides ? { overrides } : {}),
      }),
    ).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextTokens: 160_000,
    });
  });

  it("merges logical overrides from canonical duplicate model rows", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [
              { id: "openai/gpt-5.5", name: "Configured GPT-5.5" },
              { id: "gpt-5.5", name: "Ignored duplicate name", contextTokens: 160_000 },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const canonicalPolicy: ModelCatalogRoutePolicy = {
      ...routePolicy,
      resolveIdentity: (entry) => {
        const id = entry.id.replace(/^openai\//u, "");
        return { id, key: `${entry.provider}/${id}` };
      },
    };

    expect(
      resolveConfiguredModelCatalogOverrides({
        cfg,
        entry: platformEntry,
        policy: canonicalPolicy,
      }),
    ).toEqual({ name: "Configured GPT-5.5", contextTokens: 160_000 });
  });

  it("preserves literal provider-scoped model ids", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [{ id: "openai/acme-model", name: "Configured Acme" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const literalEntry = { ...platformEntry, id: "openai/acme-model" };

    expect(
      resolveConfiguredModelCatalogOverrides({
        cfg,
        entry: literalEntry,
        policy: routePolicy,
      }),
    ).toEqual({ name: "Configured Acme" });
  });
});
