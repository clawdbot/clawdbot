import { describe, expect, it } from "vitest";
import {
  modelTransportRoutesMatch,
  resolveCatalogOwnedModelCompat,
  resolveUniqueCatalogModelRoute,
} from "./model-compat-catalog.js";

describe("catalog-owned model compat", () => {
  const catalogRoute = {
    api: "openai-responses",
    baseUrl: "https://api.example.test/v1/",
  };
  const catalogCompat = { supportsTools: true, supportsTemperature: false };

  it("uses catalog capabilities when config keeps the catalog route", () => {
    expect(
      resolveCatalogOwnedModelCompat({
        catalogRoute,
        catalogCompat,
        configuredRoute: {
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
        },
        configuredCompat: { supportsTools: false, supportsTemperature: true },
      }),
    ).toEqual(catalogCompat);
  });

  it("uses configured capabilities only when config selects a custom route", () => {
    const configuredCompat = { supportsTools: false };

    expect(
      resolveCatalogOwnedModelCompat({
        catalogRoute,
        catalogCompat,
        configuredRoute: { baseUrl: "http://127.0.0.1:9000/v1" },
        configuredCompat,
      }),
    ).toEqual(configuredCompat);
  });

  it("treats missing configured route fields and trailing slashes as the catalog route", () => {
    expect(modelTransportRoutesMatch(catalogRoute, {})).toBe(true);
    expect(modelTransportRoutesMatch(catalogRoute, { api: " ", baseUrl: "  " })).toBe(true);
    expect(
      modelTransportRoutesMatch(catalogRoute, {
        api: "OPENAI-RESPONSES",
        baseUrl: "https://api.example.test/v1",
      }),
    ).toBe(true);
  });

  it("requires one matching physical route before destructive cleanup", () => {
    const routeA = {
      api: "openai-responses",
      baseUrl: "https://route-a.example.test/v1",
    };
    const routeB = {
      api: "openai-completions",
      baseUrl: "https://route-b.example.test/v1",
    };

    expect(resolveUniqueCatalogModelRoute([routeA, routeB], {})).toBeUndefined();
    expect(resolveUniqueCatalogModelRoute([routeA, routeB], routeA)).toBe(routeA);
  });
});
