import { describe, expect, it } from "vitest";
import { clawHubPackageUrl } from "./catalog-links.ts";

describe("clawHubPackageUrl", () => {
  it("derives the publisher route from a scoped package when author metadata is absent", () => {
    expect(clawHubPackageUrl("@openclaw/matrix", undefined)).toBe(
      "https://clawhub.ai/openclaw/plugins/matrix",
    );
  });

  it("preserves the package-only route for unscoped packages without author metadata", () => {
    expect(clawHubPackageUrl("matrix", undefined)).toBe("https://clawhub.ai/plugins/matrix");
  });
});
