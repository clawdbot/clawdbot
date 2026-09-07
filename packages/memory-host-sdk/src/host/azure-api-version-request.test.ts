// Memory Host SDK tests cover Azure api-version request normalization.
import { describe, expect, it } from "vitest";
import { resolveAzureApiVersionRequestTarget } from "./azure-api-version-request.js";

describe("resolveAzureApiVersionRequestTarget", () => {
  const azureUrl = "https://example.openai.azure.com/openai/deployments/embed/embeddings";

  it("moves a non-empty api-version header into the URL query for Azure hosts", () => {
    const result = resolveAzureApiVersionRequestTarget({
      url: azureUrl,
      headers: { "api-key": "azure-key", "api-version": "2024-10-21" },
    });

    expect(result.url).toBe(`${azureUrl}?api-version=2024-10-21`);
    expect(result.headers).toEqual({ "api-key": "azure-key" });
  });

  it("recognizes a mixed-case api-version header and preserves other header casing", () => {
    const result = resolveAzureApiVersionRequestTarget({
      url: azureUrl,
      headers: { "API-Version": "2023-05-15", "X-Tenant": "acme" },
    });

    expect(result.url).toBe(`${azureUrl}?api-version=2023-05-15`);
    expect(result.headers).toEqual({ "X-Tenant": "acme" });
  });

  it.each([
    "https://example.openai.azure.com/openai/deployments/embed/embeddings",
    "https://example.services.ai.azure.com/openai/deployments/embed/embeddings",
    "https://example.cognitiveservices.azure.com/openai/deployments/embed/embeddings",
    "https://sub.example.openai.azure.com/openai/deployments/embed/embeddings",
  ])("moves api-version for every Azure host suffix: %s", (url) => {
    const result = resolveAzureApiVersionRequestTarget({
      url,
      headers: { "api-version": "2024-10-21" },
    });

    expect(result.url).toBe(`${url}?api-version=2024-10-21`);
    expect(result.headers).not.toHaveProperty("api-version");
  });

  it("keeps an existing non-empty URL api-version and removes the header", () => {
    const result = resolveAzureApiVersionRequestTarget({
      url: `${azureUrl}?existing=1&api-version=2024-02-01`,
      headers: { "api-version": "2024-10-21" },
    });

    expect(result.url).toBe(`${azureUrl}?existing=1&api-version=2024-02-01`);
    expect(result.headers).not.toHaveProperty("api-version");
  });

  it("fills an empty URL api-version value from the header", () => {
    const result = resolveAzureApiVersionRequestTarget({
      url: `${azureUrl}?api-version=`,
      headers: { "api-version": "2024-10-21" },
    });

    expect(result.url).toBe(`${azureUrl}?api-version=2024-10-21`);
    expect(result.headers).not.toHaveProperty("api-version");
  });

  it("drops a blank api-version header without adding an empty query value", () => {
    const result = resolveAzureApiVersionRequestTarget({
      url: azureUrl,
      headers: { "api-version": "   " },
    });

    expect(result.url).toBe(azureUrl);
    expect(result.headers).not.toHaveProperty("api-version");
  });

  it.each([
    "https://api.openai.com/v1/embeddings",
    "https://proxy.example.com/v1/embeddings?tenant=acme",
    "https://localhost/v1/embeddings",
    "https://127.0.0.1/v1/embeddings",
    "https://azure.com/v1/embeddings",
    "https://openai.azure.com.evil.example/v1/embeddings",
  ])("leaves non-Azure host %s and its headers untouched", (url) => {
    const headers = { "api-version": "proxy-header", "X-Tenant": "acme" };
    const result = resolveAzureApiVersionRequestTarget({ url, headers });

    expect(result.url).toBe(url);
    expect(result.headers).toBe(headers);
  });

  it("leaves Azure requests without an api-version header untouched", () => {
    const headers = { "api-key": "azure-key", "X-Tenant": "acme" };
    const result = resolveAzureApiVersionRequestTarget({
      url: azureUrl,
      headers,
    });

    expect(result.url).toBe(azureUrl);
    expect(result.headers).toBe(headers);
  });

  it("does not mutate the caller headers object on migration", () => {
    const headers = { "api-key": "azure-key", "api-version": "2024-10-21" };
    resolveAzureApiVersionRequestTarget({ url: azureUrl, headers });

    expect(headers).toEqual({ "api-key": "azure-key", "api-version": "2024-10-21" });
  });
});
