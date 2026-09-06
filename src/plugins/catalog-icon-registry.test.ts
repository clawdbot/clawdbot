import { describe, expect, it } from "vitest";
import {
  registerClawHubCatalogIconUrls,
  resolveClawHubCatalogIconUrl,
} from "./catalog-icon-registry.js";

describe("ClawHub catalog icon registry", () => {
  it("only resolves exact HTTPS URLs learned from catalog responses", () => {
    registerClawHubCatalogIconUrls([
      "https://cdn.example.com/icon.svg",
      "http://cdn.example.com/insecure.svg",
    ]);

    expect(resolveClawHubCatalogIconUrl("https://cdn.example.com/icon.svg")).toBe(
      "https://cdn.example.com/icon.svg",
    );
    expect(resolveClawHubCatalogIconUrl("https://cdn.example.com/other.svg")).toBeUndefined();
    expect(resolveClawHubCatalogIconUrl("http://cdn.example.com/insecure.svg")).toBeUndefined();
  });
});
