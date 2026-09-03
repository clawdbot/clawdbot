import { describe, expect, it, vi } from "vitest";
import { resolveManagedSetupCatalogIconUrl } from "./management-service.js";

vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: () => [],
}));

vi.mock("./recommended-tool-installs.js", () => ({
  listRecommendedToolInstalls: () => [],
}));

describe("managed ClawHub skill icon URLs", () => {
  const digest = "a".repeat(64);
  const clawHub = "https://clawhub.ai";
  const registry = "https://registry.example.test";
  const pathRegistry = `${registry}/clawhub`;
  const credentialRegistry = new URL(clawHub);
  credentialRegistry.username = "user";
  const icon = (base: string, value = digest) => `${base}/api/v1/skill-icons/${value}`;
  const env = (base: string): NodeJS.ProcessEnv => ({ OPENCLAW_CLAWHUB_URL: base });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    ["the default registry", {}, icon(clawHub)],
    ["a configured registry", env(registry), icon(registry)],
    ["a path-mounted registry", env(`${pathRegistry}/`), icon(pathRegistry)],
    ["the fallback registry setting", { CLAWHUB_URL: registry }, icon(registry)],
  ])("allows skill icons from %s", (_label, registryEnv, iconUrl) => {
    expect(resolveManagedSetupCatalogIconUrl({ config: {}, env: registryEnv, iconUrl })).toBe(
      iconUrl,
    );
  });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    ["outside the configured path", env(pathRegistry), icon(registry)],
    ["on another origin", env(registry), icon("https://attacker.example.test")],
    ["with a query", {}, `${icon(clawHub)}?redirect=1`],
    ["with a fragment", {}, `${icon(clawHub)}#redirect`],
    ["with uppercase digest", {}, icon(clawHub, digest.toUpperCase())],
    ["with short digest", {}, icon(clawHub, "a".repeat(63))],
    ["on a non-icon path", {}, `${clawHub}/api/v1/packages/${digest}`],
    ["when registry has credentials", env(credentialRegistry.href), icon(clawHub)],
    ["when icon has credentials", {}, icon(credentialRegistry.href)],
    [
      "when registry is insecure",
      env("http://registry.example.test"),
      icon("http://registry.example.test"),
    ],
  ])("rejects skill icons %s", (_label, registryEnv, iconUrl) => {
    expect(
      resolveManagedSetupCatalogIconUrl({ config: {}, env: registryEnv, iconUrl }),
    ).toBeUndefined();
  });
});
